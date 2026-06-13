"""Tests for api/cache.py — cache key generation and response helpers.

These pure functions are used by every route handler but had zero
direct tests. They have complex branching logic around tuple
unpacking, dict structure detection, and fallback chains.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

from api.cache import (
    cache_json_response,
    cached_value_to_response,
    extract_channel_data_from_live_cache,
    request_cache_key,
)


class TestRequestCacheKey:
    """Tests for cache key generation from request objects."""

    def _make_request(self, path="/test", query_params=None):
        """Create a minimal request-like object."""
        req = SimpleNamespace()
        req.url = SimpleNamespace(path=path)
        if query_params is not None:
            req.query_params = SimpleNamespace()
            req.query_params.multi_items = lambda: list(query_params.items())
        return req

    def test_path_only(self):
        req = self._make_request("/streams/play/xqc")
        assert request_cache_key(req) == "/streams/play/xqc"

    def test_with_prefix(self):
        req = self._make_request("/streams/play/xqc")
        assert request_cache_key(req, prefix="live") == "live:/streams/play/xqc"

    def test_include_query(self):
        req = self._make_request("/streams/search", {"q": "kick", "page": "2"})
        key = request_cache_key(req, prefix="search", include_query=True)
        assert key.startswith("search:/streams/search?")
        assert "page=2" in key
        assert "q=kick" in key

    def test_query_params_sorted(self):
        """Query params should be sorted for consistent cache keys."""
        req = self._make_request("/test", {"z": "1", "a": "2"})
        key = request_cache_key(req, include_query=True)
        assert key == "/test?a=2&z=1"

    def test_include_query_no_params(self):
        req = self._make_request("/test")
        key = request_cache_key(req, include_query=True)
        assert key == "/test"

    def test_missing_url_attribute(self):
        """Handle objects without url.path gracefully."""
        req = SimpleNamespace()
        assert request_cache_key(req) == ""


class TestCacheJsonResponse:
    def test_stores_tuple_and_returns_payload(self):
        cache = MagicMock()
        payload = {"status": "success"}
        result = cache_json_response(cache, "key", payload, 200, timeout=30)
        cache.set.assert_called_once_with("key", (payload, 200), timeout=30)
        assert result == (payload, 200)

    def test_custom_status_code(self):
        cache = MagicMock()
        result = cache_json_response(cache, "k", {}, 404, timeout=10)
        cache.set.assert_called_once_with("k", ({}, 404), timeout=10)
        assert result == ({}, 404)


class TestCachedValueToResponse:
    def test_none_returns_none(self):
        assert cached_value_to_response(None) is None

    def test_tuple_extracts_payload_and_status(self):
        resp = cached_value_to_response(({"data": "ok"}, 200))
        assert resp.status_code == 200
        assert resp.body is not None

    def test_non_tuple_uses_default_status(self):
        resp = cached_value_to_response({"data": "ok"}, default_status=201)
        assert resp.status_code == 201

    def test_tuple_with_error_status(self):
        resp = cached_value_to_response(({"status": "error"}, 404))
        assert resp.status_code == 404



class TestExtractChannelDataFromLiveCache:
    def test_none_returns_none(self):
        assert extract_channel_data_from_live_cache(None) is None

    def test_normal_cached_response(self):
        cached = ({"data": {"status": "live", "playback_url": "url"}}, 200)
        result = extract_channel_data_from_live_cache(cached)
        assert result == {"status": "live", "playback_url": "url"}

    def test_non_tuple_dict(self):
        cached = {"data": {"status": "offline"}}
        assert extract_channel_data_from_live_cache(cached) == {"status": "offline"}

    def test_missing_data_key(self):
        cached = ({"other": "stuff"}, 200)
        assert extract_channel_data_from_live_cache(cached) is None

    def test_non_dict_payload(self):
        cached = ("string", 200)
        assert extract_channel_data_from_live_cache(cached) is None
