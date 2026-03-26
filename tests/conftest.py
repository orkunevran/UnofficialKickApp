import pytest

from services.cache_service import cache


@pytest.fixture(autouse=True)
def clear_cache():
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def sample_api_data():
    live_channel = {
        "user": {
            "username": "live-user",
            "profile_pic": "https://img.example/live.png",
            "bio": "Live bio",
            "instagram": "live_insta",
            "twitter": "live_twitter",
            "youtube": "live_youtube",
            "discord": "live_discord",
            "tiktok": "live_tiktok",
        },
        "banner_image": {"url": "https://img.example/banner.png"},
        "followers_count": 4242,
        "verified": True,
        "subscription_enabled": True,
        "recent_categories": [{"name": "Just Chatting"}, {"name": "Gaming"}],
        "livestream": {
            "id": 9876,
            "thumbnail": {"src": "https://img.example/thumb.png"},
            "categories": [{"name": "Just Chatting"}],
            "session_title": "Live Session",
            "viewer_count": 321,
        },
        "playback_url": "https://cdn.example/live-user/master.m3u8",
    }

    offline_channel = dict(live_channel)
    offline_channel["livestream"] = None
    offline_channel["playback_url"] = None

    vods = [
        {
            "id": 42,
            "video": {"uuid": "vod-uuid-42", "views": 1337},
            "session_title": "VOD 42",
            "source": "https://cdn.example/vod-42.m3u8",
            "thumbnail": {"src": "https://img.example/vod-42.png"},
            "duration": 3600000,
            "created_at": "2026-01-01T00:00:00Z",
            "language": "en",
            "is_mature": False,
        }
    ]

    featured_stream = {
        "session_title": "Featured Live",
        "channel": {"user": {"username": "live-user"}},
        "viewer_count": 99,
        "categories": [{"name": "Just Chatting"}],
    }

    clips = {
        "clips": {
            "data": [
                {
                    "id": 7,
                    "title": "Highlight",
                    "clip_url": "https://cdn.example/clip-7",
                    "thumbnail_url": "https://img.example/clip-7.png",
                    "duration": 12,
                    "views": 123,
                    "category": {"name": "Just Chatting"},
                    "created_at": "2026-02-01T00:00:00Z",
                    "channel": {"slug": "live-user"},
                }
            ]
        }
    }

    return {
        "live_channel": live_channel,
        "offline_channel": offline_channel,
        "vods": vods,
        "featured_stream": featured_stream,
        "clips": clips,
        "search_results": [
            {
                "slug": "live-user",
                "username": "live-user",
                "followers_count": 4242,
                "is_live": True,
                "verified": True,
                "profile_picture": None,
            },
            {
                "slug": "offline-user",
                "username": "offline-user",
                "followers_count": 1111,
                "is_live": False,
                "verified": False,
                "profile_picture": None,
            },
        ],
        "viewer_count": 777,
        "devices": [{"name": "Living Room TV", "uuid": "device-1"}],
        "chromecast_status": {
            "status": "connected",
            "device_name": "Living Room TV",
            "is_playing": True,
        },
        "last_device": {"uuid": "device-1", "name": "Living Room TV"},
    }
