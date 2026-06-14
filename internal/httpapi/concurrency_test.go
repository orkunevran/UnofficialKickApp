package httpapi

import (
	"sync"
	"testing"
)

// TestConcurrentHandlers hammers the lock-sensitive request paths from many
// goroutines at once. Run with -race, it is a regression guard against the
// Python→Go porting hazards where the GIL had made certain operations look
// atomic: SWR cache reads/writes, in-flight dedup, the shared obs counters and
// circuit breakers, search-avatar enrichment (must not mutate cached payloads
// in place), the parallel viewers/batch fan-out, and cross-endpoint avatar
// cache population. A data race here fails the test under the race detector.
func TestConcurrentHandlers(t *testing.T) {
	app := newParityApp(t)

	// A mix of endpoints that share the cache, inflight tracker, obs counters,
	// and breakers. Several deliberately hit the same keys so goroutines
	// collide on the same cache entries and inflight markers.
	requests := []struct{ method, path string }{
		{"GET", "/streams/play/live-user"},
		{"GET", "/streams/play/live-user"}, // same key → inflight dedup + SWR
		{"GET", "/streams/featured-livestreams?language=tr&page=1"},
		{"GET", "/streams/featured-livestreams?language=tr&page=1"},
		{"GET", "/streams/search?q=live"},
		{"GET", "/streams/search?q=live"}, // same key → enrich on hit + miss
		{"GET", "/streams/avatar/live-user"},
		{"GET", "/streams/clips/live-user"},
		{"GET", "/streams/vods/live-user"},
		{"GET", "/streams/viewers?id=42"},
		{"GET", "/streams/viewers/batch?ids=9876,42"},
		{"GET", "/metrics"},
		{"GET", "/health"},
	}

	const workers = 32
	const iterations = 40

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			for i := 0; i < iterations; i++ {
				r := requests[(seed+i)%len(requests)]
				rec := doReq(app, r.method, r.path, nil)
				if rec.Code >= 500 {
					t.Errorf("%s %s → %d", r.method, r.path, rec.Code)
					return
				}
			}
		}(w)
	}
	wg.Wait()
}
