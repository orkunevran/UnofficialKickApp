"""Stream route sub-modules — all mounted under /streams by app.py."""

from api.routes.channel import router as channel_router
from api.routes.discovery import router as discovery_router
from api.routes.featured import router as featured_router
from api.routes.vods import router as vods_router

__all__ = ["channel_router", "vods_router", "featured_router", "discovery_router"]
