"""Request context middleware — correlation IDs, timing, and security headers."""

import contextvars
import logging
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

# ── Context variable for request correlation ID ─────────────────────
request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")

logger = logging.getLogger(__name__)

# Security headers applied to every response when SECURITY_HEADERS_ENABLED=True.
# These provide baseline protection against common web vulnerabilities without
# requiring any external dependencies.
_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Adds correlation ID, request timing, and security headers to every response."""

    def __init__(self, app, security_headers_enabled: bool = True):
        super().__init__(app)
        self._security_headers_enabled = security_headers_enabled

    async def dispatch(self, request: Request, call_next) -> Response:
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:8]
        request_id_var.set(rid)
        start = time.monotonic()

        response = await call_next(request)

        duration_ms = (time.monotonic() - start) * 1000
        # Skip noisy status-poll endpoint
        if "/api/chromecast/status" not in request.url.path:
            logger.info(
                "%s %s -> %d (%.1fms) [%s]",
                request.method,
                request.url.path,
                response.status_code,
                duration_ms,
                rid,
            )
        response.headers["X-Request-ID"] = rid

        if self._security_headers_enabled:
            for header, value in _SECURITY_HEADERS.items():
                response.headers.setdefault(header, value)

        return response


class CorrelationIDFormatter(logging.Formatter):
    """Formatter that injects request_id from contextvars into every record.

    This is safer than a Filter because it runs at format time regardless of
    which logger/handler chain emitted the record (including uvicorn's own
    loggers and background thread loggers).
    """

    def format(self, record: logging.LogRecord) -> str:
        if not hasattr(record, "request_id"):
            record.request_id = request_id_var.get("-")
        return super().format(record)
