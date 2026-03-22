import threading
import time


class InMemoryCache:
    def __init__(self, max_size: int = 2000):
        self._store: dict[str, tuple[float, object]] = {}
        self._lock = threading.RLock()
        self.default_timeout = 300
        self.max_size = max_size
        self._hit_count = 0
        self._miss_count = 0

    def init_app(self, app=None):
        """Accept a config mapping or an app-like object with `config`."""
        config = getattr(app, "config", app) if app is not None else {}
        if config is not None:
            try:
                self.default_timeout = int(config.get("CACHE_DEFAULT_TIMEOUT", self.default_timeout))
            except Exception:
                pass
            try:
                self.max_size = int(config.get("CACHE_MAX_SIZE", self.max_size))
            except Exception:
                pass
        return self

    def _expiry(self, timeout):
        if timeout is None:
            timeout = self.default_timeout
        try:
            timeout = float(timeout)
        except Exception:
            timeout = float(self.default_timeout)
        if timeout <= 0:
            return time.monotonic()
        return time.monotonic() + timeout

    def _evict_if_needed(self):
        """Evict entries when store exceeds max_size. Must be called under lock."""
        if len(self._store) < self.max_size:
            return

        now = time.monotonic()
        # First pass: remove expired entries, stop early once under limit
        for k in [k for k, (exp, _) in self._store.items() if exp <= now]:
            del self._store[k]
            if len(self._store) < self.max_size:
                return

        # Second pass: if still over limit, evict oldest by insertion order
        while len(self._store) >= self.max_size:
            oldest_key = next(iter(self._store))
            del self._store[oldest_key]

    def set(self, key, value, timeout=None):
        with self._lock:
            self._evict_if_needed()
            # Callers treat cached values as immutable — no deep-copy needed.
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
                "max_size": self.max_size,
                "hit_count": self._hit_count,
                "miss_count": self._miss_count,
            }


cache = InMemoryCache()
