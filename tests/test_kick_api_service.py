"""
Tests for KickAPIClient._get_typesense_key():
  - asyncio Lock: concurrent callers trigger at most one bundle fetch
  - fallback path: when bundle scrape returns None and cache is empty,
    TYPESENSE_KEY_FALLBACK is returned
"""
import asyncio
from unittest.mock import patch

from services.kick_api_service import KickAPIClient


def _fresh_client():
    """Return a KickAPIClient with class-level cache cleared."""
    KickAPIClient._ts_key_cache = None
    KickAPIClient._ts_key_fetched_at = 0.0
    return KickAPIClient()


def test_concurrent_callers_fetch_bundle_exactly_once():
    """
    N tasks all call _get_typesense_key() simultaneously with an empty cache.
    The bundle scrape should be executed exactly once (asyncio.Lock).
    """
    results = []

    async def run_test():
        fetch_count = 0
        start_event = asyncio.Event()
        lock = asyncio.Lock()
        client = _fresh_client()

        async def fake_fetch():
            nonlocal fetch_count
            async with lock:
                fetch_count += 1
            await asyncio.sleep(0.05)  # simulate network latency
            return "fresh-key-from-bundle"

        async def worker():
            await start_event.wait()  # all tasks start at the same instant
            key = await client._get_typesense_key()
            results.append(key)

        with patch.object(client, "_fetch_typesense_key_from_bundle", side_effect=fake_fetch):
            tasks = [asyncio.create_task(worker()) for _ in range(8)]
            start_event.set()
            await asyncio.gather(*tasks)

        assert len(results) == 8, "All tasks should have received a key"
        assert all(k == "fresh-key-from-bundle" for k in results), "All tasks must get the fresh key"
        assert fetch_count == 1, (
            f"Bundle fetch should be called exactly once, but was called {fetch_count} times"
        )

    asyncio.run(run_test())


def test_fallback_key_returned_when_bundle_fails_and_cache_empty():
    """
    When _fetch_typesense_key_from_bundle returns None and the cache is empty,
    _get_typesense_key() must return TYPESENSE_KEY_FALLBACK.
    """
    async def run_test():
        client = _fresh_client()
        with patch.object(client, "_fetch_typesense_key_from_bundle", return_value=None):
            key = await client._get_typesense_key(force_refresh=True)

        assert key == KickAPIClient.TYPESENSE_KEY_FALLBACK
        assert KickAPIClient._ts_key_cache == KickAPIClient.TYPESENSE_KEY_FALLBACK

    asyncio.run(run_test())


def test_stale_cache_kept_when_bundle_fails():
    """
    When _fetch_typesense_key_from_bundle returns None but a cached key exists,
    the stale cached key should be returned rather than the hard fallback.
    """
    async def run_test():
        client = _fresh_client()
        KickAPIClient._ts_key_cache = "old-cached-key"
        KickAPIClient._ts_key_fetched_at = 0.0  # expired

        with patch.object(client, "_fetch_typesense_key_from_bundle", return_value=None):
            key = await client._get_typesense_key(force_refresh=True)

        assert key == "old-cached-key"

    asyncio.run(run_test())


def test_get_viewer_count_hits_root_current_viewers_endpoint():
    """
    The lightweight viewer-count helper should call Kick's root /current-viewers route.
    """
    captured = {}

    class FakeResponse:
        status_code = 200
        text = '[{"livestream_id":101329688,"viewers":4720}]'

        def raise_for_status(self):
            return None

        def json(self):
            return [{"livestream_id": 101329688, "viewers": 4720}]

    async def fake_get(url, timeout):
        captured["url"] = url
        captured["timeout"] = timeout
        return FakeResponse()

    async def run_test():
        client = _fresh_client()
        with patch.object(client.session, "get", side_effect=fake_get):
            count = await client.get_viewer_count(101329688)

        assert count == 4720
        assert captured["url"] == "https://kick.com/current-viewers?ids[]=101329688"
        assert captured["timeout"] == (3, 5)

    asyncio.run(run_test())
