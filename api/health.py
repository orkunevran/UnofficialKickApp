"""Health and readiness endpoints.

/health returns component-level status so operators and orchestrators
can distinguish between a fully healthy instance and one that is
degraded (e.g. cache full, circuit breaker open).
"""

import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

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


def _check_circuit_breaker(cb) -> dict[str, Any]:
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
    critical_cb = request.app.state.circuit_breaker_critical
    non_critical_cb = request.app.state.circuit_breaker_non_critical
    critical_status = _check_circuit_breaker(critical_cb)
    non_critical_status = _check_circuit_breaker(non_critical_cb)

    components = {
        "cache": _check_cache(request),
        # Backwards-compatible legacy field.
        "circuit_breaker": critical_status,
        "circuit_breakers": {
            "critical": critical_status,
            "non_critical": non_critical_status,
        },
    }

    overall = "healthy"
    statuses = [components["cache"], critical_status, non_critical_status]
    for comp in statuses:
        if comp["status"] == "unhealthy":
            overall = "unhealthy"
            break
        if comp["status"] == "degraded":
            overall = "degraded"

    status_code = 200 if overall != "unhealthy" else 503
    return JSONResponse(
        content={
            "status": overall,
            "uptime_seconds": round(time.monotonic() - _start_time),
            "components": components,
        },
        status_code=status_code,
    )


@router.get("/health/live")
async def liveness():
    """Minimal liveness probe — returns 200 if the process is running."""
    return {"status": "ok"}
