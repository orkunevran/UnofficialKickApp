"""Lightweight metrics endpoint — no external dependencies."""

import time

from fastapi import APIRouter, Request

from api.cache import inflight_tracker
from api.routes._common import get_upstream_call_count

router = APIRouter(tags=["metrics"])

_start_time = time.monotonic()


@router.get("/metrics")
async def metrics(request: Request):
    cache = request.app.state.cache
    critical_cb = request.app.state.circuit_breaker_critical
    non_critical_cb = request.app.state.circuit_breaker_non_critical

    return {
        "cache": cache.stats(),
        "upstream": {
            "call_count": get_upstream_call_count(),
            # Backwards-compatible legacy field.
            "circuit_breaker": critical_cb.stats(),
            "circuit_breakers": {
                "critical": critical_cb.stats(),
                "non_critical": non_critical_cb.stats(),
            },
        },
        "inflight": inflight_tracker.stats(),
        "uptime_seconds": round(time.monotonic() - _start_time),
    }
