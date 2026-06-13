"""Regression tests for live-start latency hardening behavior."""

import asyncio
import copy

import httpx
import requests

from app import app as fastapi_app
from config import Config
from services.chromecast_service import chromecast_service
from services.kick_api_service import kick_api_client


def _stub_chromecast(monkeypatch):
    monkeypatch.setattr(chromecast_service, "configure", lambda s: None)
    monkeypatch.setattr(chromecast_service, "scan_for_devices_async", lambda **kw: True)
    monkeypatch.setattr(chromecast_service, "shutdown", lambda: None)


def _raise_http_429():
    response = requests.Response()
    response.status_code = 429
    raise requests.exceptions.HTTPError(response=response)


def test_non_critical_breaker_open_does_not_block_play(monkeypatch, sample_api_data):
    """Opening the non-critical lane should not block /streams/play."""
    _stub_chromecast(monkeypatch)

    monkeypatch.setattr(
        kick_api_client,
        "get_channel_data",
        lambda channel_slug, timeout=8: copy.deepcopy(sample_api_data["live_channel"]),
    )
    monkeypatch.setattr(kick_api_client, "search_channels_typesense", lambda q, timeout=3: [])

    async def _run():
        async with fastapi_app.router.lifespan_context(fastapi_app):
            non_critical = fastapi_app.state.circuit_breaker_non_critical
            for _ in range(non_critical.failure_threshold):
                non_critical.record_failure()
            assert non_critical.state == "open"
            assert fastapi_app.state.circuit_breaker_critical.state == "closed"

            transport = httpx.ASGITransport(app=fastapi_app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                play_resp = await client.get("/streams/play/live-user")
                search_resp = await client.get("/streams/search", params={"q": "live"})

            assert play_resp.status_code == 200
            assert search_resp.status_code == 503

    asyncio.run(_run())


def test_critical_breaker_open_blocks_play_not_search(monkeypatch, sample_api_data):
    """Opening the critical lane should fail-fast playback while search still works."""
    _stub_chromecast(monkeypatch)

    monkeypatch.setattr(
        kick_api_client,
        "get_channel_data",
        lambda channel_slug, timeout=8: copy.deepcopy(sample_api_data["live_channel"]),
    )
    monkeypatch.setattr(
        kick_api_client,
        "search_channels_typesense",
        lambda q, timeout=3: copy.deepcopy(sample_api_data["search_results"]),
    )

    async def _run():
        async with fastapi_app.router.lifespan_context(fastapi_app):
            critical = fastapi_app.state.circuit_breaker_critical
            for _ in range(critical.failure_threshold):
                critical.record_failure()
            assert critical.state == "open"
            assert fastapi_app.state.circuit_breaker_non_critical.state == "closed"

            transport = httpx.ASGITransport(app=fastapi_app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                play_resp = await client.get("/streams/play/live-user")
                search_resp = await client.get("/streams/search", params={"q": "live"})

            assert play_resp.status_code == 503
            assert search_resp.status_code == 200

    asyncio.run(_run())


def test_play_429_is_not_negative_cached(monkeypatch):
    """Consecutive /play calls after 429 should each attempt fresh upstream fetches."""
    _stub_chromecast(monkeypatch)

    calls = {"count": 0}

    def _always_429(channel_slug, timeout=8):
        calls["count"] += 1
        _raise_http_429()

    monkeypatch.setattr(kick_api_client, "get_channel_data", _always_429)

    async def _run():
        async with fastapi_app.router.lifespan_context(fastapi_app):
            transport = httpx.ASGITransport(app=fastapi_app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                r1 = await client.get("/streams/play/live-user")
                r2 = await client.get("/streams/play/live-user")

            assert r1.status_code == 429
            assert r2.status_code == 429
            assert calls["count"] == 2

    asyncio.run(_run())


def test_play_stale_payload_preserved_when_background_refresh_hits_429(monkeypatch, sample_api_data):
    """SWR stale payload should stay intact when background refresh gets 429."""
    _stub_chromecast(monkeypatch)
    monkeypatch.setattr(Config, "LIVE_CACHE_DURATION_SECONDS", 1)

    calls = {"count": 0}

    def _live_then_429(channel_slug, timeout=8):
        calls["count"] += 1
        if calls["count"] == 1:
            return copy.deepcopy(sample_api_data["live_channel"])
        _raise_http_429()

    monkeypatch.setattr(kick_api_client, "get_channel_data", _live_then_429)

    async def _run():
        async with fastapi_app.router.lifespan_context(fastapi_app):
            transport = httpx.ASGITransport(app=fastapi_app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                first = await client.get("/streams/play/live-user")
                assert first.status_code == 200

                # Let the fresh marker expire while stale payload is still valid.
                await asyncio.sleep(1.1)
                second = await client.get("/streams/play/live-user")
                assert second.status_code == 200
                assert second.json()["status"] == "success"

                # Allow background refresh task to run and fail with 429.
                await asyncio.sleep(0.15)

                cached = fastapi_app.state.cache.get("live:/streams/play/live-user")
                assert isinstance(cached, tuple)
                payload, status = cached
                assert status == 200
                assert payload.get("status") == "success"
                assert calls["count"] >= 2

    asyncio.run(_run())


def test_metrics_exposes_breaker_lane_event_counters(monkeypatch):
    """Metrics should expose per-lane breaker rejection/failure counters."""
    _stub_chromecast(monkeypatch)

    def _always_429(channel_slug, timeout=8):
        _raise_http_429()

    monkeypatch.setattr(kick_api_client, "get_channel_data", _always_429)

    async def _run():
        async with fastapi_app.router.lifespan_context(fastapi_app):
            # Force a critical-lane rejection by opening critical breaker.
            critical = fastapi_app.state.circuit_breaker_critical
            for _ in range(critical.failure_threshold):
                critical.record_failure()

            transport = httpx.ASGITransport(app=fastapi_app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                # Rejection (503 from open critical breaker)
                await client.get("/streams/play/live-user")

                # Reset breaker then trigger upstream failure event (429)
                critical.record_success()
                await client.get("/streams/play/live-user")

                metrics = (await client.get("/metrics")).json()

            events = metrics["upstream"]["circuit_breaker_events"]["critical"]
            assert events["rejections"] >= 1
            assert events["failures"] >= 1
            assert "non_critical" in metrics["upstream"]["circuit_breaker_events"]
            assert "other" in metrics["upstream"]["circuit_breaker_events"]

    asyncio.run(_run())


def test_background_refresh_limiter_can_skip_refresh_when_saturated(monkeypatch, sample_api_data):
    """If refresh limiter is saturated, stale response should still return quickly and skip refresh."""
    _stub_chromecast(monkeypatch)
    monkeypatch.setattr(Config, "LIVE_CACHE_DURATION_SECONDS", 1)

    calls = {"count": 0}

    def _always_live(channel_slug, timeout=8):
        calls["count"] += 1
        return copy.deepcopy(sample_api_data["live_channel"])

    monkeypatch.setattr(kick_api_client, "get_channel_data", _always_live)

    async def _run():
        async with fastapi_app.router.lifespan_context(fastapi_app):
            transport = httpx.ASGITransport(app=fastapi_app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                # Prime stale cache and fresh marker.
                first = await client.get("/streams/play/live-user")
                assert first.status_code == 200
                assert calls["count"] == 1

                await asyncio.sleep(1.1)  # expire fresh marker

                limiter = fastapi_app.state.background_refresh_limiter
                acquired = 0
                for _ in range(Config.BACKGROUND_REFRESH_MAX_CONCURRENCY):
                    await limiter.acquire()  # saturate limiter for refresh task
                    acquired += 1
                try:
                    second = await client.get("/streams/play/live-user")
                    assert second.status_code == 200
                    await asyncio.sleep(0.15)
                finally:
                    for _ in range(acquired):
                        limiter.release()

                # Refresh should have been skipped while limiter saturated.
                assert calls["count"] == 1

    asyncio.run(_run())
