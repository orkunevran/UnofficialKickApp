import asyncio
import copy

import httpx
import pytest

from app import app as fastapi_app
from services.chromecast_service import chromecast_service
from services.kick_api_service import kick_api_client


def _install_stubs(monkeypatch, sample_api_data):
    def fake_get_channel_data(channel_slug, timeout=8):
        if channel_slug == "offline-user":
            return copy.deepcopy(sample_api_data["offline_channel"])
        return copy.deepcopy(sample_api_data["live_channel"])

    def fake_get_channel_videos(channel_slug, timeout=10):
        return copy.deepcopy(sample_api_data["vods"])

    def fake_get_featured_livestreams(language="en", page=1, timeout=8):
        return {
            "data": [copy.deepcopy(sample_api_data["featured_stream"])],
            "current_page": page,
            "per_page": 14,
            "next_page_url": None if page >= 2 else "/next",
            "prev_page_url": None if page <= 1 else "/prev",
        }

    def fake_get_all_livestreams(
        language="en",
        page=1,
        category="",
        subcategory="",
        subcategories="",
        sort="",
        strict=False,
        timeout=10,
    ):
        stream = copy.deepcopy(sample_api_data["featured_stream"])
        stream["category"] = category or "Just Chatting"
        return {
            "data": [stream],
            "current_page": page,
            "per_page": 14,
            "next_page_url": None,
            "prev_page_url": None,
        }

    def fake_get_channel_clips(channel_slug, timeout=10):
        return copy.deepcopy(sample_api_data["clips"])

    def fake_search_channels_typesense(query, timeout=8):
        return copy.deepcopy(sample_api_data["search_results"])

    def fake_get_viewer_count(livestream_id, timeout=5):
        return sample_api_data["viewer_count"]

    def fake_get_viewer_counts_batch(livestream_ids, timeout=5):
        return {lid: 100 + lid for lid in livestream_ids}

    monkeypatch.setattr(kick_api_client, "get_channel_data", fake_get_channel_data)
    monkeypatch.setattr(kick_api_client, "get_channel_videos", fake_get_channel_videos)
    monkeypatch.setattr(kick_api_client, "get_featured_livestreams", fake_get_featured_livestreams)
    monkeypatch.setattr(kick_api_client, "get_all_livestreams", fake_get_all_livestreams)
    monkeypatch.setattr(kick_api_client, "get_channel_clips", fake_get_channel_clips)
    monkeypatch.setattr(kick_api_client, "search_channels_typesense", fake_search_channels_typesense)
    monkeypatch.setattr(kick_api_client, "get_viewer_count", fake_get_viewer_count)
    monkeypatch.setattr(kick_api_client, "get_viewer_counts_batch", fake_get_viewer_counts_batch)

    monkeypatch.setattr(chromecast_service, "configure", lambda config: None)
    monkeypatch.setattr(chromecast_service, "scan_for_devices_async", lambda force=False, known_hosts=None: False)
    monkeypatch.setattr(chromecast_service, "shutdown", lambda: None)
    monkeypatch.setattr(chromecast_service, "get_devices", lambda: copy.deepcopy(sample_api_data["devices"]))
    monkeypatch.setattr(chromecast_service, "is_scanning", lambda: False)
    monkeypatch.setattr(chromecast_service, "select_device_with_timeout", lambda uuid, timeout=15: (True, None))
    monkeypatch.setattr(chromecast_service, "cast_stream", lambda stream_url, title="Kick Stream": True)
    monkeypatch.setattr(chromecast_service, "stop_cast", lambda uuid=None: True)
    monkeypatch.setattr(chromecast_service, "get_last_device", lambda: copy.deepcopy(sample_api_data["last_device"]))
    monkeypatch.setattr(chromecast_service, "get_status", lambda: copy.deepcopy(sample_api_data["chromecast_status"]))


def _request_fastapi(method, path, params=None, json_body=None):
    async def _do_request():
        async with fastapi_app.router.lifespan_context(fastapi_app):
            transport = httpx.ASGITransport(app=fastapi_app, raise_app_exceptions=False)
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://testserver",
                follow_redirects=False,
            ) as client:
                kwargs = {}
                if params:
                    kwargs["params"] = params
                if json_body is not None:
                    kwargs["json"] = json_body
                return await client.request(method, path, **kwargs)

    return asyncio.run(_do_request())


