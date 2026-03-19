import re

import requests
from fastapi.responses import JSONResponse

from helpers.response_helper import error_response, success_response


class ApiError(Exception):
    def __init__(self, message: str, status_code: int = 500):
        self.message = message
        self.status_code = int(status_code)
        super().__init__(message)


def sanitize_log_value(value) -> str:
    return re.sub(r"[^a-zA-Z0-9_\-.]", "_", str(value)) if value else "unknown"


def success_json(data=None, message: str = "", status_code: int = 200) -> JSONResponse:
    payload, status = success_response(data, message, status_code)
    return JSONResponse(content=payload, status_code=status)


def error_json(message: str, status_code: int) -> JSONResponse:
    payload, status = error_response(message, status_code)
    return JSONResponse(content=payload, status_code=status)


def requests_exception_to_api_error(exc: Exception, safe_value: str = "unknown") -> ApiError:
    if isinstance(exc, requests.exceptions.HTTPError):
        status_code = exc.response.status_code if exc.response is not None else 500
        if status_code == 404:
            return ApiError(f"Kick channel '{safe_value}' not found.", 404)
        return ApiError("Failed to fetch data from streaming service.", status_code)

    if isinstance(exc, requests.exceptions.RequestException):
        return ApiError("Error communicating with streaming service.", 500)

    return ApiError("An internal server error occurred.", 500)
