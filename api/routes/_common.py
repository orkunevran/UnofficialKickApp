"""Shared helpers for stream route handlers."""

import asyncio
import logging
import re
import threading
from typing import Optional

import requests

from api.errors import ApiError, requests_exception_to_api_error

logger = logging.getLogger(__name__)

_SLUG_RE = re.compile(r"^[a-zA-Z0-9_-]{1,255}$")
SUBCATEGORY_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9 &.:_()\-]{0,99}$")

# ── Thread-safe upstream call counter (observability) ─────────────────────
_upstream_call_count = 0
_upstream_lock = threading.Lock()


def get_upstream_call_count() -> int:
    with _upstream_lock:
        return _upstream_call_count


def _increment_upstream_count() -> int:
    """Atomically increment and return the new upstream call count."""
    global _upstream_call_count
    with _upstream_lock:
        _upstream_call_count += 1
        return _upstream_call_count


def validate_slug(slug: Optional[str]) -> bool:
    return bool(slug and _SLUG_RE.match(slug))


async def kick_call(func, *args, safe_value: str = "unknown", circuit_breaker=None, **kwargs):
    """Run a blocking KickAPIClient method via ``asyncio.to_thread``,
    convert ``requests.RequestException`` into ``ApiError``,
    and integrate with the circuit breaker if provided.

    Thread safety: the blocking ``func`` runs in the default executor
    (thread pool). The upstream call counter is incremented atomically
    under ``_upstream_lock``. Circuit breaker calls are thread-safe
    by design (``CircuitBreaker`` uses its own internal lock).
    """
    if circuit_breaker is not None and not circuit_breaker.allow_request():
        raise ApiError("Service temporarily unavailable — upstream failures detected.", 503)

    try:
        result = await asyncio.to_thread(func, *args, **kwargs)
        count = _increment_upstream_count()
        if count % 50 == 0:
            logger.info("Upstream Kick API calls total: %d", count)
        if circuit_breaker is not None:
            circuit_breaker.record_success()
        return result
    except requests.exceptions.RequestException as exc:
        _increment_upstream_count()
        if circuit_breaker is not None:
            circuit_breaker.record_failure()
        raise requests_exception_to_api_error(exc, safe_value) from exc
