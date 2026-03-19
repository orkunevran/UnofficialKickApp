import asyncio
import logging
import re
from typing import Any, Optional

import requests
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse

from api.cache import (
    cache_json_response,
    cached_value_to_response,
    claim_inflight,
    dedup_get,
    dedup_set,
    extract_channel_data_from_live_cache,
    extract_redirect_location,
    extract_vods_from_cached_response,
    request_cache_key,
)
from api.errors import ApiError, error_json, requests_exception_to_api_error, success_json, sanitize_log_value
from config import Config

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/streams", tags=["streams"])

_SLUG_RE = re.compile(r"^[a-zA-Z0-9_-]{1,255}$")
_SUBCATEGORY_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9 &.:_()\-]{0,99}$")


def _validate_slug(slug: Optional[str]) -> bool:
    return bool(slug and _SLUG_RE.match(slug))


def _build_channel_profile(data: dict[str, Any], channel_slug: str) -> dict[str, Any]:
    user = data.get("user") or {}
    banner = data.get("banner_image")
    return {
        "channel_slug": channel_slug,
        "username": user.get("username") or channel_slug,
        "profile_picture": user.get("profile_pic"),
        "banner_image_url": banner.get("url") if isinstance(banner, dict) else None,
        "bio": (user.get("bio") or "").strip() or None,
        "followers_count": data.get("followers_count"),
        "verified": bool(data.get("verified")),
        "subscription_enabled": bool(data.get("subscription_enabled")),
        "social_links": {k: user.get(k) or None for k in ("instagram", "twitter", "youtube", "discord", "tiktok")},
        "recent_categories": [
            c["name"] for c in (data.get("recent_categories") or [])
            if isinstance(c, dict) and c.get("name")
        ],
    }


def _process_vod_data(vod_data_list: Any) -> list[dict[str, Any]]:
    if not isinstance(vod_data_list, list):
        return []

    return [
        {
            "vod_id": vod.get("id"),
            "video_uuid": vod.get("video", {}).get("uuid"),
            "title": vod.get("session_title"),
            "source_url": vod.get("source"),
            "thumbnail_url": vod.get("thumbnail", {}).get("src"),
            "views": vod.get("video", {}).get("views"),
            "duration_seconds": vod.get("duration") / 1000.0 if isinstance(vod.get("duration"), (int, float)) else None,
            "created_at": vod.get("created_at"),
            "language": vod.get("language"),
            "is_mature": vod.get("is_mature"),
        }
        for vod in vod_data_list
        if isinstance(vod, dict)
    ]


def _normalize_clip_list(raw: Any, channel_slug: str) -> list[dict[str, Any]]:
    clip_list = []
    if isinstance(raw, dict):
        clips_obj = raw.get("clips", raw)
        if isinstance(clips_obj, dict):
            clip_list = clips_obj.get("data", [])
        elif isinstance(clips_obj, list):
            clip_list = clips_obj
    elif isinstance(raw, list):
        clip_list = raw

    return [
        {
            "clip_id": c.get("id"),
            "title": c.get("title"),
            "clip_url": c.get("clip_url") or c.get("video_url"),
            "thumbnail_url": c.get("thumbnail_url"),
            "duration_seconds": c.get("duration"),
            "views": c.get("views"),
            "category_name": c.get("category", {}).get("name") if isinstance(c.get("category"), dict) else c.get("category"),
            "created_at": c.get("created_at"),
            "channel_slug": c.get("channel", {}).get("slug") if isinstance(c.get("channel"), dict) else channel_slug,
        }
        for c in clip_list
        if isinstance(c, dict)
    ]


def _cache(request: Request):
    return request.app.state.cache


def _client(request: Request):
    return request.app.state.kick_api_client


async def _kick_call(func, *args, safe_value: str = "unknown", **kwargs):
    try:
        return await asyncio.to_thread(func, *args, **kwargs)
    except requests.exceptions.RequestException as exc:
        raise requests_exception_to_api_error(exc, safe_value) from exc


def _build_featured_response(raw: Any, page_int: int) -> dict:
    """Build the featured-livestreams response body from a raw Kick API response."""
    streams = raw.get("data", []) if isinstance(raw, dict) else []
    pagination = {
        "current_page": raw.get("current_page", page_int) if isinstance(raw, dict) else page_int,
        "per_page": raw.get("per_page", 14) if isinstance(raw, dict) else 14,
        "has_next": raw.get("next_page_url") is not None if isinstance(raw, dict) else False,
        "has_prev": raw.get("prev_page_url") is not None if isinstance(raw, dict) else False,
    }
    return {"status": "success", "message": "", "data": streams, "pagination": pagination}


