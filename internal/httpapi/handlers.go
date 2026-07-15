package httpapi

import (
	"math"
	"net/http"
	"time"

	"kickapi/internal/breaker"
	"kickapi/internal/buildinfo"
	"kickapi/internal/cache"
	"kickapi/internal/obs"
)

// handleIndex serves the pre-rendered index.html (Jinja output reproduced at
// startup — see render.go). The HTML references content-hashed (immutable)
// asset URLs, so it must always revalidate: no-cache guarantees a deploy is
// picked up on the next load instead of a stale page pinning old ?h= hashes.
func (a *App) handleIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write([]byte(a.indexHTML))
}

// handleDocs serves the embedded, self-contained API reference page.
func (a *App) handleDocs(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write([]byte(a.docsHTML))
}

// handleLanguages returns the configured languages and the default code.
func (a *App) handleLanguages(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"languages":        a.cfg.FeaturedLanguages,
		"default_language": a.cfg.DefaultLanguageCode,
	})
}

// handleLiveness is the minimal liveness probe.
func (a *App) handleLiveness(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

// handleReadiness confirms that configuration, embedded assets, dependencies,
// and the router were initialized. It deliberately does not depend on Kick.com:
// an upstream outage must not make systemd restart a healthy local process.
func (a *App) handleReadiness(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ready",
		"version": buildinfo.Snapshot(),
	})
}

func (a *App) handleVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, buildinfo.Snapshot())
}

// uptimeSeconds returns whole seconds since start (matches round(monotonic-start)).
func (a *App) uptimeSeconds() int {
	return int(math.Round(time.Since(a.startTime).Seconds()))
}

// handleHealth returns per-component status, 200 unless a component is
// unhealthy (then 503). Ports api/health.py.
func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	cacheStatus := checkCache(a.cache.Stats())
	criticalStatus := checkBreaker(a.cbCritical)
	nonCriticalStatus := checkBreaker(a.cbNonCritical)

	overall := "healthy"
	for _, comp := range []map[string]any{cacheStatus, criticalStatus, nonCriticalStatus} {
		switch comp["status"] {
		case "unhealthy":
			overall = "unhealthy"
		case "degraded":
			if overall != "unhealthy" {
				overall = "degraded"
			}
		}
		if overall == "unhealthy" {
			break
		}
	}

	status := http.StatusOK
	if overall == "unhealthy" {
		status = http.StatusServiceUnavailable
	}

	writeJSON(w, status, map[string]any{
		"status":         overall,
		"uptime_seconds": a.uptimeSeconds(),
		"version":        buildinfo.Snapshot(),
		"components": map[string]any{
			"cache": cacheStatus,
			// Backwards-compatible legacy field.
			"circuit_breaker": criticalStatus,
			"circuit_breakers": map[string]any{
				"critical":     criticalStatus,
				"non_critical": nonCriticalStatus,
			},
		},
	})
}

func checkCache(stats cache.Stats) map[string]any {
	utilization := float64(stats.Size) / float64(max(stats.MaxSize, 1))
	status := "healthy"
	if utilization >= 0.95 {
		status = "degraded"
	}
	return map[string]any{
		"status":          status,
		"size":            stats.Size,
		"max_size":        stats.MaxSize,
		"utilization_pct": math.Round(utilization*1000) / 10,
	}
}

func checkBreaker(b *breaker.Breaker) map[string]any {
	state := b.State()
	status := "unhealthy"
	switch state {
	case breaker.StateClosed:
		status = "healthy"
	case breaker.StateHalfOpen:
		status = "degraded"
	}
	return map[string]any{"status": status, "state": state}
}

// inflightStats returns the in-flight dedup tracker snapshot for /metrics.
func (a *App) inflightStats() map[string]any {
	active, timeouts := a.inflight.Stats()
	return map[string]any{"active_keys": active, "timeout_count": timeouts}
}

// handleMetrics returns cache, upstream, circuit-breaker, and inflight metrics.
// Ports api/metrics.py.
func (a *App) handleMetrics(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"cache": a.cache.Stats(),
		"upstream": map[string]any{
			"call_count": obs.UpstreamCalls(),
			// Backwards-compatible legacy field.
			"circuit_breaker": a.cbCritical.Stats(),
			"circuit_breakers": map[string]any{
				"critical":     a.cbCritical.Stats(),
				"non_critical": a.cbNonCritical.Stats(),
			},
			"circuit_breaker_events": obs.LaneEventsSnapshot(),
		},
		"inflight":       a.inflightStats(),
		"uptime_seconds": a.uptimeSeconds(),
	})
}
