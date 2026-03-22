"""Tests for services/cache_service.py — LRU eviction, TTL, thread safety."""

import threading
import time

from services.cache_service import InMemoryCache


class TestInMemoryCache:
    def test_set_and_get(self):
        c = InMemoryCache()
        c.set("key", "value", timeout=60)
        assert c.get("key") == "value"

    def test_get_missing_key(self):
        c = InMemoryCache()
        assert c.get("missing") is None
        assert c.get("missing", "default") == "default"

    def test_ttl_expiry(self):
        c = InMemoryCache()
        c.set("key", "value", timeout=0.01)
        time.sleep(0.02)
        assert c.get("key") is None

    def test_delete(self):
        c = InMemoryCache()
        c.set("key", "value")
        assert c.delete("key") is True
        assert c.get("key") is None
        assert c.delete("key") is False

    def test_clear(self):
        c = InMemoryCache()
        c.set("a", 1)
        c.set("b", 2)
        c.clear()
        assert c.get("a") is None
        assert c.get("b") is None

    def test_max_size_eviction(self):
        c = InMemoryCache(max_size=3)
        c.set("a", 1, timeout=60)
        c.set("b", 2, timeout=60)
        c.set("c", 3, timeout=60)
        # Adding a 4th entry should evict the oldest
        c.set("d", 4, timeout=60)
        assert c.get("d") == 4
        # At least one of the early entries should be evicted
        remaining = sum(1 for k in ("a", "b", "c") if c.get(k) is not None)
        assert remaining <= 2

    def test_eviction_prefers_expired(self):
        c = InMemoryCache(max_size=3)
        c.set("expired", "x", timeout=0.01)
        c.set("fresh1", "y", timeout=60)
        c.set("fresh2", "z", timeout=60)
        time.sleep(0.02)
        # This should evict "expired" first (it's expired)
        c.set("new", "w", timeout=60)
        assert c.get("expired") is None
        assert c.get("fresh1") == "y"
        assert c.get("fresh2") == "z"
        assert c.get("new") == "w"

    def test_deep_copy_on_write(self):
        c = InMemoryCache()
        data = {"key": [1, 2, 3]}
        c.set("data", data)
        data["key"].append(4)  # mutate original
        # Cached value should not be affected
        cached = c.get("data")
        assert cached["key"] == [1, 2, 3]

    def test_stats(self):
        c = InMemoryCache(max_size=100)
        c.set("a", 1)
        c.get("a")  # hit
        c.get("b")  # miss
        stats = c.stats()
        assert stats["size"] == 1
        assert stats["hit_count"] == 1
        assert stats["miss_count"] == 1

    def test_thread_safety(self):
        c = InMemoryCache(max_size=1000)
        errors = []

        def writer(start_key):
            try:
                for i in range(100):
                    c.set(f"{start_key}-{i}", i, timeout=60)
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=writer, args=(f"t{t}",)) for t in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(errors) == 0
        stats = c.stats()
        assert stats["size"] <= 1000

    def test_init_app(self):
        c = InMemoryCache()
        c.init_app({"CACHE_DEFAULT_TIMEOUT": 600, "CACHE_MAX_SIZE": 5000})
        assert c.default_timeout == 600
        assert c.max_size == 5000
