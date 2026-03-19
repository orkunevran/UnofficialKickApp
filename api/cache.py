import asyncio
from typing import Optional
from urllib.parse import urlencode

from fastapi.responses import JSONResponse

# ---------------------------------------------------------------------------
# In-flight deduplication
# ---------------------------------------------------------------------------
# Keyed by cache key. When a cache miss is detected, the fetching coroutine
# inserts an Event here before awaiting the API call. Subsequent coroutines
# that see the same key wait on the Event instead of making their own API
# call (thundering-herd protection). Pure asyncio — single event loop only.
_inflight: dict[str, asyncio.Event] = {}


async def dedup_get(cache, key: str):
    """
    Cache-aware get with in-flight deduplication.

    - Cache hit  → return cached value immediately.
    - In-flight  → await the existing Event, return cache result (may be None
                   if the in-flight fetch failed; caller handles that).
    - Cold       → insert a new Event in _inflight, return None. The caller
                   MUST call dedup_set(key) in a finally block.
    """
    val = cache.get(key)
    if val is not None:
        return val
    if key in _inflight:
        await _inflight[key].wait()
        return cache.get(key)
    _inflight[key] = asyncio.Event()
    return None


def dedup_set(key: str) -> None:
    """Unblock all coroutines waiting on key and remove the in-flight marker."""
    event = _inflight.pop(key, None)
    if event:
        event.set()


def claim_inflight(key: str) -> bool:
    """
    Try to claim key as the sole background fetcher.
    Returns True if the caller should proceed (slot was free), False if another
    coroutine already holds the slot. Used by stale-while-revalidate refresh.
    """
    if key in _inflight:
        return False
    _inflight[key] = asyncio.Event()
    return True


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
    Allows go_to_live_stream and channel_avatar to piggyback on the live: key
    populated by play_stream and skip a redundant get_channel_data() call.
    """
    if cached_value is None:
        return None
    payload = cached_value[0] if isinstance(cached_value, tuple) and len(cached_value) == 2 else cached_value
    if isinstance(payload, dict):
        return payload.get("data")
    return None