async def _refresh_featured(
    cache,
    client,
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
    """
    Background task: refresh the featured-streams cache without blocking the caller.
    Cleans up the _inflight slot via dedup_set() regardless of success or failure.
    """
    try:
        if category or subcategory or subcategories:
            raw = await _kick_call(
                client.get_all_livestreams,
                language, page_int,
                category=category, subcategory=subcategory,
                subcategories=subcategories, sort=sort, strict=strict_bool,
                safe_value=language,
            )
        else:
            raw = await _kick_call(client.get_featured_livestreams, language, page_int, safe_value=language)

        response_body = _build_featured_response(raw, page_int)
        cache.set(stale_key, (response_body, 200), timeout=Config.FEATURED_STALE_TTL_SECONDS)
        cache.set(fresh_key, True, timeout=Config.FEATURED_CACHE_DURATION_SECONDS)
        logger.info("Background refresh complete for featured streams: %s", stale_key)
    except Exception as exc:
        logger.warning("Background refresh failed for %s: %s", stale_key, exc)
    finally:
        dedup_set(stale_key)


@router.get("/play/{channel_slug}")
async def play_stream(channel_slug: str, request: Request):
    if not _validate_slug(channel_slug):
        return error_json(f"Invalid channel slug: '{channel_slug}'.", 400)

    logger.info("Fetching live stream data for: %s", channel_slug)
    key = request_cache_key(request, prefix="live")
    cached = await dedup_get(_cache(request), key)
    if cached is not None:
        return cached_value_to_response(cached)

    try:
        data = await _kick_call(_client(request).get_channel_data, channel_slug, safe_value=channel_slug)
        profile = _build_channel_profile(data, channel_slug)
        livestream_data = data.get("livestream")

        if livestream_data is None:
            payload = {**profile, "status": "offline"}
            response_payload = {"status": "success", "message": "", "data": payload}
            cache_json_response(_cache(request), key, response_payload, 200, timeout=Config.LIVE_CACHE_DURATION_SECONDS)
            return success_json(payload)

        playback_url = data.get("playback_url")
        if not playback_url:
            return error_json("Live playback URL not found in API response.", 500)

        thumbnail = livestream_data.get("thumbnail")
        categories = livestream_data.get("categories")
        profile_pic = data.get("user", {}).get("profile_pic")

        response_data = {
            **profile,
            "status": "live",
            "playback_url": playback_url,
            "livestream_id": livestream_data.get("id"),
            "livestream_thumbnail_url": (thumbnail.get("url") if thumbnail else None) or profile_pic,
            "livestream_title": livestream_data.get("session_title"),
            "livestream_viewer_count": livestream_data.get("viewer_count"),
            "livestream_category": categories[0].get("name") if categories else None,
        }
        payload = {"status": "success", "message": "", "data": response_data}
        cache_json_response(_cache(request), key, payload, 200, timeout=Config.LIVE_CACHE_DURATION_SECONDS)
        return success_json(response_data)
    except ApiError as exc:
        # Cache error responses briefly so repeated requests for invalid/rate-limited
        # slugs don't hammer Kick's API on every call.
        if exc.status_code in (404, 429):
            err_payload = {"status": "error", "message": exc.message, "data": {}}
            _cache(request).set(key, (err_payload, exc.status_code), timeout=Config.NEGATIVE_CACHE_DURATION_SECONDS)
        raise
    finally:
        dedup_set(key)


@router.get("/vods/{channel_slug}")
async def list_vods(channel_slug: str, request: Request):
    if not _validate_slug(channel_slug):
        return error_json(f"Invalid channel slug: '{channel_slug}'.", 400)

    logger.info("Fetching VODs for: %s", channel_slug)
    key = request_cache_key(request, prefix="vods")
    cached = _cache(request).get(key)
    if cached is not None:
        return cached_value_to_response(cached)

    raw_vod_data_list = await _kick_call(_client(request).get_channel_videos, channel_slug, safe_value=channel_slug)
    processed_vods = _process_vod_data(raw_vod_data_list)
    response_data = {"vods": processed_vods}
    payload = {"status": "success", "message": "", "data": response_data}
    cache_json_response(_cache(request), key, payload, 200, timeout=Config.VOD_CACHE_DURATION_SECONDS)
    return success_json(response_data)


@router.get("/vods/{channel_slug}/{vod_id}")
async def play_vod_by_id(channel_slug: str, vod_id: int, request: Request):
    if not _validate_slug(channel_slug):
        return error_json(f"Invalid channel slug: '{channel_slug}'.", 400)

    if vod_id < 0 or vod_id > 2_147_483_647:
        return error_json("Invalid VOD ID.", 400)

    logger.info("Request to play VOD by ID: %s for channel: %s", vod_id, channel_slug)
    redirect_key = f"vod:{channel_slug}:{vod_id}"
    cached_redirect = _cache(request).get(redirect_key)
    redirect_url = extract_redirect_location(cached_redirect)
    if redirect_url:
        return RedirectResponse(redirect_url, status_code=307)

    cached_vods_key = f"vods:/streams/vods/{channel_slug}"
    cached_vods = _cache(request).get(cached_vods_key)
    vod_data = extract_vods_from_cached_response(cached_vods)

    if not vod_data:
        raw_vod_data_list = await _kick_call(_client(request).get_channel_videos, channel_slug, safe_value=channel_slug)
        vod_data = _process_vod_data(raw_vod_data_list)

    for vod_item in vod_data:
        if isinstance(vod_item, dict) and vod_item.get("vod_id") == vod_id:
            source = vod_item.get("source_url")
            if source:
                _cache(request).set(redirect_key, source, timeout=Config.VOD_CACHE_DURATION_SECONDS)
                logger.info("Redirecting to VOD source: %s", source)
                return RedirectResponse(source, status_code=307)

    logger.warning("VOD with ID %s not found for channel %s", vod_id, channel_slug)
    return error_json("VOD not found.", 404)


@router.get("/featured-livestreams")
async def featured_livestreams(
    request: Request,
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

    if category and not _SUBCATEGORY_RE.match(category):
        category = ""
    if subcategory and not _SUBCATEGORY_RE.match(subcategory):
        subcategory = ""
    if subcategories and not _SUBCATEGORY_RE.match(subcategories):
        subcategories = ""
    if sort not in {"", "asc", "desc", "featured"}:
        sort = ""

    stale_key = request_cache_key(request, prefix="featured-livestreams", include_query=True)
    fresh_key  = request_cache_key(request, prefix="featured-fresh",        include_query=True)

    stale_cached = _cache(request).get(stale_key)
    fresh_cached  = _cache(request).get(fresh_key)

    if stale_cached is not None:
        if fresh_cached is not None:
            # Data is fully fresh — return immediately, no API call needed
            return cached_value_to_response(stale_cached)
        # Data is stale but usable — serve it and trigger exactly one background refresh
        if claim_inflight(stale_key):
            asyncio.create_task(_refresh_featured(
                _cache(request), _client(request),
                stale_key, fresh_key,
                language, page_int, category, subcategory, subcategories, sort, strict_bool,
            ))
        return cached_value_to_response(stale_cached)

    # Cold cache — fetch synchronously with in-flight dedup so concurrent requests
    # don't all hit Kick simultaneously
    dedup_cached = await dedup_get(_cache(request), stale_key)
    if dedup_cached is not None:
        return cached_value_to_response(dedup_cached)

    try:
        if category or subcategory or subcategories:
            logger.info(
                "Fetching category-filtered livestreams: lang=%s, page=%s, category=%r, subcategory=%r, subcategories=%r, sort=%r, strict=%r",
                language, page_int, category, subcategory, subcategories, sort, strict_bool,
            )
            raw = await _kick_call(
                _client(request).get_all_livestreams,
                language, page_int,
                category=category, subcategory=subcategory,
                subcategories=subcategories, sort=sort, strict=strict_bool,
                safe_value=language,
            )
        else:
            logger.info("Fetching featured livestreams for language: %s, page: %s", language, page_int)
            raw = await _kick_call(_client(request).get_featured_livestreams, language, page_int, safe_value=language)

        response_body = _build_featured_response(raw, page_int)
        _cache(request).set(stale_key, (response_body, 200), timeout=Config.FEATURED_STALE_TTL_SECONDS)
        _cache(request).set(fresh_key, True,                 timeout=Config.FEATURED_CACHE_DURATION_SECONDS)
        return JSONResponse(content=response_body, status_code=200)
    finally:
        dedup_set(stale_key)


@router.get("/go/{channel_slug}")
async def go_to_live_stream(channel_slug: str, request: Request):
    if not _validate_slug(channel_slug):
        return error_json(f"Invalid channel slug: '{channel_slug}'.", 400)

    key = request_cache_key(request, prefix="live_redirect")
    cached = _cache(request).get(key)
    redirect_url = extract_redirect_location(cached)
    if redirect_url:
        return RedirectResponse(redirect_url, status_code=307)

    # Piggyback on play_stream's live: cache to avoid a duplicate API call
    live_key = f"live:/streams/play/{channel_slug}"
    live_data = extract_channel_data_from_live_cache(_cache(request).get(live_key))
    if live_data is not None:
        if live_data.get("status") == "offline":
            return error_json(f"Channel '{channel_slug}' is currently offline.", 404)
        playback_url = live_data.get("playback_url")
        if playback_url:
            _cache(request).set(key, playback_url, timeout=Config.LIVE_CACHE_DURATION_SECONDS)
            return RedirectResponse(playback_url, status_code=307)

    logger.info("Fetching live stream redirect for: %s", channel_slug)
    data = await _kick_call(_client(request).get_channel_data, channel_slug, safe_value=channel_slug)
    livestream_data = data.get("livestream")

    if livestream_data is None:
        return error_json(f"Channel '{channel_slug}' is currently offline.", 404)

    playback_url = data.get("playback_url")
    if not playback_url:
        return error_json("Live playback URL not found in API response.", 500)

    _cache(request).set(key, playback_url, timeout=Config.LIVE_CACHE_DURATION_SECONDS)
    return RedirectResponse(playback_url, status_code=307)


@router.get("/clips/{channel_slug}")
async def channel_clips(channel_slug: str, request: Request):
    if not _validate_slug(channel_slug):
        return error_json(f"Invalid channel slug: '{channel_slug}'.", 400)

    key = request_cache_key(request, prefix="clips")
    cached = _cache(request).get(key)
    if cached is not None:
        return cached_value_to_response(cached)

    logger.info("Fetching clips for channel: %s", channel_slug)
    raw = await _kick_call(_client(request).get_channel_clips, channel_slug, safe_value=channel_slug)
    processed = _normalize_clip_list(raw, channel_slug)
    payload = {"status": "success", "message": "", "data": {"clips": processed}}
    cache_json_response(_cache(request), key, payload, 200, timeout=Config.VOD_CACHE_DURATION_SECONDS)
    return success_json({"clips": processed})


@router.get("/search")
async def channel_search(request: Request, q: str = Query("")):
    query = q.strip()
    if not query or len(query) < 2:
        return error_json("Query must be at least 2 characters.", 400)
    if len(query) > 100:
        return error_json("Query too long.", 400)

    key = request_cache_key(request, prefix="search", include_query=True)
    cached = _cache(request).get(key)
    if cached is not None:
        return cached_value_to_response(cached)

    logger.info("Searching channels with query: %s", sanitize_log_value(query))
    results = await _kick_call(_client(request).search_channels_typesense, query, safe_value=query)
    payload = {"status": "success", "message": "", "data": results}
    cache_json_response(_cache(request), key, payload, 200, timeout=Config.SEARCH_CACHE_DURATION_SECONDS)
    return success_json(results)


@router.get("/avatar/{channel_slug}")
async def channel_avatar(channel_slug: str, request: Request):
    if not _validate_slug(channel_slug):
        return error_json(f"Invalid channel slug: '{channel_slug}'.", 400)

    key = request_cache_key(request, prefix="avatar")
    cached = _cache(request).get(key)
    if cached is not None:
        return cached_value_to_response(cached)

    # Piggyback on play_stream's live: cache to avoid a duplicate API call
    live_key = f"live:/streams/play/{channel_slug}"
    live_data = extract_channel_data_from_live_cache(_cache(request).get(live_key))
    if live_data is not None and "profile_picture" in live_data:
        pic = live_data.get("profile_picture")
        payload = {"status": "success", "message": "", "data": {"profile_picture": pic}}
        cache_json_response(_cache(request), key, payload, 200, timeout=Config.AVATAR_CACHE_DURATION_SECONDS)
        return success_json({"profile_picture": pic})

    data = await _kick_call(_client(request).get_channel_data, channel_slug, safe_value=channel_slug)
    pic = data.get("user", {}).get("profile_pic")
    payload = {"status": "success", "message": "", "data": {"profile_picture": pic}}
    cache_json_response(_cache(request), key, payload, 200, timeout=Config.AVATAR_CACHE_DURATION_SECONDS)
    return success_json({"profile_picture": pic})


@router.get("/viewers")
async def viewer_count(request: Request, id: str = Query("")):
    try:
        livestream_id = int(id)
    except (ValueError, TypeError):
        return error_json("Missing or invalid livestream ID.", 400)

    if livestream_id <= 0:
        return error_json("Invalid livestream ID.", 400)

    key = request_cache_key(request, prefix="viewers", include_query=True)
    cached = _cache(request).get(key)
    if cached is not None:
        return cached_value_to_response(cached)

    viewers = await _kick_call(_client(request).get_viewer_count, livestream_id, safe_value=str(livestream_id))
    payload = {"status": "success", "message": "", "data": {"viewer_count": viewers}}
    cache_json_response(_cache(request), key, payload, 200, timeout=Config.VIEWER_CACHE_DURATION_SECONDS)
    return success_json({"viewer_count": viewers})
