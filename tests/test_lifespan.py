import asyncio

import httpx

from app import app as fastapi_app
from services.cache_service import cache
from services.chromecast_service import chromecast_service
from services.kick_api_service import kick_api_client


def test_lifespan_initializes_singletons_and_shuts_down(monkeypatch):
    calls = []

    def configure(settings):
        calls.append(("configure", settings["PORT"]))

    def scan_for_devices_async(force=False, known_hosts=None):
        calls.append(("scan", force))
        return True

    def shutdown():
        calls.append(("shutdown", None))

    monkeypatch.setattr(chromecast_service, "configure", configure)
    monkeypatch.setattr(chromecast_service, "scan_for_devices_async", scan_for_devices_async)
    monkeypatch.setattr(chromecast_service, "shutdown", shutdown)

    async def _exercise_app():
        async with fastapi_app.router.lifespan_context(fastapi_app):
            transport = httpx.ASGITransport(app=fastapi_app, raise_app_exceptions=False)
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://testserver",
                follow_redirects=False,
            ) as client:
                docs_response = await client.get("/docs")
                assert docs_response.status_code == 200
                assert "swagger" in docs_response.text.lower()

                response = await client.get("/config/languages")
                assert response.status_code == 200
                assert fastapi_app.state.kick_api_client is kick_api_client
                assert fastapi_app.state.chromecast_service is chromecast_service
                assert fastapi_app.state.cache is cache

    asyncio.run(_exercise_app())

    assert calls[0] == ("configure", 8081)
    assert calls[1] == ("scan", True)
    assert calls[-1] == ("shutdown", None)
