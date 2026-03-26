"""Tests for api/cache.py — InflightTracker async dedup system.

The InflightTracker prevents thundering-herd on cache miss: when N
concurrent coroutines request the same uncached key, only one fetches
while the others wait. These tests verify the dedup invariants.
"""

import asyncio
import time

import pytest

from api.cache import InflightTracker


@pytest.fixture
def tracker():
    return InflightTracker()


class FakeCache:
    """Minimal cache stub for InflightTracker tests."""

    def __init__(self):
        self._store = {}

    def get(self, key, default=None):
        return self._store.get(key, default)

    def set(self, key, value, timeout=None):
        self._store[key] = value


class TestDedup:
    """Core dedup_get / dedup_set contract."""

    def test_cache_hit_returns_immediately(self, tracker):
        cache = FakeCache()
        cache.set("k", "cached-value")

        result = asyncio.run(tracker.dedup_get(cache, "k"))
        assert result == "cached-value"
        # No inflight entry should be created for cache hits
        assert "k" not in tracker._inflight

    def test_cold_miss_returns_none_and_registers_inflight(self, tracker):
        cache = FakeCache()

        result = asyncio.run(tracker.dedup_get(cache, "k"))
        assert result is None
        assert "k" in tracker._inflight

    def test_dedup_set_unblocks_waiters(self, tracker):
        """When the fetcher calls dedup_set, waiting coroutines should unblock
        and find the value in the cache."""
        cache = FakeCache()
        results = []

        async def run():
            # Coroutine 1: cold miss → becomes fetcher
            r1 = await tracker.dedup_get(cache, "k")
            assert r1 is None  # cold miss

            # Coroutine 2: sees inflight, waits
            async def waiter():
                r = await tracker.dedup_get(cache, "k")
                results.append(("waiter", r))

            task = asyncio.create_task(waiter())
            await asyncio.sleep(0.05)  # let waiter start waiting

            # Fetcher populates cache and signals
            cache.set("k", "fetched-value")
            tracker.dedup_set("k")

            await task
            results.append(("fetcher", None))

        asyncio.run(run())
        # Waiter should have received the cached value
        assert ("waiter", "fetched-value") in results

    def test_dedup_set_without_inflight_is_noop(self, tracker):
        """Calling dedup_set on a key with no inflight entry should not crash."""
        tracker.dedup_set("nonexistent")  # should not raise

    def test_timeout_does_not_pop_inflight(self, tracker):
        """On timeout, dedup_get should NOT remove the inflight entry.

        The original fetcher is still running; removing the entry would
        break dedup by allowing a duplicate fetch.
        """
        cache = FakeCache()
        # Override timeout for fast test
        tracker._WAIT_TIMEOUT = 0.1

        async def run():
            # Register inflight
            r = await tracker.dedup_get(cache, "k")
            assert r is None

            # Waiter times out
            r2 = await tracker.dedup_get(cache, "k")
            assert r2 is None  # cache still empty

            # Critical: inflight entry should still exist
            assert "k" in tracker._inflight

        asyncio.run(run())


class TestClaimInflight:
    """Tests for claim_inflight (used by stale-while-revalidate)."""

    def test_claim_succeeds_when_no_existing(self, tracker):
        assert tracker.claim_inflight("k") is True
        assert "k" in tracker._inflight

    def test_claim_fails_when_already_claimed(self, tracker):
        tracker.claim_inflight("k")
        assert tracker.claim_inflight("k") is False


class TestSweepStale:
    """Tests for periodic sweep of abandoned inflight entries."""

    def test_sweep_removes_old_entries(self, tracker):
        # Insert an entry with an old timestamp
        tracker._inflight["old-key"] = (asyncio.Event(), time.monotonic() - 60)
        tracker._inflight["fresh-key"] = (asyncio.Event(), time.monotonic())

        removed = tracker.sweep_stale()
        assert removed == 1
        assert "old-key" not in tracker._inflight
        assert "fresh-key" in tracker._inflight

    def test_sweep_sets_event_on_stale_entries(self, tracker):
        """Stale entries should have their events set to unblock any waiters."""
        event = asyncio.Event()
        tracker._inflight["stale"] = (event, time.monotonic() - 60)

        tracker.sweep_stale()
        assert event.is_set()

    def test_sweep_empty_tracker_returns_zero(self, tracker):
        assert tracker.sweep_stale() == 0


class TestStats:
    def test_stats_reflects_active_keys(self, tracker):
        assert tracker.stats() == {"active_keys": 0}
        tracker._inflight["a"] = (asyncio.Event(), time.monotonic())
        tracker._inflight["b"] = (asyncio.Event(), time.monotonic())
        assert tracker.stats() == {"active_keys": 2}
