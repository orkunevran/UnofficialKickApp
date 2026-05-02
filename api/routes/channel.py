"""Channel endpoints: /play, /go, /avatar, /clips."""

import asyncio
import logging

from fastapi import APIRouter
from fastapi.responses import RedirectResponse

from api.cache import (
    cache_json_response,
    cached_value_to_response,
    claim_inflight,
    dedup_set,
    dedup_get,
    extract_channel_data_from_live_cache,
)
from api.deps import CacheDep, CriticalCircuitBreakerDep, KickClientDep, NonCriticalCircuitBreakerDep
from api.errors import ApiError, error_json, success_json
from api.routes._common import kick_call, validate_slug
from config import Config
from services.transformers import build_channel_profile, normalize_clip_list

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/streams", tags=["streams"])


def _extract_thumbnail(livestream_data: dict, fallback_pic: str | None) -> str | None:
    """Extract the best available thumbnail URL from livestream data.

    Priority: thumbnail.src → thumbnail.url → profile picture fallback.
    """
    thumb = livestream_data.get("thumbnail")
    if isinstance(thumb, dict):
        return thumb.get("src") or thumb.get("url") or fallback_pic
    return fallback_pic


def _extract_category_name(livestream_data: dict) -> str | None:
    """Safely extract the first category name from livestream data."""
    categories = livestream_data.get("categories")
    if isinstance(categories, list) and categories:
        first = categories[0]
        if isinstance(first, dict):
            return first.get("name")
    return None


def _build_play_stream_payload(data: dict, channel_slug: str) -> dict:
    """Build the standard success response payload for /streams/play."""
    profile = build_channel_profile(data, channel_slug)
    livestream_data = data.get("livestream")

    if livestream_data is None:
        return {
            "status": "success",
            "message": "",
            "data": {**profile, "status": "offline"},
        }

    playback_url = data.get("playback_url")
    if not playback_url:
        raise ApiError("Live playback URL not found in API response.", 500)

    profile_pic = data.get("user", {}).get("profile_pic")
    response_data = {
        **profile,
        "status": "live",
        "playback_url": playback_url,
        "livestream_id": livestream_data.get("id"),
        "livestream_thumbnail_url": _extract_thumbnail(livestream_data, profile_pic),
        "livestream_title": livestream_data.get("session_title"),
        "livestream_viewer_count": livestream_data.get("viewer_count"),
        "livestream_category": _extract_category_name(livestream_data),
    }
    return {"status": "success", "message": "", "data": response_data}


async def _refresh_play_stream(cache, client, cb, stale_key: str, fresh_key: str, channel_slug: str) -> None:
    """Refresh /streams/play cache in the background without blocking callers."""
    try:
        data = await kick_call(
            client.get_channel_data,
            channel_slug,
            safe_value=channel_slug,
            circuit_breaker=cb,
            circuit_breaker_name="critical",
        )
        payload = _build_play_stream_payload(data, channel_slug)
        cache_json_response(cache, stale_key, payload, 200, timeout=Config.LIVE_STALE_TTL_SECONDS)
        cache.set(fresh_key, True, timeout=Config.LIVE_CACHE_DURATION_SECONDS)
        logger.info("Background refresh complete for live stream data: %s", stale_key)
    except ApiError as exc:
        logger.warning("Background refresh failed for %s: %s", stale_key, exc.message)
        if exc.status_code == 404:
            err_payload = {"status": "error", "message": exc.message, "data": {}}
            cache.set(stale_key, (err_payload, exc.status_code), timeout=Config.NEGATIVE_CACHE_DURATION_SECONDS)
            cache.set(fresh_key, True, timeout=Config.NEGATIVE_CACHE_DURATION_SECONDS)
    except Exception as exc:
        logger.warning("Background refresh failed for %s: %s", stale_key, exc)
    finally:
        dedup_set(stale_key)


