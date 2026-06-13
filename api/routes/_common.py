"""Shared helpers for stream route handlers."""

import asyncio
import logging
import re
import threading
from typing import Optional

import requests

from api.errors import ApiError, requests_exception_to_api_error
from services.log_throttle import StateChangeLog, ThrottledErrorLog

logger = logging.getLogger(__name__)

# Circuit-breaker rejections fire on EVERY request while the breaker is open.
# Under a thundering-herd outage that's thousands of identical log lines per
# minute. Log only when the breaker transitions open/closed for each lane.
_cb_state_log = StateChangeLog()
_upstream_error_log = ThrottledErrorLog(summary_every=100)

_SLUG_RE = re.compile(r"^[a-zA-Z0-9_-]{1,255}$")
SUBCATEGORY_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9 &.:_()\-]{0,99}$")

# ── Thread-safe upstream call counter (observability) ─────────────────────
_upstream_call_count = 0
_upstream_lock = threading.Lock()
_CB_LANE_NAMES = ("critical", "non_critical", "other")
_cb_lane_events: dict[str, dict[str, int]] = {
    lane: {"rejections": 0, "failures": 0}
    for lane in _CB_LANE_NAMES
}
_cb_lane_lock = threading.Lock()


def get_upstream_call_count() -> int:
    with _upstream_lock:
        return _upstream_call_count


def _increment_upstream_count() -> int:
    """Atomically increment and return the new upstream call count."""
    global _upstream_call_count
    with _upstream_lock:
        _upstream_call_count += 1
        return _upstream_call_count


def _increment_cb_lane_event(lane: str, key: str) -> None:
    lane = lane if lane in _CB_LANE_NAMES else "other"
    with _cb_lane_lock:
        _cb_lane_events[lane][key] += 1


def get_circuit_breaker_lane_events() -> dict[str, dict[str, int]]:
    with _cb_lane_lock:
        return {lane: dict(events) for lane, events in _cb_lane_events.items()}


def validate_slug(slug: Optional[str]) -> bool:
    return bool(slug and _SLUG_RE.match(slug))


async def kick_call(
    func,
    *args,
    safe_value: str = "unknown",
    circuit_breaker=None,
    circuit_breaker_name: str = "default",
    **kwargs,
):
    """Run a blocking KickAPIClient method via ``asyncio.to_thread``,
    convert ``requests.RequestException`` into ``ApiError``,
    and integrate with the circuit breaker if provided.

    Thread safety: the blocking ``func`` runs in the default executor
    (thread pool). The upstream call counter is incremented atomically
    under ``_upstream_lock``. Circuit breaker calls are thread-safe
    by design (``CircuitBreaker`` uses its own internal lock).
    """
    if circuit_breaker is not None and not circuit_breaker.allow_request():
        _increment_cb_lane_event(circuit_breaker_name, "rejections")
        if _cb_state_log.transitioned(circuit_breaker_name, True):
            logger.warning(
                "Circuit breaker lane=%s OPEN — rejecting requests until recovery.",
                circuit_breaker_name,
            )
        raise ApiError("Service temporarily unavailable — upstream failures detected.", 503)

    try:
        if asyncio.iscoroutinefunction(func):
            result = await func(*args, **kwargs)
        else:
            result = await asyncio.to_thread(func, *args, **kwargs)
        count = _increment_upstream_count()
        if count % 50 == 0:
            logger.info("Upstream Kick API calls total: %d", count)
        if circuit_breaker is not None:
            circuit_breaker.record_success()
            if _cb_state_log.transitioned(circuit_breaker_name, False):
                logger.info("Circuit breaker lane=%s CLOSED — upstream recovered.", circuit_breaker_name)
        return result
    except requests.exceptions.RequestException as exc:
        _increment_upstream_count()
        if circuit_breaker is not None:
            circuit_breaker.record_failure()
            _increment_cb_lane_event(circuit_breaker_name, "failures")
            _upstream_error_log.warn(
                logger,
                f"Upstream request failed (breaker lane={circuit_breaker_name})",
                exc,
            )
        raise requests_exception_to_api_error(exc, safe_value) from exc
