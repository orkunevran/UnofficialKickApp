package httpapi

import (
	"net/http"
	"time"
)

// cachedResp is a cached response body plus its status code, mirroring the
// (payload, status_code) tuples the Python app stores. Storing the status lets
// negative-cached errors (e.g. 404) replay with the correct code.
type cachedResp struct {
	payload map[string]any
	status  int
}

func (a *App) cacheGet(key string) (cachedResp, bool) {
	v, ok := a.cache.Get(key)
	if !ok {
		return cachedResp{}, false
	}
	c, ok := v.(cachedResp)
	return c, ok
}

func (a *App) cachePut(key string, payload map[string]any, status int, ttl time.Duration) {
	a.cache.SetTTL(key, cachedResp{payload: payload, status: status}, ttl)
}

func writeCached(w http.ResponseWriter, c cachedResp) {
	writeJSON(w, c.status, c.payload)
}

// limiter is a counting semaphore with a bounded acquire wait, the Go analog of
// the background-refresh asyncio.Semaphore (acquired with a short timeout so a
// saturated refresh pool skips rather than queues).
type limiter struct{ ch chan struct{} }

func newLimiter(n int) *limiter {
	if n < 1 {
		n = 1
	}
	return &limiter{ch: make(chan struct{}, n)}
}

// tryAcquire returns true if a slot was acquired within timeout.
func (l *limiter) tryAcquire(timeout time.Duration) bool {
	select {
	case l.ch <- struct{}{}:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (l *limiter) release() { <-l.ch }
