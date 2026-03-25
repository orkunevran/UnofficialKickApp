"""Pure data transformation functions for Kick API responses.

These functions convert raw Kick API response shapes into the stable
response format that the frontend expects.  They are deliberately free
of any HTTP or caching dependencies so they can be unit-tested in
isolation.
"""

from typing import Any

from config import Config


# ── Channel profile ──────────────────────────────────────────────────

def build_channel_profile(data: dict[str, Any], channel_slug: str) -> dict[str, Any]:
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


# ── VOD processing ──────────────────────────────────────────────────

def process_vod_data(vod_data_list: Any) -> list[dict[str, Any]]:
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


# ── Clip normalization ───────────────────────────────────────────────

def normalize_clip_list(raw: Any, channel_slug: str) -> list[dict[str, Any]]:
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


# ── Featured streams ─────────────────────────────────────────────────

def build_featured_response(raw: Any, page_int: int) -> dict:
    """Build the featured-livestreams response body from a raw Kick API response."""
    streams = raw.get("data", []) if isinstance(raw, dict) else []
    pagination = {
        "current_page": raw.get("current_page", page_int) if isinstance(raw, dict) else page_int,
        "per_page": raw.get("per_page", 14) if isinstance(raw, dict) else 14,
        "has_next": raw.get("next_page_url") is not None if isinstance(raw, dict) else False,
        "has_prev": raw.get("prev_page_url") is not None if isinstance(raw, dict) else False,
    }
    return {"status": "success", "message": "", "data": streams, "pagination": pagination}


# ── Cache warm-up from featured response ─────────────────────────────

def warm_caches_from_featured(cache, streams: list) -> None:
    """Pre-cache avatar and partial play data from featured-streams response.

    - Avatar cache (7 days): eliminates upstream calls for profile pictures of featured channels.
    - Play cache (15s): gives instant channel render when clicking from browse grid.
    """
    for stream in streams:
        ch = stream.get("channel") or {}
        slug = ch.get("slug")
        if not slug:
            continue
        user = ch.get("user") or {}
        pic = user.get("profilepic")

        # Avatar cache — 7 days
        if pic:
            avatar_key = f"avatar:/streams/avatar/{slug}"
            if cache.get(avatar_key) is None:
                payload = {"status": "success", "message": "", "data": {"profile_picture": pic}}
                cache.set(avatar_key, (payload, 200), timeout=Config.AVATAR_CACHE_DURATION_SECONDS)

        # Play cache — partial response for instant channel render (short TTL)
        play_key = f"live:/streams/play/{slug}"
        if cache.get(play_key) is None:
            thumb_src = (stream.get("thumbnail") or {}).get("src") or pic
            partial = {
                "status": "success", "message": "", "data": {
                    "status": "live" if stream.get("is_live") else "offline",
                    "channel_slug": slug, "username": user.get("username", slug),
                    "profile_picture": pic,
                    "playback_url": ch.get("playback_url"),
                    "session_title": stream.get("session_title"),
                    "livestream_id": stream.get("id"),
                    "livestream_viewer_count": stream.get("viewer_count"),
                    "livestream_thumbnail_url": thumb_src,
                    "livestream_category": (stream.get("categories") or [{}])[0].get("name"),
                    "start_time": stream.get("start_time"),
                    "_partial": True,
                }
            }
            cache.set(play_key, (partial, 200), timeout=Config.LIVE_CACHE_DURATION_SECONDS)
