package httpapi

import (
	"net"
	"net/http"
	"sync"
	"time"
)

type ipBucket struct {
	tokens   float64
	updated  time.Time
	lastSeen time.Time
}

// ipRateLimiter is a small stdlib token-bucket limiter. It intentionally uses
// the TCP peer address and does not trust spoofable forwarding headers.
type ipRateLimiter struct {
	mu      sync.Mutex
	rate    float64
	burst   float64
	buckets map[string]*ipBucket
	checks  uint64
}

func newIPRateLimiter(rate float64, burst int) *ipRateLimiter {
	return &ipRateLimiter{rate: rate, burst: float64(burst), buckets: make(map[string]*ipBucket)}
}

func (l *ipRateLimiter) allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.checks++
	if l.checks%1024 == 0 {
		for key, bucket := range l.buckets {
			if now.Sub(bucket.lastSeen) > 10*time.Minute {
				delete(l.buckets, key)
			}
		}
	}
	bucket := l.buckets[ip]
	if bucket == nil {
		l.buckets[ip] = &ipBucket{tokens: l.burst - 1, updated: now, lastSeen: now}
		return true
	}
	bucket.tokens += now.Sub(bucket.updated).Seconds() * l.rate
	if bucket.tokens > l.burst {
		bucket.tokens = l.burst
	}
	bucket.updated = now
	bucket.lastSeen = now
	if bucket.tokens < 1 {
		return false
	}
	bucket.tokens--
	return true
}

func (a *App) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			ip = r.RemoteAddr
		}
		if !a.rateLimiter.allow(ip, time.Now()) {
			w.Header().Set("Retry-After", "1")
			errorJSON(w, "Too many requests.", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}
