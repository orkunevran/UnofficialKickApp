"""Pydantic models for request/response validation."""

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

# ── Generic envelope ─────────────────────────────────────────────────

class ApiEnvelope(BaseModel):
    status: str
    message: str = ""
    data: Any = Field(default_factory=dict)


# ── Config ───────────────────────────────────────────────────────────

class LanguageOption(BaseModel):
    code: str
    name: str


class LanguagesConfig(BaseModel):
    languages: list[LanguageOption]
    default_language: str


# ── Channel / Play ───────────────────────────────────────────────────

class SocialLinks(BaseModel):
    instagram: Optional[str] = None
    twitter: Optional[str] = None
    youtube: Optional[str] = None
    discord: Optional[str] = None
    tiktok: Optional[str] = None


class ChannelProfile(BaseModel):
    channel_slug: str
    username: str
    profile_picture: Optional[str] = None
    banner_image_url: Optional[str] = None
    bio: Optional[str] = None
    followers_count: Optional[int] = None
    verified: bool = False
    subscription_enabled: bool = False
    social_links: SocialLinks = Field(default_factory=SocialLinks)
    recent_categories: list[str] = Field(default_factory=list)


class PlayStreamData(ChannelProfile):
    status: Literal["live", "offline"]
    playback_url: Optional[str] = None
    livestream_id: Optional[int] = None
    livestream_thumbnail_url: Optional[str] = None
    livestream_title: Optional[str] = None
    livestream_viewer_count: Optional[int] = None
    livestream_category: Optional[str] = None
    start_time: Optional[str] = None


class PlayStreamResponse(ApiEnvelope):
    data: PlayStreamData


# ── VODs ─────────────────────────────────────────────────────────────

class VodItem(BaseModel):
    vod_id: Optional[int] = None
    video_uuid: Optional[str] = None
    title: Optional[str] = None
    source_url: Optional[str] = None
    thumbnail_url: Optional[str] = None
    views: Optional[int] = None
    duration_seconds: Optional[float] = None
    created_at: Optional[str] = None
    language: Optional[str] = None
    is_mature: Optional[bool] = None


class VodListData(BaseModel):
    vods: list[VodItem] = Field(default_factory=list)


class VodListResponse(ApiEnvelope):
    data: VodListData


# ── Clips ────────────────────────────────────────────────────────────

class ClipItem(BaseModel):
    clip_id: Optional[int] = None
    title: Optional[str] = None
    clip_url: Optional[str] = None
    thumbnail_url: Optional[str] = None
    duration_seconds: Optional[int] = None
    views: Optional[int] = None
    category_name: Optional[str] = None
    created_at: Optional[str] = None
    channel_slug: Optional[str] = None


class ClipsData(BaseModel):
    clips: list[ClipItem] = Field(default_factory=list)


class ClipsResponse(ApiEnvelope):
    data: ClipsData


# ── Featured Streams ─────────────────────────────────────────────────

class FeaturedPagination(BaseModel):
    current_page: int
    per_page: int
    has_next: bool
    has_prev: bool


class FeaturedStreamsResponse(BaseModel):
    status: str
    message: str = ""
    data: list[Any] = Field(default_factory=list)
    pagination: FeaturedPagination


# ── Search ───────────────────────────────────────────────────────────

class SearchResult(BaseModel):
    slug: str
    username: str
    followers_count: int = 0
    is_live: bool = False
    verified: bool = False
    profile_picture: Optional[str] = None


class SearchResponse(ApiEnvelope):
    data: list[SearchResult]


# ── Avatar ───────────────────────────────────────────────────────────

class AvatarData(BaseModel):
    profile_picture: Optional[str] = None


class AvatarResponse(ApiEnvelope):
    data: AvatarData


# ── Viewer Count ─────────────────────────────────────────────────────

class ViewerCountData(BaseModel):
    viewer_count: int


class ViewerCountResponse(ApiEnvelope):
    data: ViewerCountData


class ViewerBatchResponse(ApiEnvelope):
    data: dict[str, int] = Field(default_factory=dict)


# ── Chromecast ───────────────────────────────────────────────────────

class ChromecastSelectRequest(BaseModel):
    uuid: Optional[str] = None


class ChromecastCastRequest(BaseModel):
    stream_url: Optional[str] = None
    title: str = "Kick Stream"


class ChromecastStopRequest(BaseModel):
    uuid: Optional[str] = None


class ChromecastDevice(BaseModel):
    name: str
    uuid: str


class ChromecastStatus(BaseModel):
    status: str
    device_name: Optional[str] = None
    is_playing: Optional[bool] = None
