import copy
import threading
import time


def _safe_copy(value):
    try:
        return copy.deepcopy(value)
    except Exception:
        return value


class InMemoryCache:
    def __init__(self):
        self._store = {}
        self._lock = threading.RLock()
        self.default_timeout = 300

    def init_app(self, app=None):
        """Accept a config mapping or an app-like object with `config`."""
        config = getattr(app, "config", app) if app is not None else {}
        if config is not None:
            try:
                self.default_timeout = int(config.get("CACHE_DEFAULT_TIMEOUT", self.default_timeout))
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

    def set(self, key, value, timeout=None):
        with self._lock:
            self._store[key] = (self._expiry(timeout), _safe_copy(value))
        return True

    def get(self, key, default=None):
        with self._lock:
            item = self._store.get(key)
            if item is None:
                return default

            expires_at, value = item
            if expires_at is not None and expires_at <= time.monotonic():
                self._store.pop(key, None)
                return default

            return _safe_copy(value)

    def delete(self, key):
        with self._lock:
            return self._store.pop(key, None) is not None

    def clear(self):
        with self._lock:
            self._store.clear()
        return True


cache = InMemoryCache()