def _response_body(response):
    if response.status_code in (301, 302, 303, 307, 308):
        return {"location": response.headers.get("location")}

    try:
        return response.json()
    except Exception:
        pass

    return response.text


def _channel_profile(data, channel_slug):
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
        "social_links": {
            key: user.get(key) or None
            for key in ("instagram", "twitter", "youtube", "discord", "tiktok")
        },
        "recent_categories": [
            category["name"]
            for category in (data.get("recent_categories") or [])
            if isinstance(category, dict) and category.get("name")
        ],
    }


def _process_vods(vod_data_list):
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


def _expected_response(method, path, params, json_body, sample_api_data):
    if path == "/config/languages":
        return {
            "languages": copy.deepcopy(fastapi_app.state.settings["FEATURED_LANGUAGES"]),
            "default_language": fastapi_app.state.settings["DEFAULT_LANGUAGE_CODE"],
        }

    if path == "/streams/play/live-user":
        channel_data = sample_api_data["live_channel"]
        profile = _channel_profile(channel_data, "live-user")
        livestream = channel_data["livestream"]
        return {
            "status": "success",
            "message": "",
            "data": {
                **profile,
                "status": "live",
                "playback_url": channel_data["playback_url"],
                "livestream_id": livestream["id"],
                "livestream_thumbnail_url": livestream["thumbnail"]["url"],
                "livestream_title": livestream["session_title"],
                "livestream_viewer_count": livestream["viewer_count"],
                "livestream_category": livestream["categories"][0]["name"],
            },
        }

    if path == "/streams/play/offline-user":
        channel_data = sample_api_data["offline_channel"]
        profile = _channel_profile(channel_data, "offline-user")
        return {
            "status": "success",
            "message": "",
            "data": {**profile, "status": "offline"},
        }

    if path == "/streams/vods/live-user":
        return {
            "status": "success",
            "message": "",
            "data": {"vods": _process_vods(sample_api_data["vods"])},
        }

    if path == "/streams/vods/live-user/42":
        return {"location": "https://cdn.example/vod-42.m3u8"}

    if path == "/streams/featured-livestreams":
        return {
            "status": "success",
            "message": "",
            "data": [copy.deepcopy(sample_api_data["featured_stream"])],
            "pagination": {
                "current_page": 2,
                "per_page": 14,
                "has_next": False,
                "has_prev": True,
            },
        }

    if path == "/streams/go/live-user":
        return {"location": "https://cdn.example/live-user/master.m3u8"}

    if path == "/streams/clips/live-user":
        return {
            "status": "success",
            "message": "",
            "data": {
                "clips": [
                    {
                        "clip_id": 7,
                        "title": "Highlight",
                        "clip_url": "https://cdn.example/clip-7",
                        "thumbnail_url": "https://img.example/clip-7.png",
                        "duration_seconds": 12,
                        "views": 123,
                        "category_name": "Just Chatting",
                        "created_at": "2026-02-01T00:00:00Z",
                        "channel_slug": "live-user",
                    }
                ]
            },
        }

    if path == "/streams/search":
        return {
            "status": "success",
            "message": "",
            "data": copy.deepcopy(sample_api_data["search_results"]),
        }

    if path == "/streams/avatar/live-user":
        return {
            "status": "success",
            "message": "",
            "data": {"profile_picture": "https://img.example/live.png"},
        }

    if path == "/streams/viewers":
        return {
            "status": "success",
            "message": "",
            "data": {"viewer_count": sample_api_data["viewer_count"]},
        }

    if path == "/streams/viewers/batch":
        # Stub returns {id: 100 + id} for each ID
        return {
            "status": "success",
            "message": "",
            "data": {"9876": 9976, "42": 142},
        }

    if path == "/api/chromecast/devices":
        return {
            "status": "success",
            "message": "",
            "data": {
                "devices": copy.deepcopy(sample_api_data["devices"]),
                "scanning": False,
            },
        }

    if path == "/api/chromecast/status":
        return {
            "status": "success",
            "message": "",
            "data": copy.deepcopy(sample_api_data["chromecast_status"]),
        }

    if path == "/api/chromecast/last-device":
        return {
            "status": "success",
            "message": "",
            "data": {"device": copy.deepcopy(sample_api_data["last_device"])},
        }

    if path == "/api/chromecast/select":
        return {
            "status": "success",
            "message": "Device device-1 selected.",
            "data": {},
        }

    if path == "/api/chromecast/cast":
        return {
            "status": "success",
            "message": "Casting started.",
            "data": {},
        }

    if path == "/api/chromecast/stop":
        return {
            "status": "success",
            "message": "Cast stopped.",
            "data": {},
        }

    raise AssertionError(f"Missing expected response for {method} {path}")


