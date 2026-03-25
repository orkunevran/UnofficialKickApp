import re

import requests
from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(self, message: str, status_code: int = 500):
        self.message = message
        self.status_code = int(status_code)
        super().__init__(message)


def sanitize_log_value(value: object) -> str:
    """Sanitize a value for safe inclusion in log messages."""
    return re.sub(r"[^a-zA-Z0-9_\-.]", "_", str(value)) if value else "unknown"


def success_json(data=None, message: str = "", status_code: int = 200) -> JSONResponse:
    payload = {"status": "success", "message": message, "data": data if data is not None else {}}
    return JSONResponse(content=payload, status_code=status_code)


def error_json(message: str, status_code: int) -> JSONResponse:
    payload = {"status": "error", "message": message, "data": {}}
    return JSONResponse(content=payload, status_code=status_code)


def requests_exception_to_api_error(exc: requests.exceptions.RequestException, safe_value: str = "unknown") -> ApiError:
    """Convert a requests exception into an ApiError with an appropriate HTTP status.

    Called from ``kick_call`` in ``_common.py`` which only catches
    ``requests.exceptions.RequestException``, so the parameter type is
    narrowed accordingly — no catch-all for bare ``Exception`` needed.
    """
    if isinstance(exc, requests.exceptions.HTTPError) and exc.response is not None:
        status_code = exc.response.status_code
        if status_code == 404:
            return ApiError(f"Kick channel '{safe_value}' not found.", 404)
        if status_code == 429:
            return ApiError("Rate limited by upstream service. Try again shortly.", 429)
        return ApiError("Failed to fetch data from streaming service.", status_code)

    return ApiError("Error communicating with streaming service.", 500)
