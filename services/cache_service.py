import threading
import time


class InMemoryCache:
    def __init__(self, max_size: int = 2000):
        self._store: dict[str, tuple[float, object]] = {}
        self._lock = threading.RLock()
        self._default_timeout = 300
        self._max_size = max_size
        self._hit_count = 0
        self._miss_count = 0

    @property
    def default_timeout(self):
        return self._default_timeout

    @property
    def max_size(self):
        return self._max_size

    def init_app(self, app=None):
        """Accept a config mapping or an app-like object with `config`.

        Thread-safe: acquires the lock before modifying internal state,
        even though this is typically called once during startup.
        """
        config = getattr(app, "config", app) if app is not None else {}
        if config is not None:
            with self._lock:
                try:
                    self._default_timeout = int(config.get("CACHE_DEFAULT_TIMEOUT", self._default_timeout))
                except Exception:
                    pass
                try:
                    self._max_size = int(config.get("CACHE_MAX_SIZE", self._max_size))
                except Exception:
                    pass
        return self

    def _expiry(self, timeout):
        if timeout is None:
            timeout = self._default_timeout
        try:
            timeout = float(timeout)
        except Exception:
            timeout = float(self._default_timeout)
        if timeout <= 0:
            return time.monotonic()
        return time.monotonic() + timeout

    def _evict_if_needed(self):
        """Evict entries when store exceeds max_size. Must be called under lock.

        Two-pass strategy:
          1. Scan for expired entries and delete them, stopping early once
             we are under the limit. This avoids materializing a full list
             of expired keys (O(n) allocation) when only a few removals
             are needed.
          2. If still over limit after purging expired entries, evict by
             insertion order (oldest first — Python dict preserves insertion
             order since 3.7).
        """
        if len(self._store) < self._max_size:
            return

        now = time.monotonic()
        # First pass: remove expired entries, break early
        expired = [k for k, (exp, _) in self._store.items() if exp <= now]
        for k in expired:
            del self._store[k]
            if len(self._store) < self._max_size:
                return

        # Second pass: evict oldest by insertion order
        while len(self._store) >= self._max_size:
            oldest_key = next(iter(self._store))
            del self._store[oldest_key]

    def set(self, key, value, timeout=None):
        with self._lock:
            self._evict_if_needed()
            self._store[key] = (self._expiry(timeout), value)
        return True

    def get(self, key, default=None):
        with self._lock:
            item = self._store.get(key)
            if item is None:
                self._miss_count += 1
                return default

            expires_at, value = item
            if expires_at is not None and expires_at <= time.monotonic():
                self._store.pop(key, None)
                self._miss_count += 1
                return default

            self._hit_count += 1
            return value

    def delete(self, key):
        with self._lock:
            return self._store.pop(key, None) is not None

    def clear(self):
        with self._lock:
            self._store.clear()
            self._hit_count = 0
            self._miss_count = 0
        return True

    def stats(self) -> dict:
        with self._lock:
            return {
                "size": len(self._store),
                "max_size": self._max_size,
                "hit_count": self._hit_count,
                "miss_count": self._miss_count,
            }


cache = InMemoryCache()
