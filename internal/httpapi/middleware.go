package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// securityHeaders are applied (set-if-absent) when enabled, matching
// _SECURITY_HEADERS in api/middleware.py.
var securityHeaders = map[string]string{
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options":        "DENY",
	"Referrer-Policy":        "strict-origin-when-cross-origin",
	"Permissions-Policy":     "camera=(), microphone=(), geolocation=()",
}

// accessLogSkipPaths mirrors _ACCESS_LOG_SKIP_PATHS: high-frequency,
// low-signal endpoints whose access logs only waste disk.
var accessLogSkipPaths = []string{"/health/", "/api/chromecast/status", "/metrics"}

// statusRecorder captures the status code written by a handler.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(b)
}

// requestContext adds a correlation ID, request timing, an access log line,
// and security headers — the Go equivalent of RequestContextMiddleware.
func (a *App) requestContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rid := r.Header.Get("X-Request-ID")
		if rid == "" {
			rid = newRequestID()
		}

		// Security headers must be set before the handler writes the header,
		// since they cannot be added after WriteHeader.
		if a.cfg.SecurityHeadersEnabled {
			h := w.Header()
			for k, v := range securityHeaders {
				if h.Get(k) == "" {
					h.Set(k, v)
				}
			}
		}
		w.Header().Set("X-Request-ID", rid)

		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 0}
		next.ServeHTTP(rec, r)
		if rec.status == 0 {
			rec.status = http.StatusOK
		}

		path := r.URL.Path
		if !skipAccessLog(path) {
			a.log.Info("request",
				"method", r.Method,
				"path", path,
				"status", rec.status,
				"duration_ms", float64(time.Since(start).Microseconds())/1000.0,
				"request_id", rid,
			)
		}
	})
}

func skipAccessLog(path string) bool {
	for _, p := range accessLogSkipPaths {
		if strings.Contains(path, p) {
			return true
		}
	}
	return false
}

// newRequestID returns an 8-hex-char correlation ID, matching uuid4().hex[:8].
func newRequestID() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		// rand.Read on a healthy system does not fail; degrade to a constant.
		slog.Warn("crypto/rand unavailable for request id", "error", err)
		return "00000000"
	}
	return hex.EncodeToString(b[:])
}
