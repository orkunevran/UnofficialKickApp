"""Channel endpoints: /play, /go, /avatar, /clips."""

import asyncio
import contextlib
import logging
from typing import Union

from fastapi import APIRouter, Request, Response
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
from services.transformers import (
    build_channel_profile,
    normalize_clip_list,
    extract_thumbnail,
    extract_category_name,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/streams", tags=["streams"])


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
        "playback_url": f"/streams/m3u8/{channel_slug}.m3u8",
        "livestream_id": livestream_data.get("id"),
        "livestream_thumbnail_url": extract_thumbnail(livestream_data, profile_pic),
        "livestream_title": livestream_data.get("session_title"),
        "livestream_viewer_count": livestream_data.get("viewer_count"),
        "livestream_category": extract_category_name(livestream_data),
    }
    return {"status": "success", "message": "", "data": response_data}


async def _refresh_play_stream(
    cache,
    client,
    cb,
    stale_key: str,
    fresh_key: str,
    channel_slug: str,
    refresh_limiter: Union[asyncio.Semaphore, None] = None,
    thread_limiter: Union[asyncio.Semaphore, None] = None,
) -> None:
    """Refresh /streams/play cache in the background without blocking callers."""
    refresh_acquired = False
    try:
        if refresh_limiter is not None:
            try:
                await asyncio.wait_for(refresh_limiter.acquire(), timeout=Config.BACKGROUND_REFRESH_ACQUIRE_TIMEOUT_SECONDS)
                refresh_acquired = True
            except asyncio.TimeoutError:
                logger.info("Skipping live refresh for %s: background refresh limiter saturated.", stale_key)
                return

        limiter = thread_limiter if thread_limiter is not None else contextlib.nullcontext()
        async with limiter:
            data = await kick_call(
                client.get_channel_data,
                channel_slug,
                safe_value=channel_slug,
                circuit_breaker=cb,
                circuit_breaker_name="critical",
            )
        playback_url = data.get("playback_url")
        if playback_url:
            cache.set(f"live-url:{channel_slug}", playback_url, timeout=Config.LIVE_STALE_TTL_SECONDS)
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
        else:
            # Refresh-attempt cooldown: without this, every subsequent request
            # spawns another refresh while upstream is still down, spinning
            # DNS/TCP-connect failures. Stale data continues to be served.
            cache.set(fresh_key, True, timeout=Config.REFRESH_BACKOFF_SECONDS)
    except Exception as exc:
        logger.warning("Background refresh failed for %s: %s", stale_key, exc)
        cache.set(fresh_key, True, timeout=Config.REFRESH_BACKOFF_SECONDS)
    finally:
        if refresh_acquired and refresh_limiter is not None:
            refresh_limiter.release()
        dedup_set(stale_key)


@router.get("/play/{channel_slug}")
async def play_stream(
    request: Request,
    channel_slug: str,
    cache: CacheDep,
    client: KickClientDep,
    cb: CriticalCircuitBreakerDep,
):
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
            if cb.state == "open":
                # Breaker is open — don't burn DNS / TCP-connect attempts.
                # Hold off any refresh attempts until the breaker recovers.
                cache.set(fresh_key, True, timeout=Config.REFRESH_BACKOFF_SECONDS)
                dedup_set(stale_key)
            else:
                refresh_limiter = request.app.state.background_refresh_limiter
                thread_limiter = request.app.state.non_critical_thread_limiter
                asyncio.create_task(
                    _refresh_play_stream(
                        cache,
                        client,
                        cb,
                        stale_key,
                        fresh_key,
                        channel_slug,
                        refresh_limiter=refresh_limiter,
                        thread_limiter=thread_limiter,
                    )
                )
        return cached_value_to_response(stale_cached)

    cached = await dedup_get(cache, stale_key, wait_timeout=Config.LIVE_INFLIGHT_WAIT_TIMEOUT_SECONDS)
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
        playback_url = data.get("playback_url")
        if playback_url:
            cache.set(f"live-url:{channel_slug}", playback_url, timeout=Config.LIVE_STALE_TTL_SECONDS)
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

    # Redirect to the proxied .m3u8 master playlist
    return RedirectResponse(f"/streams/m3u8/{channel_slug}.m3u8", status_code=307)


@router.get("/m3u8/{channel_slug}.m3u8")
async def play_stream_m3u8(
    channel_slug: str,
    cache: CacheDep,
    client: KickClientDep,
    cb: CriticalCircuitBreakerDep,
):
    """Proxy the HLS master playlist to inject standard wildcard CORS headers.
    
    Sub-playlists and segment TS chunks served by AWS IVS already have wildcard CORS,
    so we only need to proxy this entry point.
    """
    if not validate_slug(channel_slug):
        return error_json(f"Invalid channel slug: '{channel_slug}'.", 400)

    url_key = f"live-url:{channel_slug}"
    playback_url = cache.get(url_key)

    if not playback_url:
        try:
            data = await kick_call(
                client.get_channel_data,
                channel_slug,
                safe_value=channel_slug,
                circuit_breaker=cb,
                circuit_breaker_name="critical",
            )
            playback_url = data.get("playback_url")
            if playback_url:
                cache.set(url_key, playback_url, timeout=Config.LIVE_STALE_TTL_SECONDS)
        except ApiError as exc:
            return error_json(exc.message, exc.status_code)
        except Exception as exc:
            logger.error("Failed to fetch channel data for proxying %s: %s", channel_slug, exc)
            return error_json("Failed to load channel stream data.", 502)

    if not playback_url:
        return error_json(f"Channel '{channel_slug}' is offline or has no playback URL.", 404)

    try:
        # Fetch the master playlist from AWS IVS.
        # Simulating Origin 'https://kick.com' guarantees the server returns the playlist.
        resp = await client.session.get(playback_url, headers={"Origin": "https://kick.com"}, timeout=5)
        resp.raise_for_status()

        return Response(
            content=resp.content,
            media_type="application/vnd.apple.mpegurl",
            headers={
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-cache, no-store, must-revalidate",
            },
        )
    except Exception as exc:
        logger.error("Failed to proxy master playlist for %s: %s", channel_slug, exc)
        return error_json("Failed to load stream playlist.", 502)


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
