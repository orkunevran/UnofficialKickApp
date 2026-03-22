"""Tests for services/transformers.py — pure data transformation functions."""

from services.transformers import (
    build_channel_profile,
    build_featured_response,
    normalize_clip_list,
    process_vod_data,
)


class TestBuildChannelProfile:
    def test_full_profile(self):
        data = {
            "user": {
                "username": "streamer1",
                "profile_pic": "https://img.example/pic.png",
                "bio": "  Hello world  ",
                "instagram": "insta",
                "twitter": "twit",
                "youtube": "",
                "discord": None,
                "tiktok": "tt",
            },
            "banner_image": {"url": "https://img.example/banner.png"},
            "followers_count": 1000,
            "verified": True,
            "subscription_enabled": False,
            "recent_categories": [{"name": "Gaming"}, {"name": "IRL"}],
        }
        result = build_channel_profile(data, "streamer1")
        assert result["channel_slug"] == "streamer1"
        assert result["username"] == "streamer1"
        assert result["profile_picture"] == "https://img.example/pic.png"
        assert result["bio"] == "Hello world"
        assert result["verified"] is True
        assert result["social_links"]["instagram"] == "insta"
        assert result["social_links"]["youtube"] is None  # empty string -> None
        assert result["social_links"]["discord"] is None
        assert result["recent_categories"] == ["Gaming", "IRL"]

    def test_missing_user(self):
        result = build_channel_profile({}, "test-slug")
        assert result["username"] == "test-slug"
        assert result["profile_picture"] is None
        assert result["bio"] is None

    def test_empty_bio_becomes_none(self):
        result = build_channel_profile({"user": {"bio": "   "}}, "s")
        assert result["bio"] is None

    def test_banner_not_dict(self):
        result = build_channel_profile({"banner_image": "not a dict"}, "s")
        assert result["banner_image_url"] is None

    def test_malformed_recent_categories(self):
        data = {"recent_categories": [None, "string", {"no_name": True}, {"name": "OK"}]}
        result = build_channel_profile(data, "s")
        assert result["recent_categories"] == ["OK"]


class TestProcessVodData:
    def test_valid_vods(self):
        vods = [
            {
                "id": 1,
                "video": {"uuid": "abc", "views": 100},
                "session_title": "VOD 1",
                "source": "https://cdn/1.m3u8",
                "thumbnail": {"src": "https://img/1.png"},
                "duration": 60000,
                "created_at": "2026-01-01",
                "language": "en",
                "is_mature": False,
            }
        ]
        result = process_vod_data(vods)
        assert len(result) == 1
        assert result[0]["vod_id"] == 1
        assert result[0]["duration_seconds"] == 60.0

    def test_not_a_list(self):
        assert process_vod_data("not a list") == []
        assert process_vod_data(None) == []

    def test_skips_non_dict_items(self):
        result = process_vod_data([None, "string", {"id": 1}])
        assert len(result) == 1

    def test_missing_duration(self):
        result = process_vod_data([{"id": 1}])
        assert result[0]["duration_seconds"] is None


class TestNormalizeClipList:
    def test_nested_clips_dict(self):
        raw = {"clips": {"data": [{"id": 1, "title": "Clip 1", "duration": 10}]}}
        result = normalize_clip_list(raw, "ch")
        assert len(result) == 1
        assert result[0]["clip_id"] == 1
        assert result[0]["channel_slug"] == "ch"

    def test_flat_list(self):
        raw = [{"id": 2, "title": "Clip 2", "channel": {"slug": "other"}}]
        result = normalize_clip_list(raw, "default")
        assert result[0]["channel_slug"] == "other"

    def test_empty_input(self):
        assert normalize_clip_list(None, "ch") == []
        assert normalize_clip_list([], "ch") == []
        assert normalize_clip_list({}, "ch") == []

    def test_category_as_string(self):
        raw = [{"id": 1, "category": "Just Chatting"}]
        result = normalize_clip_list(raw, "ch")
        assert result[0]["category_name"] == "Just Chatting"

    def test_category_as_dict(self):
        raw = [{"id": 1, "category": {"name": "Gaming"}}]
        result = normalize_clip_list(raw, "ch")
        assert result[0]["category_name"] == "Gaming"


class TestBuildFeaturedResponse:
    def test_standard_response(self):
        raw = {
            "data": [{"id": 1}],
            "current_page": 2,
            "per_page": 14,
            "next_page_url": "/next",
            "prev_page_url": None,
        }
        result = build_featured_response(raw, 2)
        assert result["status"] == "success"
        assert len(result["data"]) == 1
        assert result["pagination"]["current_page"] == 2
        assert result["pagination"]["has_next"] is True
        assert result["pagination"]["has_prev"] is False

    def test_non_dict_input(self):
        result = build_featured_response("not a dict", 1)
        assert result["data"] == []
        assert result["pagination"]["has_next"] is False

    def test_missing_pagination_fields(self):
        result = build_featured_response({"data": []}, 3)
        assert result["pagination"]["current_page"] == 3
        assert result["pagination"]["per_page"] == 14
