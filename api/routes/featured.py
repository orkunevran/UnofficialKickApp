"""Featured livestreams endpoint with stale-while-revalidate caching."""

import asyncio
import logging

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from api.cache import (
    cached_value_to_response,
    claim_inflight,
    dedup_get,
    dedup_set,
    request_cache_key,
)
from api.deps import CacheDep, CircuitBreakerDep, KickClientDep
from api.routes._common import kick_call, SUBCATEGORY_RE
from config import Config
from services.transformers import build_featured_response, warm_caches_from_featured

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/streams", tags=["streams"])


async def _refresh_featured(
    cache,
    client,
    circuit_breaker,
    stale_key: str,
    fresh_key: str,
    language: str,
    page_int: int,
    category: str,
    subcategory: str,
    subcategories: str,
    sort: str,
    strict_bool: bool,
) -> None:
    """Background task: refresh the featured-streams cache without blocking the caller."""
    try:
        if category or subcategory or subcategories:
            raw = await kick_call(
                client.get_all_livestreams,
                language, page_int,
                category=category, subcategory=subcategory,
                subcategories=subcategories, sort=sort, strict=strict_bool,
                safe_value=language, circuit_breaker=circuit_breaker,
            )
        else:
            raw = await kick_call(client.get_featured_livestreams, language, page_int, safe_value=language, circuit_breaker=circuit_breaker)

        response_body = build_featured_response(raw, page_int)
        cache.set(stale_key, (response_body, 200), timeout=Config.FEATURED_STALE_TTL_SECONDS)
        cache.set(fresh_key, True, timeout=Config.FEATURED_CACHE_DURATION_SECONDS)
        warm_caches_from_featured(cache, response_body.get("data", []))
        logger.info("Background refresh complete for featured streams: %s", stale_key)
    except Exception as exc:
        logger.warning("Background refresh failed for %s: %s", stale_key, exc)
    finally:
        dedup_set(stale_key)


@router.get("/featured-livestreams")
async def featured_livestreams(
    request: Request,
    cache: CacheDep,
    client: KickClientDep,
    cb: CircuitBreakerDep,
    language: str = Query("en"),
    page: str = Query("1"),
    category: str = Query(""),
    subcategory: str = Query(""),
    subcategories: str = Query(""),
    sort: str = Query(""),
    strict: str = Query(""),
):
    valid_codes = [lang["code"] for lang in Config.FEATURED_LANGUAGES]
    if language not in valid_codes:
        language = Config.DEFAULT_LANGUAGE_CODE

    try:
        page_int = max(1, int(page))
    except (ValueError, TypeError):
        page_int = 1

    category = category.strip()
    subcategory = subcategory.strip()
    subcategories = subcategories.strip()
    sort = sort.strip().lower()
    strict_bool = strict.strip().lower() == "true"

    if category and not SUBCATEGORY_RE.match(category):
        category = ""
    if subcategory and not SUBCATEGORY_RE.match(subcategory):
        subcategory = ""
    if subcategories and not SUBCATEGORY_RE.match(subcategories):
        subcategories = ""
    if sort not in {"", "asc", "desc", "featured"}:
        sort = ""

    stale_key = request_cache_key(request, prefix="featured-livestreams", include_query=True)
    fresh_key  = request_cache_key(request, prefix="featured-fresh",        include_query=True)

    stale_cached = cache.get(stale_key)
    fresh_cached  = cache.get(fresh_key)

    _FEATURED_CACHE_CONTROL = {"Cache-Control": f"public, max-age={Config.FEATURED_CACHE_DURATION_SECONDS}"}

    if stale_cached is not None:
        if fresh_cached is not None:
            resp = cached_value_to_response(stale_cached)
            resp.headers.update(_FEATURED_CACHE_CONTROL)
            return resp
        if claim_inflight(stale_key):
            asyncio.create_task(_refresh_featured(
                cache, client, cb,
                stale_key, fresh_key,
                language, page_int, category, subcategory, subcategories, sort, strict_bool,
            ))
        resp = cached_value_to_response(stale_cached)
        resp.headers.update(_FEATURED_CACHE_CONTROL)
        return resp

    dedup_cached = await dedup_get(cache, stale_key)
    if dedup_cached is not None:
        resp = cached_value_to_response(dedup_cached)
        resp.headers.update(_FEATURED_CACHE_CONTROL)
        return resp

    try:
        if category or subcategory or subcategories:
            logger.info(
                "Fetching category-filtered livestreams: lang=%s, page=%s, category=%r, subcategory=%r, subcategories=%r, sort=%r, strict=%r",
                language, page_int, category, subcategory, subcategories, sort, strict_bool,
            )
            raw = await kick_call(
                client.get_all_livestreams,
                language, page_int,
                category=category, subcategory=subcategory,
                subcategories=subcategories, sort=sort, strict=strict_bool,
                safe_value=language, circuit_breaker=cb,
            )
        else:
            logger.info("Fetching featured livestreams for language: %s, page: %s", language, page_int)
            raw = await kick_call(client.get_featured_livestreams, language, page_int, safe_value=language, circuit_breaker=cb)

        response_body = build_featured_response(raw, page_int)
        cache.set(stale_key, (response_body, 200), timeout=Config.FEATURED_STALE_TTL_SECONDS)
        cache.set(fresh_key, True,                 timeout=Config.FEATURED_CACHE_DURATION_SECONDS)
        warm_caches_from_featured(cache, response_body.get("data", []))
        return JSONResponse(content=response_body, status_code=200, headers=_FEATURED_CACHE_CONTROL)
    finally:
        dedup_set(stale_key)
