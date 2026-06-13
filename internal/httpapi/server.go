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
	"time"

	"kickapi/internal/breaker"
	"kickapi/internal/cache"
	"kickapi/internal/config"
	"kickapi/internal/kick"
)

// App holds the server dependencies and rendered assets.
type App struct {
	cfg           *config.Config
	log           *slog.Logger
	cache         *cache.Cache
	cbCritical    *breaker.Breaker
	cbNonCritical *breaker.Breaker
	kick          kickClient

	staticFS  fs.FS
	indexHTML string
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

	kickClient, err := kick.New(kick.Config{
		BaseURL:           cfg.KickAPIBaseURL,
		FeaturedURL:       cfg.KickFeaturedLivestreamsURL,
		AllLivestreamsURL: cfg.KickAllLivestreamsURL,
	})
	if err != nil {
		return nil, err
	}

	return &App{
		cfg:           cfg,
		log:           log,
		cache:         cache.New(cfg.CacheMaxSize, time.Duration(cfg.CacheDefaultTimeout)*time.Second),
		cbCritical:    breaker.New(cfg.CircuitBreakerCriticalFailureThreshold, time.Duration(cfg.CircuitBreakerRecoverySeconds)*time.Second),
		cbNonCritical: breaker.New(cfg.CircuitBreakerFailureThreshold, time.Duration(cfg.CircuitBreakerRecoverySeconds)*time.Second),
		kick:          kickClient,
		staticFS:      staticFS,
		indexHTML:     renderIndex(string(tmpl), hashes),
		startTime:     time.Now(),
	}, nil
}

// Cache exposes the cache (used by later phases / tests).
func (a *App) Cache() *cache.Cache { return a.cache }

// Handler returns the fully wired HTTP handler (routes + middleware).
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()

	// "/{$}" matches only the root path, so unknown paths 404 (matching the
	// Python app's exact "/" route rather than a catch-all subtree).
	mux.HandleFunc("GET /{$}", a.handleIndex)
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

	mux.Handle("GET /static/", a.cacheControl(http.StripPrefix("/static/", http.FileServerFS(a.staticFS))))

	var handler http.Handler = mux
	if a.cfg.CORSOrigins != "" {
		handler = a.cors(handler)
	}
	return a.requestContext(handler)
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
