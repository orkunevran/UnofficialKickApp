package logging

import (
	"log/slog"
	"sync"
)

// ThrottledLogger collapses consecutive identical log messages into a single
// line, then emits a summary every summaryEvery occurrences. Ports the Python
// ThrottledErrorLog from services/log_throttle.py. Useful in retry/scan loops
// where the same connection failure would otherwise spam the log at high rate.
//
// Zero value is ready to use with a default summaryEvery of 50.
type ThrottledLogger struct {
	mu           sync.Mutex
	last         string
	streak       int
	summaryEvery int
}

// NewThrottledLogger creates a ThrottledLogger that summarises after every
// summaryEvery suppressed repeats.
func NewThrottledLogger(summaryEvery int) *ThrottledLogger {
	if summaryEvery < 1 {
		summaryEvery = 50
	}
	return &ThrottledLogger{summaryEvery: summaryEvery}
}

// Warn logs msg at Warn level, suppressing consecutive duplicates (keyed on
// msg alone). A summary is emitted every summaryEvery suppressed repeats.
func (t *ThrottledLogger) Warn(log *slog.Logger, msg string, args ...any) {
	t.mu.Lock()
	if t.summaryEvery == 0 {
		t.summaryEvery = 50
	}
	if msg == t.last {
		t.streak++
		n := t.streak
		emit := n%t.summaryEvery == 0
		t.mu.Unlock()
		if emit {
			log.Warn(msg+" (repeated)", append(args, "streak", n)...)
		}
		return
	}
	t.last = msg
	t.streak = 1
	t.mu.Unlock()
	log.Warn(msg, args...)
}

// StateChangeLog logs only when a boolean condition flips. Useful for
// circuit-breaker open/close events where you want one line per transition,
// not one line per rejected request. Ports StateChangeLog from log_throttle.py.
type StateChangeLog struct {
	mu    sync.Mutex
	state map[string]bool
}

// Transitioned returns true (and records the new value) only when condition
// differs from the previous call for the same key.
func (s *StateChangeLog) Transitioned(key string, condition bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state == nil {
		s.state = make(map[string]bool)
	}
	prev, seen := s.state[key]
	if seen && prev == condition {
		return false
	}
	s.state[key] = condition
	return true
}
