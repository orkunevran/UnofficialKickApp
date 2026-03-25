"""Discovery endpoints: /search, /viewers, /viewers/batch."""

import logging

from fastapi import APIRouter, Query, Request

from api.cache import cache_json_response, cached_value_to_response, request_cache_key
from api.deps import CacheDep, CircuitBreakerDep, KickClientDep
from api.errors import error_json, sanitize_log_value, success_json
from api.routes._common import kick_call
from config import Config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/streams", tags=["streams"])


@router.get("/search")
async def channel_search(request: Request, cache: CacheDep, client: KickClientDep, cb: CircuitBreakerDep, q: str = Query("")):
    query = q.strip()
    if not query or len(query) < 2:
        return error_json("Query must be at least 2 characters.", 400)
    if len(query) > 100:
        return error_json("Query too long.", 400)

    key = request_cache_key(request, prefix="search", include_query=True)
    cached = cache.get(key)
    if cached is not None:
        return cached_value_to_response(cached)

    logger.info("Searching channels with query: %s", sanitize_log_value(query))
    results = await kick_call(client.search_channels_typesense, query, safe_value=query, circuit_breaker=cb)
    payload = {"status": "success", "message": "", "data": results}
    cache_json_response(cache, key, payload, 200, timeout=Config.SEARCH_CACHE_DURATION_SECONDS)
    return success_json(results)


@router.get("/viewers")
async def viewer_count(request: Request, cache: CacheDep, client: KickClientDep, cb: CircuitBreakerDep, id: str = Query("")):
    try:
        livestream_id = int(id)
    except (ValueError, TypeError):
        return error_json("Missing or invalid livestream ID.", 400)

    if livestream_id <= 0:
        return error_json("Invalid livestream ID.", 400)

    key = request_cache_key(request, prefix="viewers", include_query=True)
    cached = cache.get(key)
    if cached is not None:
        return cached_value_to_response(cached)

    viewers = await kick_call(client.get_viewer_count, livestream_id, safe_value=str(livestream_id), circuit_breaker=cb)
    payload = {"status": "success", "message": "", "data": {"viewer_count": viewers}}
    cache_json_response(cache, key, payload, 200, timeout=Config.VIEWER_CACHE_DURATION_SECONDS)
    return success_json({"viewer_count": viewers})


@router.get("/viewers/batch")
async def viewer_count_batch(
    request: Request, cache: CacheDep, client: KickClientDep, cb: CircuitBreakerDep,
    ids: str = Query(""),
):
    """Batch viewer count — single upstream call for multiple livestream IDs.

    Query: ``?ids=101621100,101647164,...`` (comma-separated, max 50).
    Returns ``{ "status": "success", "data": { "101621100": 1044, ... } }``.
    """
    raw_ids = [s.strip() for s in ids.split(",") if s.strip()]
    int_ids: list[int] = []
    for raw in raw_ids:
        try:
            val = int(raw)
        except (ValueError, TypeError):
            return error_json("Invalid ID list.", 400)
        if val > 0:
            int_ids.append(val)

    if not int_ids:
        return error_json("Missing livestream IDs.", 400)
    int_ids = int_ids[:50]

    key = f"viewers-batch:{','.join(str(i) for i in sorted(int_ids))}"
    cached = cache.get(key)
    if cached is not None:
        return cached_value_to_response(cached)

    counts = await kick_call(
        client.get_viewer_counts_batch, int_ids, safe_value="batch", circuit_breaker=cb,
    )
    data = {str(k): v for k, v in counts.items()}
    payload = {"status": "success", "message": "", "data": data}
    cache_json_response(cache, key, payload, 200, timeout=Config.VIEWER_CACHE_DURATION_SECONDS)
    return success_json(data)
