"""Pydantic models for request/response validation."""

from typing import Optional

from pydantic import BaseModel, Field

# ── Config ───────────────────────────────────────────────────────────

class LanguageOption(BaseModel):
    code: str
    name: str


class LanguagesConfig(BaseModel):
    languages: list[LanguageOption]
    default_language: str


# ── Chromecast ───────────────────────────────────────────────────────

class ChromecastSelectRequest(BaseModel):
    uuid: Optional[str] = None


class ChromecastCastRequest(BaseModel):
    stream_url: Optional[str] = None
    title: str = "Kick Stream"


class ChromecastStopRequest(BaseModel):
    uuid: Optional[str] = None


class ChromecastSeekRequest(BaseModel):
    position: float = Field(..., ge=0.0)


class ChromecastVolumeRequest(BaseModel):
    level: float = Field(..., ge=0.0, le=1.0)
