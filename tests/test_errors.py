"""Tests for api/errors.py — error conversion and response helpers."""

from unittest.mock import MagicMock

import requests

from api.errors import ApiError, requests_exception_to_api_error, sanitize_log_value


class TestRequestsExceptionToApiError:
    """Tests for the error converter used by kick_call."""

    def _make_http_error(self, status_code):
        """Create a requests.HTTPError with a mocked response."""
        response = MagicMock()
        response.status_code = status_code
        exc = requests.exceptions.HTTPError(response=response)
        return exc

    def test_404_returns_channel_not_found(self):
        exc = self._make_http_error(404)
        err = requests_exception_to_api_error(exc, "xqc")
        assert err.status_code == 404
        assert "xqc" in err.message
        assert "not found" in err.message.lower()

    def test_429_returns_rate_limited(self):
        exc = self._make_http_error(429)
        err = requests_exception_to_api_error(exc, "test")
        assert err.status_code == 429
        assert "rate limited" in err.message.lower()

    def test_500_returns_generic_fetch_error(self):
        exc = self._make_http_error(500)
        err = requests_exception_to_api_error(exc, "test")
        assert err.status_code == 500
        assert "failed to fetch" in err.message.lower()

    def test_http_error_with_none_response(self):
        """HTTPError can have response=None in edge cases."""
        exc = requests.exceptions.HTTPError(response=None)
        err = requests_exception_to_api_error(exc, "test")
        # Should fall through to the generic RequestException branch
        assert err.status_code == 500
        assert "communicating" in err.message.lower()

    def test_connection_error(self):
        exc = requests.exceptions.ConnectionError("Connection refused")
        err = requests_exception_to_api_error(exc, "test")
        assert err.status_code == 500
        assert "communicating" in err.message.lower()

    def test_timeout_error(self):
        exc = requests.exceptions.Timeout("Read timed out")
        err = requests_exception_to_api_error(exc, "test")
        assert err.status_code == 500

    def test_generic_request_exception(self):
        exc = requests.exceptions.RequestException("Something went wrong")
        err = requests_exception_to_api_error(exc, "test")
        assert err.status_code == 500


class TestSanitizeLogValue:
    def test_normal_value(self):
        assert sanitize_log_value("xqc") == "xqc"

    def test_special_characters_replaced(self):
        assert sanitize_log_value("bad slug!@#") == "bad_slug___"

    def test_none_returns_unknown(self):
        assert sanitize_log_value(None) == "unknown"

    def test_empty_string_returns_unknown(self):
        assert sanitize_log_value("") == "unknown"

    def test_numeric_value(self):
        assert sanitize_log_value(42) == "42"


class TestApiError:
    def test_message_and_status(self):
        err = ApiError("test message", 404)
        assert err.message == "test message"
        assert err.status_code == 404
        assert str(err) == "test message"

    def test_default_status_is_500(self):
        err = ApiError("internal error")
        assert err.status_code == 500
