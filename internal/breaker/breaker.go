// Package breaker is a lightweight circuit breaker for upstream API calls,
// a direct port of services/circuit_breaker.py (CircuitBreaker).
//
// States:
//
//	closed    – normal operation, requests pass through.
//	open      – too many failures; requests fail fast.
//	half_open – recovery probe: exactly ONE request is allowed through.
//	            Success → closed; failure → open.
package breaker

import (
	"sync"
	"time"
)

// State values, matching the Python string states for metrics parity.
const (
	StateClosed   = "closed"
	StateOpen     = "open"
	StateHalfOpen = "half_open"
)

// Breaker is a thread-safe circuit breaker.
type Breaker struct {
	failureThreshold int
	recoveryTimeout  time.Duration

	mu                sync.Mutex
	failureCount      int
	state             string
	lastFailureTime   time.Time
	halfOpenPermitted bool
}

// Stats is the snapshot returned by Stats(), matching the Python stats() dict.
type Stats struct {
	State            string `json:"state"`
	FailureCount     int    `json:"failure_count"`
	FailureThreshold int    `json:"failure_threshold"`
	RecoveryTimeout  int    `json:"recovery_timeout"`
}

// New creates a breaker with the given failure threshold and recovery timeout.
func New(failureThreshold int, recoveryTimeout time.Duration) *Breaker {
	return &Breaker{
		failureThreshold: failureThreshold,
		recoveryTimeout:  recoveryTimeout,
		state:            StateClosed,
	}
}

// maybeTransitionToHalfOpen moves open → half_open once the recovery timeout
// has elapsed. Caller must hold the lock.
func (b *Breaker) maybeTransitionToHalfOpen() {
	if b.state == StateOpen && time.Since(b.lastFailureTime) >= b.recoveryTimeout {
		b.state = StateHalfOpen
		b.halfOpenPermitted = true
	}
}

// State returns the current state, applying any pending recovery transition.
func (b *Breaker) State() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.maybeTransitionToHalfOpen()
	return b.state
}

// AllowRequest reports whether a request may proceed. In half-open state only
// the first caller is granted the probe.
func (b *Breaker) AllowRequest() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.maybeTransitionToHalfOpen()
	if b.state == StateClosed {
		return true
	}
	if b.state == StateHalfOpen && b.halfOpenPermitted {
		b.halfOpenPermitted = false // only one probe
		return true
	}
	return false
}

// RecordSuccess resets the breaker to closed.
func (b *Breaker) RecordSuccess() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.failureCount = 0
	b.state = StateClosed
}

// RecordFailure increments the failure count and opens the breaker once the
// threshold is reached.
func (b *Breaker) RecordFailure() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.failureCount++
	b.lastFailureTime = time.Now()
	if b.failureCount >= b.failureThreshold {
		b.state = StateOpen
		b.halfOpenPermitted = false
	}
}

// Stats returns a snapshot of breaker state.
func (b *Breaker) Stats() Stats {
	b.mu.Lock()
	defer b.mu.Unlock()
	return Stats{
		State:            b.state,
		FailureCount:     b.failureCount,
		FailureThreshold: b.failureThreshold,
		RecoveryTimeout:  int(b.recoveryTimeout.Seconds()),
	}
}
