package inflight

import (
	"testing"
	"time"

	"kickapi/internal/cache"
)

func TestDedupGetColdRegistersThenServes(t *testing.T) {
	c := cache.New(10, time.Minute)
	tr := New()

	// Cold: caller becomes the fetcher.
	if v, ok := tr.DedupGet(c, "k", time.Second); ok || v != nil {
		t.Fatalf("cold DedupGet = (%v, %v); want (nil, false)", v, ok)
	}
	if active, _ := tr.Stats(); active != 1 {
		t.Fatalf("expected 1 active key, got %d", active)
	}

	// Fetcher populates cache and signals completion.
	c.Set("k", "val")
	tr.DedupSet("k")
	if active, _ := tr.Stats(); active != 0 {
		t.Fatalf("DedupSet should clear the marker, %d remain", active)
	}

	// Subsequent call is a plain cache hit.
	if v, ok := tr.DedupGet(c, "k", time.Second); !ok || v != "val" {
		t.Fatalf("post-set DedupGet = (%v, %v); want (val, true)", v, ok)
	}
}

func TestDedupGetWaitsForInflight(t *testing.T) {
	c := cache.New(10, time.Minute)
	tr := New()
	tr.DedupGet(c, "k", time.Second) // register as fetcher

	go func() {
		time.Sleep(20 * time.Millisecond)
		c.Set("k", "ready")
		tr.DedupSet("k")
	}()

	// Waiter blocks until DedupSet, then reads the populated value.
	v, ok := tr.DedupGet(c, "k", time.Second)
	if !ok || v != "ready" {
		t.Fatalf("waiter got (%v, %v); want (ready, true)", v, ok)
	}
}

func TestDedupGetTimeout(t *testing.T) {
	c := cache.New(10, time.Minute)
	tr := New()
	tr.DedupGet(c, "k", time.Second) // register; never completed

	v, ok := tr.DedupGet(c, "k", 10*time.Millisecond)
	if ok || v != nil {
		t.Fatalf("timed-out waiter = (%v, %v); want (nil, false)", v, ok)
	}
	if _, timeouts := tr.Stats(); timeouts != 1 {
		t.Fatalf("timeout_count = %d; want 1", timeouts)
	}
}

func TestClaimInflight(t *testing.T) {
	tr := New()
	if !tr.ClaimInflight("x") {
		t.Fatal("first claim should succeed")
	}
	if tr.ClaimInflight("x") {
		t.Fatal("second claim should fail while in flight")
	}
	tr.DedupSet("x")
	if !tr.ClaimInflight("x") {
		t.Fatal("claim should succeed again after DedupSet")
	}
}

func TestSweepStale(t *testing.T) {
	tr := New()
	tr.ClaimInflight("old")
	time.Sleep(15 * time.Millisecond)
	if n := tr.SweepStale(10 * time.Millisecond); n != 1 {
		t.Fatalf("SweepStale removed %d; want 1", n)
	}
	if active, _ := tr.Stats(); active != 0 {
		t.Fatalf("expected 0 active after sweep, got %d", active)
	}
}
