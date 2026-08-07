// Package httpapi wires the HTTP routes, middleware, and static/asset serving
// for the Go port. Phase 0 covers the framework-independent endpoints (index,
// languages, health, liveness, metrics) and static serving; the Kick and
// Chromecast routes arrive in later phases.
package httpapi

import (
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"context"

	"github.com/klauspost/compress/gzhttp"
	"kickapi/internal/breaker"
	"kickapi/internal/cache"
	"kickapi/internal/chromecast"
	"kickapi/internal/config"
	"kickapi/internal/inflight"
	"kickapi/internal/kick"
)

// inflightStaleAge matches InflightTracker._STALE_SECONDS — markers older than
// this are abandoned fetches and are swept.
const inflightStaleAge = 30 * time.Second

// App holds the server dependencies and rendered assets.
type App struct {
	cfg            *config.Config
	log            *slog.Logger
	cache          *cache.Cache
	cbCritical     *breaker.Breaker
	cbNonCritical  *breaker.Breaker
	kick           kickClient
	chromecast     chromecastService
	chromecastSvc  *chromecast.Service // concrete type for lifecycle methods
	inflight       *inflight.Tracker
	refreshLimiter *limiter
	rateLimiter    *ipRateLimiter

	// shutdownCh is closed by BeginShutdown to signal long-lived handlers (the
	// SSE status stream) to return, so http.Server.Shutdown can drain promptly.
	shutdownCh   chan struct{}
	shutdownOnce sync.Once

	// dvrKeepers tracks which recordings have a background refresher running, so
	// a watched broadcast keeps exactly one (see startDVRKeeper).
	dvrKeepersMu sync.Mutex
	dvrKeepers   map[string]struct{}

	staticFS     fs.FS
	staticHashes map[string]string // relative path → content MD5, for ETag revalidation
	indexHTML    string
	docsHTML     string
	startTime    time.Time
}

// New constructs the App: builds the cache and circuit breakers, derives the
// static sub-filesystem, computes asset hashes, and pre-renders index.html.
func New(cfg *config.Config, log *slog.Logger, assets fs.FS) (*App, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	staticFS, err := fs.Sub(assets, "static")
	if err != nil {
		return nil, err
	}
	hashes, err := computeStaticHashes(staticFS)
	if err != nil {
		return nil, err
	}
	tmpl, err := fs.ReadFile(assets, "templates/index.html")
	if err != nil {
		return nil, err
	}
	docs, err := fs.ReadFile(assets, "templates/docs.html")
	if err != nil {
		return nil, err
	}

	kickClient, err := kick.New(kick.Config{
		BaseURL:           cfg.KickAPIBaseURL,
		FeaturedURL:       cfg.KickFeaturedLivestreamsURL,
		AllLivestreamsURL: cfg.KickAllLivestreamsURL,
		ChatHistoryURL:    cfg.KickChatHistoryURL,
		MaxResponseBytes:  int64(cfg.KickMaxResponseBytes),
		MaxPlaylistBytes:  int64(cfg.KickMaxPlaylistBytes),
	})
	if err != nil {
		return nil, err
	}

	cc := chromecast.New(chromecast.Config{
		ScanTimeout:          time.Duration(cfg.ChromecastScanTimeout) * time.Second,
		SelectMaxRetries:     cfg.ChromecastSelectMaxRetries,
		SelectRetryDelay:     time.Duration(cfg.ChromecastSelectRetryDelay) * time.Second,
		DeviceCacheTTL:       time.Duration(cfg.ChromecastDeviceCacheSeconds) * time.Second,
		FallbackScanEnabled:  cfg.ChromecastFallbackScanEnabled,
		FallbackScanSubnets:  cfg.ChromecastFallbackScanSubnets,
		FallbackScanWorkers:  cfg.ChromecastFallbackScanWorkers,
		FallbackProbeTimeout: time.Duration(cfg.ChromecastFallbackScanProbeTimeout * float64(time.Second)),
		FallbackInfoTimeout:  time.Duration(cfg.ChromecastFallbackDeviceInfoTimeout * float64(time.Second)),
		StatePath:            cfg.ChromecastStatePath,
		PeriodicScanInterval: time.Duration(cfg.ChromecastPeriodicScanInterval) * time.Second,
		StatusUpdateTimeout:  time.Duration(cfg.ChromecastStatusUpdateTimeout * float64(time.Second)),
		ConnectCooldown:      time.Duration(cfg.ChromecastConnectCooldown * float64(time.Second)),
	}, log)

	return &App{
		cfg:            cfg,
		log:            log,
		cache:          cache.New(cfg.CacheMaxSize),
		cbCritical:     breaker.New(cfg.CircuitBreakerCriticalFailureThreshold, time.Duration(cfg.CircuitBreakerRecoverySeconds)*time.Second),
		cbNonCritical:  breaker.New(cfg.CircuitBreakerFailureThreshold, time.Duration(cfg.CircuitBreakerRecoverySeconds)*time.Second),
		kick:           kickClient,
		chromecast:     cc,
		chromecastSvc:  cc,
		inflight:       inflight.New(),
		refreshLimiter: newLimiter(cfg.BackgroundRefreshMaxConcurrency),
		rateLimiter:    newIPRateLimiter(cfg.RateLimitRequestsPerSecond, cfg.RateLimitBurst),
		shutdownCh:     make(chan struct{}),
		dvrKeepers:     make(map[string]struct{}),
		staticFS:       staticFS,
		staticHashes:   hashes,
		indexHTML:      renderIndex(string(tmpl), hashes),
		docsHTML:       string(docs),
		startTime:      time.Now(),
	}, nil
}

