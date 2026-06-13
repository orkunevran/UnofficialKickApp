package breaker

import (
	"testing"
	"time"
)

func TestClosedAllowsAndOpensAfterThreshold(t *testing.T) {
	b := New(3, time.Minute)
	if !b.AllowRequest() {
		t.Fatal("closed breaker should allow requests")
	}
	b.RecordFailure()
	b.RecordFailure()
	if b.State() != StateClosed {
		t.Fatalf("state after 2/3 failures = %s; want closed", b.State())
	}
	b.RecordFailure() // hits threshold
	if b.State() != StateOpen {
		t.Fatalf("state after 3/3 failures = %s; want open", b.State())
	}
	if b.AllowRequest() {
		t.Fatal("open breaker should reject requests")
	}
}

func TestHalfOpenProbeAndRecovery(t *testing.T) {
	b := New(1, 40*time.Millisecond)
	b.RecordFailure() // open
	if b.State() != StateOpen {
		t.Fatalf("want open, got %s", b.State())
	}
	time.Sleep(50 * time.Millisecond)

	// First request after recovery window is the single probe.
	if !b.AllowRequest() {
		t.Fatal("first request after recovery should be the half-open probe")
	}
	if b.AllowRequest() {
		t.Fatal("second concurrent request in half-open must be rejected")
	}

	b.RecordSuccess()
	if b.State() != StateClosed {
		t.Fatalf("successful probe should close breaker, got %s", b.State())
	}
}

func TestHalfOpenFailureReopens(t *testing.T) {
	b := New(1, 30*time.Millisecond)
	b.RecordFailure()
	time.Sleep(40 * time.Millisecond)
	if !b.AllowRequest() {
		t.Fatal("expected half-open probe to be allowed")
	}
	b.RecordFailure() // probe failed
	if b.State() != StateOpen {
		t.Fatalf("failed probe should reopen breaker, got %s", b.State())
	}
}

func TestStats(t *testing.T) {
	b := New(5, 30*time.Second)
	b.RecordFailure()
	s := b.Stats()
	if s.State != StateClosed || s.FailureCount != 1 || s.FailureThreshold != 5 || s.RecoveryTimeout != 30 {
		t.Fatalf("stats = %+v", s)
	}
}
