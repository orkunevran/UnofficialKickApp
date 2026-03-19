from typing import Optional
from urllib.parse import urlencode

from fastapi.responses import JSONResponse


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