@router.get("/play/{channel_slug}")
async def play_stream(channel_slug: str, cache: CacheDep, client: KickClientDep, cb: CriticalCircuitBreakerDep):
    if not validate_slug(channel_slug):
        return error_json(f"Invalid channel slug: '{channel_slug}'.", 400)

    logger.info("Fetching live stream data for: %s", channel_slug)
    stale_key = f"live:/streams/play/{channel_slug}"
    fresh_key = f"live-fresh:/streams/play/{channel_slug}"

    stale_cached = cache.get(stale_key)
    fresh_cached = cache.get(fresh_key)

    if stale_cached is not None:
        if fresh_cached is not None:
            return cached_value_to_response(stale_cached)
        if claim_inflight(stale_key):
            asyncio.create_task(_refresh_play_stream(cache, client, cb, stale_key, fresh_key, channel_slug))
        return cached_value_to_response(stale_cached)

    cached = await dedup_get(cache, stale_key)
    if cached is not None:
        return cached_value_to_response(cached)

    try:
        data = await kick_call(
            client.get_channel_data,
            channel_slug,
            safe_value=channel_slug,
            circuit_breaker=cb,
            circuit_breaker_name="critical",
        )
        response_payload = _build_play_stream_payload(data, channel_slug)
        cache_json_response(cache, stale_key, response_payload, 200, timeout=Config.LIVE_STALE_TTL_SECONDS)
        cache.set(fresh_key, True, timeout=Config.LIVE_CACHE_DURATION_SECONDS)
        return cached_value_to_response((response_payload, 200))
    except ApiError as exc:
        if exc.status_code == 404:
            err_payload = {"status": "error", "message": exc.message, "data": {}}
            cache.set(stale_key, (err_payload, exc.status_code), timeout=Config.NEGATIVE_CACHE_DURATION_SECONDS)
            cache.set(fresh_key, True, timeout=Config.NEGATIVE_CACHE_DURATION_SECONDS)
        raise
    finally:
        dedup_set(stale_key)


@router.get("/go/{channel_slug}")
async def go_to_live_stream(channel_slug: str, cache: CacheDep, client: KickClientDep, cb: CriticalCircuitBreakerDep):
    if not validate_slug(channel_slug):
        return error_json(f"Invalid channel slug: '{channel_slug}'.", 400)

    key = f"live_redirect:/streams/go/{channel_slug}"
    try:
        logger.info("Fetching fresh live stream redirect for: %s", channel_slug)
        data = await kick_call(
            client.get_channel_data,
            channel_slug,
            safe_value=channel_slug,
            circuit_breaker=cb,
            circuit_breaker_name="critical",
        )
        livestream_data = data.get("livestream")

        if livestream_data is None:
            return error_json(f"Channel '{channel_slug}' is currently offline.", 404)

        playback_url = data.get("playback_url")
        if not playback_url:
            return error_json("Live playback URL not found in API response.", 500)

        # Do not cache the redirect to avoid stale HLS manifest tokens
        return RedirectResponse(playback_url, status_code=307)
    finally:
        dedup_set(key)


@router.get("/avatar/{channel_slug}")
async def channel_avatar(channel_slug: str, cache: CacheDep, client: KickClientDep, cb: NonCriticalCircuitBreakerDep):
    if not validate_slug(channel_slug):
        return error_json(f"Invalid channel slug: '{channel_slug}'.", 400)

    key = f"avatar:/streams/avatar/{channel_slug}"
    cached = cache.get(key)
    if cached is not None:
        return cached_value_to_response(cached)

    live_key = f"live:/streams/play/{channel_slug}"
    live_data = extract_channel_data_from_live_cache(cache.get(live_key))
    if live_data is not None and "profile_picture" in live_data:
        pic = live_data.get("profile_picture")
        payload = {"status": "success", "message": "", "data": {"profile_picture": pic}}
        cache_json_response(cache, key, payload, 200, timeout=Config.AVATAR_CACHE_DURATION_SECONDS)
        return success_json({"profile_picture": pic})

    data = await kick_call(
        client.get_channel_data,
        channel_slug,
        safe_value=channel_slug,
        circuit_breaker=cb,
        circuit_breaker_name="non_critical",
    )
    pic = data.get("user", {}).get("profile_pic")
    payload = {"status": "success", "message": "", "data": {"profile_picture": pic}}
    cache_json_response(cache, key, payload, 200, timeout=Config.AVATAR_CACHE_DURATION_SECONDS)
    return success_json({"profile_picture": pic})


@router.get("/clips/{channel_slug}")
async def channel_clips(channel_slug: str, cache: CacheDep, client: KickClientDep, cb: NonCriticalCircuitBreakerDep):
    if not validate_slug(channel_slug):
        return error_json(f"Invalid channel slug: '{channel_slug}'.", 400)

    key = f"clips:/streams/clips/{channel_slug}"
    cached = cache.get(key)
    if cached is not None:
        return cached_value_to_response(cached)

    logger.info("Fetching clips for channel: %s", channel_slug)
    raw = await kick_call(
        client.get_channel_clips,
        channel_slug,
        safe_value=channel_slug,
        circuit_breaker=cb,
        circuit_breaker_name="non_critical",
    )
    processed = normalize_clip_list(raw, channel_slug)
    payload = {"status": "success", "message": "", "data": {"clips": processed}}
    cache_json_response(cache, key, payload, 200, timeout=Config.VOD_CACHE_DURATION_SECONDS)
    return success_json({"clips": processed})
