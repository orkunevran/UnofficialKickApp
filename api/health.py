"""Health and readiness endpoints.

/health returns component-level status so operators and orchestrators
can distinguish between a fully healthy instance and one that is
degraded (e.g. cache full, circuit breaker open).
"""

import time
from typing import Any

from fastapi import APIRouter, Request

router = APIRouter(tags=["health"])

_start_time = time.monotonic()


def _check_cache(request: Request) -> dict[str, Any]:
    cache = request.app.state.cache
    stats = cache.stats()
    utilization = stats["size"] / max(stats["max_size"], 1)
    return {
        "status": "healthy" if utilization < 0.95 else "degraded",
        "size": stats["size"],
        "max_size": stats["max_size"],
        "utilization_pct": round(utilization * 100, 1),
    }


def _check_circuit_breaker(request: Request) -> dict[str, Any]:
    cb = request.app.state.circuit_breaker
    state = cb.state
    return {
        "status": "healthy" if state == "closed" else ("degraded" if state == "half_open" else "unhealthy"),
        "state": state,
    }


@router.get("/health")
async def health(request: Request):
    """Aggregated health check with per-component status.

    Returns 200 if all components are healthy or degraded,
    503 if any component is unhealthy.
    """
    components = {
        "cache": _check_cache(request),
        "circuit_breaker": _check_circuit_breaker(request),
    }

    overall = "healthy"
    for comp in components.values():
        if comp["status"] == "unhealthy":
            overall = "unhealthy"
            break
        if comp["status"] == "degraded":
            overall = "degraded"

    status_code = 200 if overall != "unhealthy" else 503
    return {
        "status": overall,
        "uptime_seconds": round(time.monotonic() - _start_time),
        "components": components,
    }


@router.get("/health/live")
async def liveness():
    """Minimal liveness probe — returns 200 if the process is running."""
    return {"status": "ok"}
