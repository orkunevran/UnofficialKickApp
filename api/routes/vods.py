"""VOD endpoints: /vods/{slug}, /vods/{slug}/{id}."""

import logging

from fastapi import APIRouter
from fastapi.responses import RedirectResponse

from api.cache import (
    cache_json_response,
    cached_value_to_response,
)
from api.deps import CacheDep, CircuitBreakerDep, KickClientDep
from api.errors import error_json, success_json
from api.routes._common import kick_call, validate_slug
from config import Config
from services.transformers import process_vod_data

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/streams", tags=["streams"])


@router.get("/vods/{channel_slug}")
async def list_vods(channel_slug: str, cache: CacheDep, client: KickClientDep, cb: CircuitBreakerDep):
    if not validate_slug(channel_slug):
        return error_json(f"Invalid channel slug: '{channel_slug}'.", 400)

    logger.info("Fetching VODs for: %s", channel_slug)
    key = f"vods:/streams/vods/{channel_slug}"
    cached = cache.get(key)
    if cached is not None:
        return cached_value_to_response(cached)

    raw_vod_data_list = await kick_call(client.get_channel_videos, channel_slug, safe_value=channel_slug, circuit_breaker=cb)
    processed_vods = process_vod_data(raw_vod_data_list)
    response_data = {"vods": processed_vods}
    payload = {"status": "success", "message": "", "data": response_data}
    cache_json_response(cache, key, payload, 200, timeout=Config.VOD_CACHE_DURATION_SECONDS)
    return success_json(response_data)


@router.get("/vods/{channel_slug}/{vod_id}")
async def play_vod_by_id(channel_slug: str, vod_id: int, cache: CacheDep, client: KickClientDep, cb: CircuitBreakerDep):
    if not validate_slug(channel_slug):
        return error_json(f"Invalid channel slug: '{channel_slug}'.", 400)

    if vod_id < 0 or vod_id > 2_147_483_647:
        return error_json("Invalid VOD ID.", 400)

    logger.info("Request to play VOD by ID: %s for channel: %s", vod_id, channel_slug)
    # Always fetch fresh VOD data to ensure the source_url token is not expired
    raw_vod_data_list = await kick_call(client.get_channel_videos, channel_slug, safe_value=channel_slug, circuit_breaker=cb)
    vod_data = process_vod_data(raw_vod_data_list)

    for vod_item in vod_data:
        if isinstance(vod_item, dict) and vod_item.get("vod_id") == vod_id:
            source = vod_item.get("source_url")
            if source:
                logger.info("Redirecting to fresh VOD source: %s", source)
                return RedirectResponse(source, status_code=307)

    logger.warning("VOD with ID %s not found for channel %s", vod_id, channel_slug)
    return error_json("VOD not found.", 404)
