import copy
import functools
import inspect
import threading
import time
from urllib.parse import urlencode


def _safe_copy(value):
    try:
        return copy.deepcopy(value)
    except Exception:
        return value


def _has_request_like(value):
    return (hasattr(value, "url") and hasattr(value, "query_params")) or (
        hasattr(value, "path") and hasattr(value, "args")
    )


def _extract_request(args, kwargs):
    """Return a request-like object if one is available."""
    for value in kwargs.values():
        if _has_request_like(value):
            return value
    for value in args:
        if _has_request_like(value):
            return value
    return None


def _request_path(request_obj):
    if request_obj is None:
        return ""
    if hasattr(request_obj, "path"):
        return request_obj.path
    if hasattr(request_obj, "url") and hasattr(request_obj.url, "path"):
        return request_obj.url.path
    return ""


def _request_query_items(request_obj):
    if request_obj is None:
        return []
    try:
        if hasattr(request_obj, "args"):
            return list(request_obj.args.items(multi=True))
        if hasattr(request_obj, "query_params"):
            return list(request_obj.query_params.multi_items())
    except Exception:
        return []
    return []


def _normalized_query_string(request_obj):
    items = _request_query_items(request_obj)
    if not items:
        return ""
    return urlencode(sorted((str(k), str(v)) for k, v in items), doseq=True)


def _fallback_key_fragment(args, kwargs):
    for key in ("channel_slug", "vod_id", "uuid", "id", "livestream_id", "slug"):
        if key in kwargs and kwargs[key] is not None:
            return str(kwargs[key])

    for value in reversed(args):
        if value is None:
            continue
        if isinstance(value, (str, int)):
            return str(value)
    return ""


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

    def cached(self, timeout=None, key_prefix=None, query_string=False, make_cache_key=None):
        """Decorator-compatible cache wrapper for sync and async callables."""

        def decorator(func):
            is_async = inspect.iscoroutinefunction(func)

            def _cache_key(args, kwargs):
                if make_cache_key is not None:
                    return str(make_cache_key(*args, **kwargs))

                request_obj = _extract_request(args, kwargs)
                path = _request_path(request_obj)
                query = _normalized_query_string(request_obj)

                if key_prefix is not None:
                    prefix = str(key_prefix)
                    if "%s" in prefix:
                        fragment = path or _fallback_key_fragment(args, kwargs)
                        key = prefix % fragment
                    else:
                        key = prefix
                else:
                    key = path or f"{func.__module__}.{func.__qualname__}"

                if query_string:
                    if query:
                        return f"{key}?{query}"
                return key

            if is_async:

                @functools.wraps(func)
                async def async_wrapper(*args, **kwargs):
                    key = _cache_key(args, kwargs)
                    cached_value = self.get(key, default=_MISSING)
                    if cached_value is not _MISSING:
                        return cached_value

                    result = await func(*args, **kwargs)
                    self.set(key, result, timeout=timeout)
                    return result

                return async_wrapper

            @functools.wraps(func)
            def sync_wrapper(*args, **kwargs):
                key = _cache_key(args, kwargs)
                cached_value = self.get(key, default=_MISSING)
                if cached_value is not _MISSING:
                    return cached_value

                result = func(*args, **kwargs)
                self.set(key, result, timeout=timeout)
                return result

            return sync_wrapper

        return decorator


_MISSING = object()


cache = InMemoryCache()


def init_cache(app):
    """Backward-compatible initialization helper."""
    return cache.init_app(app)
