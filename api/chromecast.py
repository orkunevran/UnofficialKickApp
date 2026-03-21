import asyncio
import logging
import re
from typing import Optional

from fastapi import APIRouter, Request

from api.errors import error_json, success_json
from api.schemas import ChromecastCastRequest, ChromecastSelectRequest, ChromecastStopRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/chromecast", tags=["chromecast"])


def _service(request: Request):
    return request.app.state.chromecast_service


def _parse_known_hosts(raw_value: Optional[str]):
    if not raw_value:
        return None
    hosts = [part.strip() for part in re.split(r"[,\s]+", raw_value) if part.strip()]
    return hosts or None


@router.get("/devices")
async def chromecast_devices(request: Request):
    logger.info("Received request to discover Chromecast devices.")
    force = request.query_params.get("force", "false").lower() == "true"
    known_hosts = _parse_known_hosts(request.query_params.get("known_hosts"))
    scanning = _service(request).scan_for_devices_async(force=force or bool(known_hosts), known_hosts=known_hosts)
    devices = _service(request).get_devices()
    logger.info("Returning %s devices (background scan: %s).", len(devices), scanning)
    return success_json({"devices": devices, "scanning": scanning or _service(request).is_scanning()})


@router.post("/select")
async def chromecast_select(request: Request):
    try:
        data = await request.json()
    except Exception:
        data = {}

    payload = ChromecastSelectRequest.model_validate(data if isinstance(data, dict) else {})
    uuid = payload.uuid
    if not uuid:
        return error_json("Device UUID is required.", 400)

    logger.info("Received request to select Chromecast device: %s", uuid)
    success, reason = await asyncio.to_thread(_service(request).select_device_with_timeout, uuid, timeout=15)
    if success:
        return success_json(message=f"Device {uuid} selected.")
    if reason == "scanning":
        return error_json("Device scan in progress. Please wait and try again.", 409)
    if reason == "busy":
        return error_json("Another device selection is in progress.", 409)
    return error_json(f"Device {uuid} not found or connection failed.", 404)


@router.post("/cast")
async def chromecast_cast(request: Request):
    try:
        data = await request.json()
    except Exception:
        data = {}

    payload = ChromecastCastRequest.model_validate(data if isinstance(data, dict) else {})
    stream_url = payload.stream_url
    title = payload.title or "Kick Stream"
    if not stream_url:
        return error_json("Stream URL is required.", 400)

    logger.info("Received request to cast stream: %s", stream_url)
    success = await asyncio.to_thread(_service(request).cast_stream, stream_url, title)
    if success:
        return success_json(message="Casting started.")
    return error_json("Failed to start casting.", 500)


@router.post("/stop")
async def chromecast_stop(request: Request):
    try:
        data = await request.json()
    except Exception:
        data = None

    if request.headers.get("content-length") and not data:
        logger.warning("Malformed JSON in /stop request body.")

    payload = ChromecastStopRequest.model_validate(data if isinstance(data, dict) else {}) if isinstance(data, dict) else ChromecastStopRequest()
    uuid = payload.uuid

    logger.info("Received request to stop casting (UUID: %s).", uuid if uuid else "None")
    success = await asyncio.to_thread(_service(request).stop_cast, uuid)
    if success:
        return success_json(message="Cast stopped.")
    return error_json("Failed to stop cast. No device was selected or the specified UUID was not found.", 404)


@router.get("/last-device")
async def chromecast_last_device(request: Request):
    device = _service(request).get_last_device()
    return success_json({"device": device})


@router.get("/status")
async def chromecast_status(request: Request):
    status = _service(request).get_status()
    return success_json(status)
