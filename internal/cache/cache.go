// Package cache is a thread-safe, in-memory cache with TTL and bounded size,
// a direct port of services/cache_service.py (InMemoryCache).
//
// Eviction mirrors the Python two-pass strategy: when the store is at
// capacity, expired entries are removed first, then the oldest by insertion
// order. Insertion order is tracked with a container/list because Go maps
// have no defined iteration order (Python dicts preserve insertion order).
// Re-setting an existing key updates its value but keeps its original
// position, matching Python dict assignment semantics.
package cache

import (
	"container/list"
	"sync"
	"time"
)

type entry struct {
	expiresAt time.Time
	value     any
	elem      *list.Element // position in the insertion-order list (value = key)
}

// Stats is the snapshot returned by Stats(), matching the Python stats() dict.
type Stats struct {
	Size      int   `json:"size"`
	MaxSize   int   `json:"max_size"`
	HitCount  int64 `json:"hit_count"`
	MissCount int64 `json:"miss_count"`
}

// Cache is a bounded in-memory key/value store with per-entry TTL.
type Cache struct {
	mu             sync.Mutex
	store          map[string]*entry
	order          *list.List
	maxSize        int
	defaultTimeout time.Duration
	hit            int64
	miss           int64
}

// New creates a cache with the given capacity and default TTL.
func New(maxSize int, defaultTimeout time.Duration) *Cache {
	if maxSize < 1 {
		maxSize = 1
	}
	return &Cache{
		store:          make(map[string]*entry),
		order:          list.New(),
		maxSize:        maxSize,
		defaultTimeout: defaultTimeout,
	}
}

// MaxSize returns the configured capacity.
func (c *Cache) MaxSize() int { return c.maxSize }

// expiry computes the absolute expiry instant for a TTL. A non-positive TTL
// yields "now", so the entry is treated as already expired (matches Python's
// timeout <= 0 behaviour).
func (c *Cache) expiry(timeout time.Duration) time.Time {
	if timeout <= 0 {
		return time.Now()
	}
	return time.Now().Add(timeout)
}

// Set stores value under key using the cache's default TTL.
func (c *Cache) Set(key string, value any) {
	c.SetTTL(key, value, c.defaultTimeout)
}

// SetTTL stores value under key with an explicit TTL.
func (c *Cache) SetTTL(key string, value any, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.evictIfNeeded()
	if e, ok := c.store[key]; ok {
		// Update in place; keep original insertion position.
		e.expiresAt = c.expiry(ttl)
		e.value = value
		return
	}
	c.store[key] = &entry{
		expiresAt: c.expiry(ttl),
		value:     value,
		elem:      c.order.PushBack(key),
	}
}

// Get returns the value for key and whether it was a live hit. Expired entries
// are removed and reported as a miss.
func (c *Cache) Get(key string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.store[key]
	if !ok {
		c.miss++
		return nil, false
	}
	if !e.expiresAt.After(time.Now()) {
		c.removeLocked(key, e)
		c.miss++
		return nil, false
	}
	c.hit++
	return e.value, true
}

// Delete removes key, reporting whether it was present.
func (c *Cache) Delete(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.store[key]
	if !ok {
		return false
	}
	c.removeLocked(key, e)
	return true
}

// Clear empties the cache and resets hit/miss counters.
func (c *Cache) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.store = make(map[string]*entry)
	c.order.Init()
	c.hit = 0
	c.miss = 0
}

// Stats returns a snapshot of size and hit/miss counters.
func (c *Cache) Stats() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()
	return Stats{
		Size:      len(c.store),
		MaxSize:   c.maxSize,
		HitCount:  c.hit,
		MissCount: c.miss,
	}
}

// removeLocked deletes an entry and its order node. Caller must hold the lock.
func (c *Cache) removeLocked(key string, e *entry) {
	c.order.Remove(e.elem)
	delete(c.store, key)
}

// evictIfNeeded enforces the size bound. Caller must hold the lock.
func (c *Cache) evictIfNeeded() {
	if len(c.store) < c.maxSize {
		return
	}
	now := time.Now()
	// Pass 1: drop expired entries (oldest first), stopping once under limit.
	for el := c.order.Front(); el != nil; {
		next := el.Next()
		key := el.Value.(string)
		if e := c.store[key]; e != nil && !e.expiresAt.After(now) {
			c.removeLocked(key, e)
			if len(c.store) < c.maxSize {
				return
			}
		}
		el = next
	}
	// Pass 2: evict oldest by insertion order until under limit.
	for len(c.store) >= c.maxSize {
		front := c.order.Front()
		if front == nil {
			return
		}
		key := front.Value.(string)
		c.removeLocked(key, c.store[key])
	}
}
