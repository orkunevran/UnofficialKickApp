// Package obs holds process-wide observability counters surfaced by /metrics:
// the upstream Kick API call count and per-lane circuit-breaker events. It
// ports the thread-safe counters from api/routes/_common.py so later phases
// (the Kick client) can increment them and the metrics endpoint can read them.
package obs

import "sync"

// Lane names, matching the Python _CB_LANE_NAMES tuple.
const (
	LaneCritical    = "critical"
	LaneNonCritical = "non_critical"
	LaneOther       = "other"
)

// LaneEvents counts circuit-breaker rejections and failures for one lane.
type LaneEvents struct {
	Rejections int64 `json:"rejections"`
	Failures   int64 `json:"failures"`
}

var (
	mu            sync.Mutex
	upstreamCalls int64
	lanes         = map[string]*LaneEvents{
		LaneCritical:    {},
		LaneNonCritical: {},
		LaneOther:       {},
	}
)

// IncUpstream atomically increments and returns the upstream call count.
func IncUpstream() int64 {
	mu.Lock()
	defer mu.Unlock()
	upstreamCalls++
	return upstreamCalls
}

// UpstreamCalls returns the current upstream call count.
func UpstreamCalls() int64 {
	mu.Lock()
	defer mu.Unlock()
	return upstreamCalls
}

// IncLaneEvent increments the rejection or failure counter for a lane.
// Unknown lanes are folded into "other", matching the Python behaviour.
func IncLaneEvent(lane, key string) {
	mu.Lock()
	defer mu.Unlock()
	ev, ok := lanes[lane]
	if !ok {
		ev = lanes[LaneOther]
	}
	switch key {
	case "rejections":
		ev.Rejections++
	case "failures":
		ev.Failures++
	}
}

// LaneEventsSnapshot returns a copy of the per-lane event counters.
func LaneEventsSnapshot() map[string]LaneEvents {
	mu.Lock()
	defer mu.Unlock()
	out := make(map[string]LaneEvents, len(lanes))
	for name, ev := range lanes {
		out[name] = *ev
	}
	return out
}

// Reset clears all counters (test helper).
func Reset() {
	mu.Lock()
	defer mu.Unlock()
	upstreamCalls = 0
	for _, ev := range lanes {
		ev.Rejections = 0
		ev.Failures = 0
	}
}
