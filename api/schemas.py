from typing import Any, Optional

from pydantic import BaseModel, Field


class LanguageOption(BaseModel):
    code: str
    name: str


class LanguagesConfig(BaseModel):
    languages: list[LanguageOption]
    default_language: str


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


class ApiEnvelope(BaseModel):
    status: str
    message: str = ""
    data: Any = Field(default_factory=dict)
