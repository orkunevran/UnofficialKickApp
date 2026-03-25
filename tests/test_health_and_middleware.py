"""Tests for /health endpoints and security headers middleware."""

import asyncio

import httpx

from app import app as fastapi_app
from services.chromecast_service import chromecast_service


def _stub_chromecast(monkeypatch):
    """Stub chromecast methods so lifespan doesn't try real mDNS."""
    monkeypatch.setattr(chromecast_service, "configure", lambda s: None)
    monkeypatch.setattr(chromecast_service, "scan_for_devices_async", lambda **kw: True)
    monkeypatch.setattr(chromecast_service, "shutdown", lambda: None)


def test_health_live_returns_200(monkeypatch):
    """Liveness probe should always return 200 with status 'ok'."""
    _stub_chromecast(monkeypatch)

    async def _run():
        async with fastapi_app.router.lifespan_context(fastapi_app):
            transport = httpx.ASGITransport(app=fastapi_app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                resp = await client.get("/health/live")
                assert resp.status_code == 200
                assert resp.json()["status"] == "ok"

    asyncio.run(_run())


def test_health_returns_component_status(monkeypatch):
    """Full health check should include cache and circuit_breaker components."""
    _stub_chromecast(monkeypatch)

    async def _run():
        async with fastapi_app.router.lifespan_context(fastapi_app):
            transport = httpx.ASGITransport(app=fastapi_app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                resp = await client.get("/health")
                assert resp.status_code == 200
                body = resp.json()
                assert body["status"] in ("healthy", "degraded", "unhealthy")
                assert "components" in body
                assert "cache" in body["components"]
                assert "circuit_breaker" in body["components"]
                assert body["components"]["cache"]["status"] == "healthy"
                assert body["components"]["circuit_breaker"]["status"] == "healthy"
                assert body["uptime_seconds"] >= 0

    asyncio.run(_run())


def test_security_headers_present(monkeypatch):
    """Security headers should be present on every response."""
    _stub_chromecast(monkeypatch)

    async def _run():
        async with fastapi_app.router.lifespan_context(fastapi_app):
            transport = httpx.ASGITransport(app=fastapi_app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                resp = await client.get("/health/live")
                assert resp.headers["x-content-type-options"] == "nosniff"
                assert resp.headers["x-frame-options"] == "DENY"
                assert resp.headers["referrer-policy"] == "strict-origin-when-cross-origin"
                assert "permissions-policy" in resp.headers
                assert resp.headers["x-request-id"]  # correlation ID always present

    asyncio.run(_run())


def test_health_reports_degraded_when_circuit_open(monkeypatch):
    """Health should report circuit_breaker as unhealthy when open."""
    _stub_chromecast(monkeypatch)

    async def _run():
        async with fastapi_app.router.lifespan_context(fastapi_app):
            # Force the circuit breaker into open state
            cb = fastapi_app.state.circuit_breaker
            for _ in range(cb.failure_threshold):
                cb.record_failure()
            assert cb.state == "open"

            transport = httpx.ASGITransport(app=fastapi_app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                resp = await client.get("/health")
                assert resp.status_code == 503
                body = resp.json()
                assert body["status"] == "unhealthy"
                assert body["components"]["circuit_breaker"]["status"] == "unhealthy"
                assert body["components"]["circuit_breaker"]["state"] == "open"

            # Reset for other tests
            cb.record_success()

    asyncio.run(_run())
