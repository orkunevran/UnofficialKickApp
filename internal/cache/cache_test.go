package cache

import (
	"testing"
	"time"
)

func TestSetGet(t *testing.T) {
	c := New(10)
	c.SetTTL("k", "v", time.Minute)
	if got, ok := c.Get("k"); !ok || got != "v" {
		t.Fatalf("Get(k) = %v, %v; want v, true", got, ok)
	}
	if _, ok := c.Get("missing"); ok {
		t.Fatal("Get(missing) = ok; want miss")
	}
}

func TestExpiry(t *testing.T) {
	c := New(10)
	c.SetTTL("k", "v", 20*time.Millisecond)
	if _, ok := c.Get("k"); !ok {
		t.Fatal("entry should be live immediately after set")
	}
	time.Sleep(30 * time.Millisecond)
	if _, ok := c.Get("k"); ok {
		t.Fatal("entry should have expired")
	}
}

func TestNonPositiveTTLExpiresImmediately(t *testing.T) {
	c := New(10)
	c.SetTTL("k", "v", 0)
	if _, ok := c.Get("k"); ok {
		t.Fatal("zero TTL should be treated as already expired")
	}
}

func TestEvictionByInsertionOrder(t *testing.T) {
	c := New(2)
	c.SetTTL("a", 1, time.Minute)
	c.SetTTL("b", 2, time.Minute)
	c.SetTTL("c", 3, time.Minute) // exceeds capacity → oldest (a) evicted
	if _, ok := c.Get("a"); ok {
		t.Fatal("a should have been evicted (oldest)")
	}
	if _, ok := c.Get("b"); !ok {
		t.Fatal("b should remain")
	}
	if _, ok := c.Get("c"); !ok {
		t.Fatal("c should remain")
	}
}

func TestReSetKeepsPosition(t *testing.T) {
	// maxSize 3 so the re-set happens below capacity (no eviction interaction).
	// Re-setting an existing key updates its value in place and must NOT move
	// it to newest — so it stays the oldest and is the first evicted later.
	c := New(3)
	c.SetTTL("a", 1, time.Minute)
	c.SetTTL("b", 2, time.Minute)
	c.SetTTL("a", 99, time.Minute) // in-place update; insertion order stays [a, b]
	c.SetTTL("c", 3, time.Minute)  // [a, b, c]
	c.SetTTL("d", 4, time.Minute)  // capacity hit → evict oldest, which is still a

	if _, ok := c.Get("a"); ok {
		t.Fatal("re-set must not move a to newest; a should be evicted as oldest")
	}
	if v, ok := c.Get("b"); !ok || v != 2 {
		t.Fatalf("b should remain = 2, got %v ok=%v", v, ok)
	}
	if _, ok := c.Get("d"); !ok {
		t.Fatal("d should remain")
	}
}

func TestExpiredEvictedBeforeOldest(t *testing.T) {
	c := New(2)
	c.SetTTL("a", 1, 10*time.Millisecond) // will expire
	c.SetTTL("b", 2, time.Minute)
	time.Sleep(20 * time.Millisecond)
	c.SetTTL("c", 3, time.Minute) // capacity hit; expired 'a' should be dropped, b retained
	if _, ok := c.Get("a"); ok {
		t.Fatal("expired a should be gone")
	}
	if _, ok := c.Get("b"); !ok {
		t.Fatal("b should be retained (a was expired, evicted first)")
	}
	if _, ok := c.Get("c"); !ok {
		t.Fatal("c should be present")
	}
}

func TestStats(t *testing.T) {
	c := New(10)
	c.SetTTL("k", "v", time.Minute)
	c.Get("k")       // hit
	c.Get("k")       // hit
	c.Get("missing") // miss
	s := c.Stats()
	if s.HitCount != 2 || s.MissCount != 1 || s.Size != 1 || s.MaxSize != 10 {
		t.Fatalf("stats = %+v; want hits=2 miss=1 size=1 max=10", s)
	}
}
