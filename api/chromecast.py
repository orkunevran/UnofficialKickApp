import asyncio
import json
import logging
import re
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from api.deps import ChromecastDep
from api.errors import error_json, success_json
from api.schemas import ChromecastCastRequest, ChromecastSelectRequest, ChromecastStopRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/chromecast", tags=["chromecast"])


_HOST_RE = re.compile(r"^[a-zA-Z0-9._:-]{1,255}$")


def _parse_known_hosts(raw_value: Optional[str]):
    if not raw_value:
        return None
    hosts = []
    for part in re.split(r"[,\s]+", raw_value):
        part = part.strip()
        if not part:
            continue
        if _HOST_RE.match(part):
            hosts.append(part)
        else:
            logger.warning("Ignoring invalid known_hosts entry: %s", part)
    return hosts or None


@router.get("/devices")
async def chromecast_devices(service: ChromecastDep, force: str = "false", known_hosts: Optional[str] = None):
    force_bool = force.lower() == "true"
    parsed_hosts = _parse_known_hosts(known_hosts)
    if force_bool or parsed_hosts:
        logger.info("Chromecast device discovery requested (force=%s, known_hosts=%s).", force_bool, parsed_hosts)
    scanning = service.scan_for_devices_async(force=force_bool or bool(parsed_hosts), known_hosts=parsed_hosts)
    devices = service.get_devices()
    logger.debug("Returning %s devices (background scan: %s).", len(devices), scanning)
    return success_json({"devices": devices, "scanning": scanning or service.is_scanning()})


@router.post("/select")
async def chromecast_select(service: ChromecastDep, payload: ChromecastSelectRequest):
    uuid = payload.uuid
    if not uuid:
        return error_json("Device UUID is required.", 400)

    logger.info("Received request to select Chromecast device: %s", uuid)
    success, reason = await asyncio.to_thread(service.select_device_with_timeout, uuid, timeout=15)
    if success:
        return success_json(message=f"Device {uuid} selected.")
    if reason == "scanning":
        return error_json("Device scan in progress. Please wait and try again.", 409)
    if reason == "busy":
        return error_json("Another device selection is in progress.", 409)
    return error_json(f"Device {uuid} not found or connection failed.", 404)


@router.post("/cast")
async def chromecast_cast(service: ChromecastDep, payload: ChromecastCastRequest):
    stream_url = payload.stream_url
    title = payload.title or "Kick Stream"
    if not stream_url:
        return error_json("Stream URL is required.", 400)

    logger.info("Received request to cast stream: %s", stream_url)
    success = await asyncio.to_thread(service.cast_stream, stream_url, title)
    if success:
        return success_json(message="Casting started.")
    return error_json("Failed to start casting.", 500)


@router.post("/stop")
async def chromecast_stop(service: ChromecastDep, payload: ChromecastStopRequest = ChromecastStopRequest()):
    uuid = payload.uuid
    logger.info("Received request to stop casting (UUID: %s).", uuid if uuid else "None")
    success = await asyncio.to_thread(service.stop_cast, uuid)
    if success:
        return success_json(message="Cast stopped.")
    return error_json("Failed to stop cast. No device was selected or the specified UUID was not found.", 404)


@router.get("/last-device")
async def chromecast_last_device(service: ChromecastDep):
    device = service.get_last_device()
    return success_json({"device": device})


@router.get("/status")
async def chromecast_status(service: ChromecastDep):
    status = service.get_status()
    return success_json(status)


@router.get("/status/stream")
async def chromecast_status_stream(request: Request, service: ChromecastDep):
    """Server-Sent Events endpoint for live Chromecast status updates.

    Replaces polling — the frontend opens a single EventSource connection
    and receives status pushes every 3 seconds. Falls back to the regular
    /status endpoint if SSE is not supported.
    """

    async def event_generator():
        try:
            while True:
                # Check if client disconnected
                if await request.is_disconnected():
                    break
                status = service.get_status()
                data = json.dumps({"status": "success", "message": "", "data": status})
                yield f"data: {data}\n\n"
                await asyncio.sleep(3)
        except asyncio.CancelledError:
            pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
