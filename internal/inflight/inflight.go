// Package inflight ports the in-flight deduplication tracker from api/cache.py
// (InflightTracker). It prevents thundering-herd on cache miss: only one
// goroutine fetches a given key, others wait (with timeout) on a per-key
// broadcast channel and then read the now-populated cache.
//
// We port the tracker rather than use golang.org/x/sync/singleflight because
// the SWR refresh path needs the separate ClaimInflight primitive and /metrics
// needs the active-keys / timeout counters — neither of which singleflight
// exposes. The Go broadcast is a closed channel (the analog of asyncio.Event).
package inflight

import (
	"sync"
	"time"

	"kickapi/internal/cache"
)

type entry struct {
	done chan struct{}
	ts   time.Time
}

// Tracker tracks in-flight fetches keyed by cache key.
type Tracker struct {
	mu           sync.Mutex
	m            map[string]*entry
	timeoutCount int64
}

// New creates an empty tracker.
func New() *Tracker {
	return &Tracker{m: make(map[string]*entry)}
}

// DedupGet returns (value, true) on a cache hit or after waiting for an
// in-flight fetch to complete; it returns (nil, false) when the caller is the
// designated fetcher (it must call DedupSet when done) or when a wait timed out
// without the value appearing (the caller should then fetch itself).
func (t *Tracker) DedupGet(c *cache.Cache, key string, waitTimeout time.Duration) (any, bool) {
	if v, ok := c.Get(key); ok {
		return v, true
	}

	t.mu.Lock()
	if e, exists := t.m[key]; exists {
		t.mu.Unlock()
		select {
		case <-e.done:
		case <-time.After(waitTimeout):
			t.mu.Lock()
			t.timeoutCount++
			t.mu.Unlock()
		}
		// On timeout we intentionally leave the in-flight marker in place — the
		// original fetcher is still running and will DedupSet when done.
		return c.Get(key)
	}
	t.m[key] = &entry{done: make(chan struct{}), ts: time.Now()}
	t.mu.Unlock()
	return nil, false
}

// ClaimInflight tries to claim the key as the sole background fetcher (used by
// stale-while-revalidate). Returns true if claimed, false if already in flight.
func (t *Tracker) ClaimInflight(key string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.m[key]; ok {
		return false
	}
	t.m[key] = &entry{done: make(chan struct{}), ts: time.Now()}
	return true
}

// DedupSet unblocks all waiters on key and removes the in-flight marker. Safe
// to call when no marker exists (no-op).
func (t *Tracker) DedupSet(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if e, ok := t.m[key]; ok {
		delete(t.m, key)
		close(e.done)
	}
}

// SweepStale removes in-flight markers older than maxAge (abandoned fetches),
// unblocking any waiters. Returns the number swept.
func (t *Tracker) SweepStale(maxAge time.Duration) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := 0
	for k, e := range t.m {
		if time.Since(e.ts) > maxAge {
			delete(t.m, k)
			close(e.done)
			n++
		}
	}
	return n
}

// Stats returns the active key count and cumulative wait-timeout count.
func (t *Tracker) Stats() (activeKeys int, timeoutCount int64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.m), t.timeoutCount
}
