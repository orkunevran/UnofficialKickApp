import asyncio

import httpx

from api.cache import inflight_tracker
from app import app as fastapi_app
from services.cache_service import cache
from services.chromecast_service import chromecast_service
from services.circuit_breaker import CircuitBreaker
from services.kick_api_service import kick_api_client


def _stub_chromecast(monkeypatch):
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
    return calls


def test_lifespan_initializes_singletons_and_shuts_down(monkeypatch):
    calls = _stub_chromecast(monkeypatch)

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
                assert fastapi_app.state.inflight_tracker is inflight_tracker
                assert isinstance(fastapi_app.state.circuit_breaker, CircuitBreaker)

    asyncio.run(_exercise_app())

    assert calls[0] == ("configure", 8081)
    assert calls[1] == ("scan", True)
    assert calls[-1] == ("shutdown", None)


def test_metrics_endpoint_returns_all_sections(monkeypatch):
    """Verify /metrics returns cache, upstream, inflight, and uptime."""
    _stub_chromecast(monkeypatch)

    async def _run():
        async with fastapi_app.router.lifespan_context(fastapi_app):
            transport = httpx.ASGITransport(app=fastapi_app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                resp = await client.get("/metrics")
                assert resp.status_code == 200
                body = resp.json()
                # All top-level sections present
                assert "cache" in body
                assert "upstream" in body
                assert "inflight" in body
                assert "uptime_seconds" in body
                # Cache stats shape
                assert "size" in body["cache"]
                assert "max_size" in body["cache"]
                assert "hit_count" in body["cache"]
                assert "miss_count" in body["cache"]
                # Upstream stats shape
                assert "call_count" in body["upstream"]
                assert "circuit_breaker" in body["upstream"]
                assert body["upstream"]["circuit_breaker"]["state"] == "closed"
                # Inflight stats shape
                assert "active_keys" in body["inflight"]
                # Uptime
                assert body["uptime_seconds"] >= 0

    asyncio.run(_run())