// RunSweeper periodically removes abandoned in-flight markers, mirroring the
// Python _periodic_inflight_sweep background task. It returns when ctx is done.
func (a *App) RunSweeper(ctx context.Context) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if n := a.inflight.SweepStale(inflightStaleAge); n > 0 {
				a.log.Info("swept stale in-flight entries", "count", n)
			}
		}
	}
}

// RunChromecastTasks starts the three Chromecast background goroutines:
// status polling (shared across all SSE connections), periodic device
// re-scanning, and one-shot auto-reconnect to the last known device.
func (a *App) RunChromecastTasks(ctx context.Context) {
	go a.chromecastSvc.RunStatusPoller(ctx)
	go a.chromecastSvc.RunPeriodicScan(ctx)
	go a.chromecastSvc.AutoReconnect(ctx)
}

// BeginShutdown signals long-lived handlers (the SSE status stream) to return
// so http.Server.Shutdown can drain promptly instead of blocking until its
// timeout. Without this, an open browser EventSource keeps a handler alive and
// Shutdown exceeds its deadline (observed: "fatal: graceful shutdown: context
// deadline exceeded" on every restart with the frontend connected). Idempotent.
func (a *App) BeginShutdown() {
	a.shutdownOnce.Do(func() { close(a.shutdownCh) })
}

