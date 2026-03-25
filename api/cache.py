import asyncio
import logging
import time
from typing import Optional
from urllib.parse import urlencode

from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-flight deduplication tracker
# ---------------------------------------------------------------------------
# Prevents thundering-herd on cache miss: only one coroutine fetches, others
# wait on the same asyncio.Event. Entries have timestamps for stale cleanup.


class InflightTracker:
    """Tracks in-flight cache-miss fetches with timeout and periodic sweep."""

    _WAIT_TIMEOUT = 15.0    # seconds to wait for an in-flight fetch
    _STALE_SECONDS = 30.0   # entries older than this are considered abandoned

    def __init__(self):
        self._inflight: dict[str, tuple[asyncio.Event, float]] = {}

    async def dedup_get(self, cache, key: str):
        """
        Cache-aware get with in-flight deduplication.

        - Cache hit  → return cached value immediately.
        - In-flight  → await the existing Event (with timeout), return cache result.
        - Cold       → insert a new Event in _inflight, return None. The caller
                       MUST call dedup_set(key) in a finally block.

        On timeout, we do NOT remove the in-flight entry — the original fetcher
        is still running and will call dedup_set() when done. Removing it here
        would break dedup: a new request would see no in-flight marker and start
        a duplicate fetch. The periodic sweep_stale() handles truly abandoned entries.
        """
        val = cache.get(key)
        if val is not None:
            return val

        entry = self._inflight.get(key)
        if entry is not None:
            event, _ = entry
            try:
                await asyncio.wait_for(event.wait(), timeout=self._WAIT_TIMEOUT)
            except asyncio.TimeoutError:
                logger.warning("In-flight wait timed out for key: %s (fetcher still running)", key)
            return cache.get(key)

        self._inflight[key] = (asyncio.Event(), time.monotonic())
        return None

    def dedup_set(self, key: str) -> None:
        """Unblock all coroutines waiting on key and remove the in-flight marker."""
        entry = self._inflight.pop(key, None)
        if entry:
            event, _ = entry
            event.set()

    def claim_inflight(self, key: str) -> bool:
        """
        Try to claim key as the sole background fetcher.
        Returns True if the caller should proceed, False if another coroutine
        already holds the slot. Used by stale-while-revalidate refresh.
        """
        if key in self._inflight:
            return False
        self._inflight[key] = (asyncio.Event(), time.monotonic())
        return True

    def sweep_stale(self) -> int:
        """Remove in-flight entries older than _STALE_SECONDS. Returns count removed."""
        now = time.monotonic()
        stale_keys = [
            k for k, (_, ts) in self._inflight.items()
            if (now - ts) > self._STALE_SECONDS
        ]
        for k in stale_keys:
            entry = self._inflight.pop(k, None)
            if entry:
                event, _ = entry
                event.set()  # unblock any waiters
        if stale_keys:
            logger.info("Swept %d stale in-flight entries", len(stale_keys))
        return len(stale_keys)

    def stats(self) -> dict:
        return {"active_keys": len(self._inflight)}


# Module-level singleton (attached to app.state during lifespan for testability)
inflight_tracker = InflightTracker()


# ---------------------------------------------------------------------------
# Convenience functions (thin wrappers for backwards compat)
# ---------------------------------------------------------------------------

async def dedup_get(cache, key: str):
    return await inflight_tracker.dedup_get(cache, key)


def dedup_set(key: str) -> None:
    inflight_tracker.dedup_set(key)


def claim_inflight(key: str) -> bool:
    return inflight_tracker.claim_inflight(key)


# ---------------------------------------------------------------------------
# Cache key and response helpers
# ---------------------------------------------------------------------------

def request_cache_key(request, prefix: Optional[str] = None, include_query: bool = False) -> str:
    path = getattr(getattr(request, "url", None), "path", None) or getattr(request, "path", "")
    key = f"{prefix}:{path}" if prefix else path

    if include_query:
        items = []
        if hasattr(request, "query_params"):
            items = list(request.query_params.multi_items())
        elif hasattr(request, "args"):
            items = list(request.args.items(multi=True))

        if items:
            query = urlencode(sorted((str(k), str(v)) for k, v in items), doseq=True)
            if query:
                return f"{key}?{query}"

    return key


def cache_json_response(cache, key: str, payload, status_code: int = 200, timeout: Optional[int] = None):
    cache.set(key, (payload, status_code), timeout=timeout)
    return payload, status_code


def cached_value_to_response(cached_value, default_status: int = 200):
    if cached_value is None:
        return None

    if isinstance(cached_value, tuple) and len(cached_value) == 2:
        payload, status = cached_value
    else:
        payload, status = cached_value, default_status

    return JSONResponse(content=payload, status_code=status)


def extract_vods_from_cached_response(cached_value):
    if cached_value is None:
        return []

    payload = cached_value[0] if isinstance(cached_value, tuple) and len(cached_value) == 2 else cached_value
    if not isinstance(payload, dict):
        return []

    data = payload.get("data", {})
    if isinstance(data, dict):
        vods = data.get("vods", [])
        if isinstance(vods, list):
            return vods

    return []


def extract_redirect_location(cached_value):
    if cached_value is None:
        return None

    if isinstance(cached_value, str):
        return cached_value

    if isinstance(cached_value, tuple) and len(cached_value) == 2:
        cached_value = cached_value[0]

    if hasattr(cached_value, "headers"):
        headers = getattr(cached_value, "headers", None)
        if headers is not None:
            location = headers.get("location")
            if location:
                return location

    if isinstance(cached_value, dict):
        for key in ("location", "source_url", "playback_url", "url"):
            location = cached_value.get(key)
            if location:
                return location

    return None


def extract_channel_data_from_live_cache(cached_value) -> Optional[dict]:
    """
    Extract the 'data' dict from a cached play_stream response.
    Returns None if the cache entry is absent or malformed.
    """
    if cached_value is None:
        return None
    payload = cached_value[0] if isinstance(cached_value, tuple) and len(cached_value) == 2 else cached_value
    if isinstance(payload, dict):
        return payload.get("data")
    return None