@pytest.fixture
def patched_app(monkeypatch, sample_api_data):
    _install_stubs(monkeypatch, sample_api_data)
    yield


@pytest.mark.parametrize(
    "method,path,params,json_body",
    [
        ("GET", "/config/languages", None, None),
        ("GET", "/streams/play/live-user", None, None),
        ("GET", "/streams/play/offline-user", None, None),
        ("GET", "/streams/vods/live-user", None, None),
        ("GET", "/streams/vods/live-user/42", None, None),
        ("GET", "/streams/featured-livestreams", {"language": "en", "page": "2"}, None),
        ("GET", "/streams/go/live-user", None, None),
        ("GET", "/streams/clips/live-user", None, None),
        ("GET", "/streams/search", {"q": "kick"}, None),
        ("GET", "/streams/avatar/live-user", None, None),
        ("GET", "/streams/viewers", {"id": "123"}, None),
        ("GET", "/streams/viewers/batch", {"ids": "9876,42"}, None),
        ("GET", "/api/chromecast/devices", None, None),
        ("GET", "/api/chromecast/devices", {"known_hosts": "192.168.1.10"}, None),
        ("GET", "/api/chromecast/status", None, None),
        ("GET", "/api/chromecast/last-device", None, None),
        ("POST", "/api/chromecast/select", None, {"uuid": "device-1"}),
        ("POST", "/api/chromecast/cast", None, {"stream_url": "https://cdn.example/live-user/master.m3u8", "title": "Kick Stream"}),
        ("POST", "/api/chromecast/stop", None, {"uuid": "device-1"}),
    ],
)
def test_fastapi_routes_match_expected_contract(
    patched_app,
    sample_api_data,
    method,
    path,
    params,
    json_body,
):
    response = _request_fastapi(method, path, params=params, json_body=json_body)

    assert response.status_code in (200, 307)
    assert _response_body(response) == _expected_response(method, path, params, json_body, sample_api_data)


@pytest.mark.parametrize(
    "method,path,params,json_body,expected_status,expected_body",
    [
        ("GET", "/streams/play/bad slug", None, None, 400, {"status": "error", "message": "Invalid channel slug: 'bad slug'.", "data": {}}),
        ("GET", "/streams/search", {"q": "a"}, None, 400, {"status": "error", "message": "Query must be at least 2 characters.", "data": {}}),
        ("GET", "/streams/viewers", {"id": "abc"}, None, 400, {"status": "error", "message": "Missing or invalid livestream ID.", "data": {}}),
        ("POST", "/api/chromecast/select", None, {}, 400, {"status": "error", "message": "Device UUID is required.", "data": {}}),
        ("POST", "/api/chromecast/cast", None, {}, 400, {"status": "error", "message": "Stream URL is required.", "data": {}}),
        ("GET", "/streams/viewers/batch", {"ids": "abc"}, None, 400, {"status": "error", "message": "Invalid ID list.", "data": {}}),
        ("GET", "/streams/viewers/batch", {"ids": ""}, None, 400, {"status": "error", "message": "Missing livestream IDs.", "data": {}}),
    ],
)
def test_validation_errors_match_expected_contract(
    patched_app,
    method,
    path,
    params,
    json_body,
    expected_status,
    expected_body,
):
    response = _request_fastapi(method, path, params=params, json_body=json_body)

    assert response.status_code == expected_status
    assert _response_body(response) == expected_body
