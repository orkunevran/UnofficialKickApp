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

	// shutdownCh is closed by BeginShutdown to signal long-lived handlers (the
	// SSE status stream) to return, so http.Server.Shutdown can drain promptly.
	shutdownCh   chan struct{}
	shutdownOnce sync.Once

	staticFS  fs.FS
	indexHTML string
	docsHTML  string
	startTime time.Time
}

// New constructs the App: builds the cache and circuit breakers, derives the
// static sub-filesystem, computes asset hashes, and pre-renders index.html.
func New(cfg *config.Config, log *slog.Logger, assets fs.FS) (*App, error) {
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
		StatePath:            ".kick_chromecast_cache.json",
		PeriodicScanInterval: time.Duration(cfg.ChromecastPeriodicScanInterval) * time.Second,
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
		shutdownCh:     make(chan struct{}),
		staticFS:       staticFS,
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
	mux.HandleFunc("GET /metrics", a.handleMetrics)

	// Stream / discovery endpoints (read-only; SWR + inflight dedup land in Phase 2).
	mux.HandleFunc("GET /streams/play/{slug}", a.handlePlayStream)
	mux.HandleFunc("GET /streams/go/{slug}", a.handleGoToLive)
	mux.HandleFunc("GET /streams/m3u8/{file}", a.handlePlayM3U8)
	mux.HandleFunc("GET /streams/avatar/{slug}", a.handleAvatar)
	mux.HandleFunc("GET /streams/clips/{slug}", a.handleClips)
	mux.HandleFunc("GET /streams/vods/{slug}", a.handleVODs)
	mux.HandleFunc("GET /streams/vods/{slug}/{vodID}", a.handlePlayVOD)
	mux.HandleFunc("GET /streams/featured-livestreams", a.handleFeatured)
	mux.HandleFunc("GET /streams/search", a.handleSearch)
	mux.HandleFunc("GET /streams/viewers", a.handleViewers)
	mux.HandleFunc("GET /streams/viewers/batch", a.handleViewersBatch)

	// Chromecast control endpoints.
	mux.HandleFunc("GET /api/chromecast/devices", a.handleCCDevices)
	mux.HandleFunc("POST /api/chromecast/select", a.handleCCSelect)
	mux.HandleFunc("POST /api/chromecast/cast", a.handleCCCast)
	mux.HandleFunc("POST /api/chromecast/stop", a.handleCCStop)
	mux.HandleFunc("GET /api/chromecast/last-device", a.handleCCLastDevice)
	mux.HandleFunc("GET /api/chromecast/status", a.handleCCStatus)
	mux.HandleFunc("GET /api/chromecast/status/stream", a.handleCCStatusStream)
	mux.HandleFunc("POST /api/chromecast/pause", a.handleCCPause)
	mux.HandleFunc("POST /api/chromecast/play", a.handleCCPlay)
	mux.HandleFunc("POST /api/chromecast/volume", a.handleCCVolume)
	mux.HandleFunc("POST /api/chromecast/seek", a.handleCCSeek)

	mux.Handle("GET /static/", a.cacheControl(http.StripPrefix("/static/", http.FileServerFS(a.staticFS))))

	var handler http.Handler = mux
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

// cacheControl sets long-lived caching for hash-busted assets and a modest TTL
// otherwise, mirroring _ImmutableStaticFiles.
func (a *App) cacheControl(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.RawQuery, "h=") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=300")
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
