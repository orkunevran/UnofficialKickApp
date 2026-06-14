// Package obs holds process-wide observability counters surfaced by /metrics:
// the upstream Kick API call count and per-lane circuit-breaker events. It
// ports the thread-safe counters from api/routes/_common.py so later phases
// (the Kick client) can increment them and the metrics endpoint can read them.
//
// The Python port used threading.Lock around simple integer increments. Go's
// sync/atomic is the idiomatic replacement: no mutex, no contention, and cache-
// line friendly for the increment-heavy hot path.
package obs

import "sync/atomic"

// Lane names, matching the Python _CB_LANE_NAMES tuple.
const (
	LaneCritical    = "critical"
	LaneNonCritical = "non_critical"
	LaneOther       = "other"
)

// LaneEvents counts circuit-breaker rejections and failures for one lane.
// Exported for JSON marshalling by the metrics handler.
type LaneEvents struct {
	Rejections int64 `json:"rejections"`
	Failures   int64 `json:"failures"`
}

type atomicLane struct {
	rejections atomic.Int64
	failures   atomic.Int64
}

var (
	upstreamCalls atomic.Int64
	// lanes is written once at init and never structurally mutated; only the
	// counters inside each atomicLane change, so no map-level mutex is needed.
	lanes = map[string]*atomicLane{
		LaneCritical:    {},
		LaneNonCritical: {},
		LaneOther:       {},
	}
)

// IncUpstream atomically increments and returns the upstream call count.
func IncUpstream() int64 {
	return upstreamCalls.Add(1)
}

// UpstreamCalls returns the current upstream call count.
func UpstreamCalls() int64 {
	return upstreamCalls.Load()
}

// IncLaneEvent increments the rejection or failure counter for a lane.
// Unknown lanes are folded into "other", matching the Python behaviour.
func IncLaneEvent(lane, key string) {
	ev, ok := lanes[lane]
	if !ok {
		ev = lanes[LaneOther]
	}
	switch key {
	case "rejections":
		ev.rejections.Add(1)
	case "failures":
		ev.failures.Add(1)
	}
}

// LaneEventsSnapshot returns a copy of the per-lane event counters.
func LaneEventsSnapshot() map[string]LaneEvents {
	out := make(map[string]LaneEvents, len(lanes))
	for name, ev := range lanes {
		out[name] = LaneEvents{
			Rejections: ev.rejections.Load(),
			Failures:   ev.failures.Load(),
		}
	}
	return out
}

// Reset clears all counters (test helper).
func Reset() {
	upstreamCalls.Store(0)
	for _, ev := range lanes {
		ev.rejections.Store(0)
		ev.failures.Store(0)
	}
}
