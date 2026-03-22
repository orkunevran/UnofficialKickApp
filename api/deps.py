"""FastAPI dependency injection callables.

Usage in route handlers::

    from api.deps import CacheDep, KickClientDep, ChromecastDep

    @router.get("/play/{slug}")
    async def play_stream(slug: str, cache: CacheDep, client: KickClientDep):
        ...

For testing, override via ``app.dependency_overrides[get_cache] = lambda: mock_cache``.
"""

from typing import Annotated

from fastapi import Depends, Request

from services.cache_service import InMemoryCache
from services.chromecast_service import ChromecastService
from services.kick_api_service import KickAPIClient


def get_cache(request: Request) -> InMemoryCache:
    return request.app.state.cache


def get_kick_client(request: Request) -> KickAPIClient:
    return request.app.state.kick_api_client


def get_chromecast(request: Request) -> ChromecastService:
    return request.app.state.chromecast_service


# Annotated aliases for cleaner route signatures
CacheDep = Annotated[InMemoryCache, Depends(get_cache)]
KickClientDep = Annotated[KickAPIClient, Depends(get_kick_client)]
ChromecastDep = Annotated[ChromecastService, Depends(get_chromecast)]