// Handler returns the fully wired HTTP handler (routes + middleware).
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()

	// "/{$}" matches only the root path, so unknown paths 404 (matching the
	// Python app's exact "/" route rather than a catch-all subtree).
	mux.HandleFunc("GET /{$}", a.handleIndex)
	mux.HandleFunc("GET /docs", a.handleDocs)
	mux.HandleFunc("GET /config/languages", a.handleLanguages)
	mux.HandleFunc("GET /health", a.handleHealth)
	mux.HandleFunc("GET /health/live", a.handleLiveness)
	mux.HandleFunc("GET /health/ready", a.handleReadiness)
	mux.HandleFunc("GET /version", a.handleVersion)
	mux.HandleFunc("GET /metrics", a.handleMetrics)

	// Stream / discovery endpoints (read-only; SWR + inflight dedup land in Phase 2).
	mux.HandleFunc("GET /streams/play/{slug}", a.handlePlayStream)
	mux.HandleFunc("GET /streams/go/{slug}", a.handleGoToLive)
	mux.HandleFunc("GET /streams/m3u8/{file}", a.handlePlayM3U8)
	// Live rewind (DVR): info + the proxied in-progress recording playlists.
	mux.HandleFunc("GET /streams/dvr/{slug}", a.handleDVRInfo)
	mux.HandleFunc("GET /streams/dvr/{slug}/master.m3u8", a.handleDVRMaster)
	mux.HandleFunc("GET /streams/dvr/{slug}/{variant}/playlist.m3u8", a.handleDVRMedia)
	// Chat replay: the messages that were on screen at a given instant.
	mux.HandleFunc("GET /streams/chat/{slug}/history", a.handleChatHistory)
	mux.HandleFunc("GET /streams/avatar/{slug}", a.handleAvatar)
	mux.HandleFunc("GET /streams/clips/{slug}", a.handleClips)
	mux.HandleFunc("GET /streams/clip/{slug}/{clipID}", a.handlePlayClip)
	mux.HandleFunc("GET /streams/vods/{slug}", a.handleVODs)
	mux.HandleFunc("GET /streams/vods/{slug}/{vodID}", a.handlePlayVOD)
	mux.HandleFunc("GET /streams/featured-livestreams", a.handleFeatured)
	mux.HandleFunc("GET /streams/search", a.handleSearch)
	mux.HandleFunc("GET /streams/viewers", a.handleViewers)
	mux.HandleFunc("GET /streams/viewers/batch", a.handleViewersBatch)

	// Chromecast control endpoints.
	mux.HandleFunc("POST /api/control/session", a.handleControlSession)
	mux.Handle("GET /api/chromecast/devices", a.requireControl(http.HandlerFunc(a.handleCCDevices)))
	mux.Handle("POST /api/chromecast/select", a.requireControl(http.HandlerFunc(a.handleCCSelect)))
	mux.Handle("POST /api/chromecast/cast", a.requireControl(http.HandlerFunc(a.handleCCCast)))
	mux.Handle("POST /api/chromecast/stop", a.requireControl(http.HandlerFunc(a.handleCCStop)))
	mux.HandleFunc("GET /api/chromecast/last-device", a.handleCCLastDevice)
	mux.HandleFunc("GET /api/chromecast/status", a.handleCCStatus)
	mux.HandleFunc("GET /api/chromecast/status/stream", a.handleCCStatusStream)
	mux.Handle("POST /api/chromecast/pause", a.requireControl(http.HandlerFunc(a.handleCCPause)))
	mux.Handle("POST /api/chromecast/play", a.requireControl(http.HandlerFunc(a.handleCCPlay)))
	mux.Handle("POST /api/chromecast/volume", a.requireControl(http.HandlerFunc(a.handleCCVolume)))
	mux.Handle("POST /api/chromecast/seek", a.requireControl(http.HandlerFunc(a.handleCCSeek)))

	mux.Handle("GET /static/", a.cacheControl(http.StripPrefix("/static/", http.FileServerFS(a.staticFS))))

	var handler http.Handler = mux
	handler = a.rateLimit(handler)
	if a.cfg.CORSOrigins != "" {
		handler = a.cors(handler)
	}
	handler = a.requestContext(handler)
	// Gzip responses ≥1 KB, matching GZipMiddleware(minimum_size=1024,
	// compresslevel=5) from the Python app. gzhttp preserves http.Flusher so
	// the SSE status stream continues to work correctly.
	if wrap, err := gzhttp.NewWrapper(gzhttp.MinSize(1024), gzhttp.CompressionLevel(5)); err == nil {
		handler = wrap(handler)
	}
	return handler
}

// cacheControl sets caching for static assets:
//   - ?h=<hash> URLs (style.css, script.js) are content-addressed → immutable.
//   - ES modules and other hashed files are loaded by plain path (no ?h=), so
//     they get an ETag (the precomputed content MD5) + no-cache: the browser
//     revalidates each load and gets a cheap 304 when unchanged, but picks up a
//     deploy immediately instead of serving a stale copy for the cache TTL.
//     http.ServeContent reads this ETag to answer If-None-Match automatically.
//   - Anything else (images, fonts not in the hash map) keeps a modest TTL.
func (a *App) cacheControl(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.RawQuery, "h="):
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		default:
			if h, ok := a.staticHashes[strings.TrimPrefix(r.URL.Path, "/static/")]; ok {
				w.Header().Set("ETag", `"`+h+`"`)
				w.Header().Set("Cache-Control", "no-cache")
			} else {
				w.Header().Set("Cache-Control", "public, max-age=300")
			}
		}
		next.ServeHTTP(w, r)
	})
}

// cors applies a minimal CORS policy when CORS_ORIGINS is configured.
func (a *App) cors(next http.Handler) http.Handler {
	origins := map[string]bool{}
	for _, o := range strings.Split(a.cfg.CORSOrigins, ",") {
		if o = strings.TrimSpace(o); o != "" {
			origins[o] = true
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && origins[origin] {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Methods", "GET, POST")
			h.Set("Access-Control-Allow-Headers", "*")
			if a.cfg.CORSAllowCredentials {
				h.Set("Access-Control-Allow-Credentials", "true")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
