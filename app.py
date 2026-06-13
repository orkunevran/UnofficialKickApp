import asyncio
import hashlib
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlencode

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import Response as StarletteResponse

from api.cache import inflight_tracker
from api.chromecast import router as chromecast_router
from api.errors import ApiError, error_json
from api.health import router as health_router
from api.metrics import router as metrics_router
from api.middleware import CorrelationIDFormatter, RequestContextMiddleware
from api.routes import channel_router, discovery_router, featured_router, vods_router
from api.schemas import LanguagesConfig
from config import Config
from services.cache_service import cache
from services.chromecast_service import chromecast_service
from services.circuit_breaker import CircuitBreaker
from services.kick_api_service import kick_api_client
from services.log_throttle import RepeatSuppressingFilter, ThrottledErrorLog

BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"


# ── Logging setup ─────────────────────────────────────────────────────────
class _JSONFormatter(logging.Formatter):
    """Structured JSON log formatter for production log aggregation.

    Each log line is a single JSON object with ts, level, request_id,
    logger, and message fields. Exception tracebacks are included as
    an 'exception' field when present. Works with ELK, Loki, Datadog,
    and other log aggregation pipelines that expect structured input.
    """

    def format(self, record: logging.LogRecord) -> str:
        from api.middleware import request_id_var
        if not hasattr(record, "request_id"):
            record.request_id = request_id_var.get("-")
        entry = {
            "ts": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "request_id": record.request_id,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info and record.exc_info[1]:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


def _setup_logging() -> None:
    """Configure logging with either plain-text or structured JSON format.

    When LOG_FORMAT_JSON=True, all log output becomes single-line JSON
    objects suitable for machine parsing. When False (default), the
    traditional human-readable format with correlation IDs is used.
    """
    fmt: logging.Formatter
    if Config.LOG_FORMAT_JSON:
        fmt = _JSONFormatter()
    else:
        fmt = CorrelationIDFormatter("%(asctime)s %(levelname)s [%(request_id)s] %(message)s")

    logging.basicConfig(level=Config.LOG_LEVEL, format="%(message)s")
    for handler in logging.getLogger().handlers:
        handler.setFormatter(fmt)
    # Patch uvicorn loggers which may create their own handlers.
    # Disable propagation so a log line emitted by uvicorn's own handler is
    # not also emitted by the root handler — that would double every line.
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        uvicorn_logger = logging.getLogger(name)
        for h in uvicorn_logger.handlers:
            h.setFormatter(fmt)
        uvicorn_logger.propagate = False

    # Third-party libraries that log inside their own retry loops with no
    # backoff are existential threats to disk health on a Pi. Attach the
    # dedup filter so a stuck reconnect storm can never flood again.
    # (Real-world precedent: pychromecast socket_client emits 25 identical
    # AssertionError tracebacks/sec when a zeroconf instance dies under it.)
    _repeat_filter = RepeatSuppressingFilter(window_size=200)
    for name in ("pychromecast", "pychromecast.socket_client", "zeroconf", "urllib3"):
        logging.getLogger(name).addFilter(_repeat_filter)


_setup_logging()
logger = logging.getLogger(__name__)


def _flask_style_url_for(endpoint: str, **values):
    anchor = values.pop("_anchor", values.pop("anchor", None))
    filename = values.pop("filename", None)
    path = values.pop("path", None)

    if endpoint == "static":
        static_path = filename or path
        url = app.url_path_for("static", path=static_path)
        # Replace manual version with content-hash for cache busting
        file_hash = _STATIC_HASHES.get(static_path)
        if file_hash:
            url = f"{url}?h={file_hash}"
            return str(url)
    else:
        url = app.url_path_for(endpoint, **values)

    if values:
        query = urlencode(values, doseq=True)
        if query:
            url = f"{url}?{query}"

    if anchor:
        url = f"{url}#{anchor}"

    return str(url)


templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


# ── Hash-based cache busting ──────────────────────────────────────────────
def _compute_static_hashes(static_dir: Path) -> dict[str, str]:
    """Compute MD5 hashes of static files at startup for cache busting."""
    hashes = {}
    for path in static_dir.rglob("*"):
        if path.is_file() and path.suffix in (".js", ".css", ".svg"):
            rel = str(path.relative_to(static_dir))
            hashes[rel] = hashlib.md5(path.read_bytes()).hexdigest()[:8]
    return hashes


# Static hashes are populated lazily in lifespan startup rather than at import
# time — keeps module import side-effect-free and unblocks faster cold boots.
_STATIC_HASHES: dict[str, str] = {}


class _ImmutableStaticFiles(StaticFiles):
    """StaticFiles that adds long-lived Cache-Control when the URL is hash-busted.

    Our Jinja `url_for('static', ...)` appends `?h=<md5>` to every CSS/JS/SVG
    URL. Because the hash changes whenever the file content changes, the
    request is safe to cache forever — browsers will fetch a new URL the
    moment the asset is updated. Without `Cache-Control`, browsers re-validate
    every load (304s), costing ~13 ms per asset over LAN.
    """

    async def get_response(self, path: str, scope):
        response: StarletteResponse = await super().get_response(path, scope)
        if response.status_code == 200:
            query_string = scope.get("query_string", b"")
            if b"h=" in query_string:
                response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            else:
                # Even without the hash, set a modest cache so repeat loads
                # within a session don't re-validate every asset.
                response.headers.setdefault("Cache-Control", "public, max-age=300")
        return response


@asynccontextmanager
async def lifespan(fastapi_app: FastAPI):
    settings = Config.to_dict()
    fastapi_app.state.settings = settings
    fastapi_app.state.cache = cache
    fastapi_app.state.kick_api_client = kick_api_client
    fastapi_app.state.chromecast_service = chromecast_service
    fastapi_app.state.inflight_tracker = inflight_tracker
    critical_cb = CircuitBreaker(
        failure_threshold=Config.CIRCUIT_BREAKER_CRITICAL_FAILURE_THRESHOLD,
        recovery_timeout=Config.CIRCUIT_BREAKER_RECOVERY_SECONDS,
    )
    non_critical_cb = CircuitBreaker(
        failure_threshold=Config.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
        recovery_timeout=Config.CIRCUIT_BREAKER_RECOVERY_SECONDS,
    )
    fastapi_app.state.circuit_breaker_critical = critical_cb
    fastapi_app.state.circuit_breaker_non_critical = non_critical_cb
    fastapi_app.state.non_critical_thread_limiter = asyncio.Semaphore(Config.NON_CRITICAL_THREAD_OP_CONCURRENCY)
    fastapi_app.state.background_refresh_limiter = asyncio.Semaphore(Config.BACKGROUND_REFRESH_MAX_CONCURRENCY)

    executor = None
    if Config.ASYNCIO_THREAD_WORKERS > 0:
        executor = ThreadPoolExecutor(
            max_workers=Config.ASYNCIO_THREAD_WORKERS,
            thread_name_prefix="kick-worker",
        )
        asyncio.get_running_loop().set_default_executor(executor)
        logger.info("asyncio default executor set to %d workers.", Config.ASYNCIO_THREAD_WORKERS)

    cache.init_app(settings)
    chromecast_service.configure(settings)

    # Compute static-asset hashes for cache-busting (moved out of import time).
    global _STATIC_HASHES
    _STATIC_HASHES = await asyncio.to_thread(_compute_static_hashes, STATIC_DIR)

    logger.info("Starting Chromecast device scan during app startup.")
    chromecast_service.scan_for_devices_async(force=True)

    # Warm featured-streams cache for every configured language so the first
    # visitor doesn't pay the 1.5 s Cloudflare resolution cost. Measured:
    # kick.com cold call ≈ 1.6 s, cache-hit response ≈ 30 ms.
    #
    # The cache key produced by request_cache_key() is built from the EXACT
    # query string the client sent, sorted by key. The frontend sends only
    # `?language=XX`, so that's the variant we must populate.
    async def _warm_featured_streams():
        from api.routes._common import kick_call
        from services.transformers import build_featured_response, warm_caches_from_featured

        languages = [lang["code"] for lang in settings.get("FEATURED_LANGUAGES", [])]
        if not languages:
            return
        started = asyncio.get_running_loop().time()
        succeeded = 0
        for code in languages:
            try:
                async with fastapi_app.state.non_critical_thread_limiter:
                    raw = await kick_call(
                        kick_api_client.get_featured_livestreams,
                        code,
                        1,
                        safe_value=code,
                        circuit_breaker=non_critical_cb,
                        circuit_breaker_name="non_critical",
                    )
                response_body = build_featured_response(raw, 1)
                # Match request_cache_key() exactly: prefix:path?sorted-query.
                path = "/streams/featured-livestreams"
                # Frontend variant: ?language=XX only (alphabetic sort puts
                # language first when paired with page).
                for query in (
                    urlencode([("language", code)]),
                    urlencode(sorted([("language", code), ("page", "1")])),
                ):
                    stale_key = f"featured-livestreams:{path}?{query}"
                    fresh_key = f"featured-fresh:{path}?{query}"
                    cache.set(stale_key, (response_body, 200), timeout=Config.FEATURED_STALE_TTL_SECONDS)
                    cache.set(fresh_key, True, timeout=Config.FEATURED_CACHE_DURATION_SECONDS)
                warm_caches_from_featured(cache, response_body.get("data", []))
                succeeded += 1
            except Exception as exc:
                logger.warning(
                    "Featured warm-up failed for language=%s: %s: %s",
                    code, type(exc).__name__, exc,
                )
        elapsed = asyncio.get_running_loop().time() - started
        logger.info(
            "Featured warm-up completed: %d/%d languages in %.2fs.",
            succeeded, len(languages), elapsed,
        )

    # Warm Typesense key in background so first /streams/search request does not
    # block while scraping Kick JS bundles for key refresh.
    async def _warm_typesense_key():
        started = asyncio.get_running_loop().time()
        try:
            async with fastapi_app.state.non_critical_thread_limiter:
                await asyncio.to_thread(kick_api_client._get_typesense_key)  # noqa: SLF001 - intentional startup warm-up
            elapsed = asyncio.get_running_loop().time() - started
            logger.info("Typesense key warm-up completed in %.2fs.", elapsed)
        except Exception as exc:
            logger.warning("Typesense key warm-up failed: %s: %s", type(exc).__name__, exc)

    # Periodic background scan keeps the device list fresh without user action.
    # When the LAN has no Chromecasts (or the container can't reach them), each
    # scan still does up to ~1500 TCP-connect probes in the fallback path.
    # Apply exponential backoff after consecutive empty scans so a network with
    # no devices doesn't churn the disk every 90 s forever.
    scan_error_log = ThrottledErrorLog(summary_every=60)
    async def _periodic_chromecast_scan():
        base_interval = Config.CHROMECAST_PERIODIC_SCAN_INTERVAL
        max_interval = max(base_interval, 30 * 60)  # cap at 30 min
        interval = base_interval
        consecutive_empty = 0
        try:
            while True:
                await asyncio.sleep(interval)
                try:
                    await asyncio.to_thread(chromecast_service.scan_for_devices_async)
                except Exception as exc:
                    scan_error_log.warn(logger, "Periodic Chromecast scan failed", exc)

                # Adaptive interval: keep the fast cadence when devices are present;
                # back off when scan after scan returns nothing.
                if chromecast_service.get_devices():
                    if interval != base_interval:
                        logger.info("Chromecast found again — resetting scan interval to %ds.", base_interval)
                    consecutive_empty = 0
                    interval = base_interval
                else:
                    consecutive_empty += 1
                    if consecutive_empty >= 3:
                        new_interval = min(max_interval, base_interval * (2 ** min(consecutive_empty - 2, 6)))
                        if new_interval != interval:
                            logger.info(
                                "No Chromecasts seen in %d scans — backing off scan interval to %ds.",
                                consecutive_empty,
                                new_interval,
                            )
                            interval = new_interval
        except asyncio.CancelledError:
            pass

    # Periodic sweep of stale in-flight dedup entries (prevents memory leaks)
    sweep_error_log = ThrottledErrorLog(summary_every=60)
    async def _periodic_inflight_sweep():
        try:
            while True:
                await asyncio.sleep(60)
                try:
                    inflight_tracker.sweep_stale()
                except Exception as exc:
                    sweep_error_log.warn(logger, "In-flight sweep failed", exc)
        except asyncio.CancelledError:
            pass

    scan_task = asyncio.create_task(_periodic_chromecast_scan())
    sweep_task = asyncio.create_task(_periodic_inflight_sweep())
    typesense_warm_task = asyncio.create_task(_warm_typesense_key())
    featured_warm_task = asyncio.create_task(_warm_featured_streams())

    yield

    scan_task.cancel()
    sweep_task.cancel()
    typesense_warm_task.cancel()
    featured_warm_task.cancel()
    # Wait for tasks to acknowledge cancellation before proceeding
    for task in (scan_task, sweep_task, typesense_warm_task, featured_warm_task):
        try:
            await task
        except asyncio.CancelledError:
            pass

    logger.info("Shutting down Chromecast service from FastAPI lifespan.")
    await asyncio.to_thread(chromecast_service.shutdown)

    if executor is not None:
        executor.shutdown(wait=False)
        logger.info("Thread pool executor shut down.")


app = FastAPI(
    title="Kick Stream Proxy API",
    version="3.1.0",
    description="A proxy API for Kick.com live streams and VODs.",
    docs_url="/docs",
    redoc_url=None,
    lifespan=lifespan,
)

app.add_middleware(RequestContextMiddleware, security_headers_enabled=Config.SECURITY_HEADERS_ENABLED)
# GZip everything over 1 KB. Saves ~75 % on HTML/JS/CSS/JSON responses for any
# client honouring Accept-Encoding (which is all modern browsers and curl).
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)

# CORS — only enabled when CORS_ORIGINS is set (comma-separated list)
if Config.CORS_ORIGINS:
    from starlette.middleware.cors import CORSMiddleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in Config.CORS_ORIGINS.split(",") if o.strip()],
        allow_credentials=Config.CORS_ALLOW_CREDENTIALS,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

templates.env.globals["url_for"] = _flask_style_url_for
app.mount("/static", _ImmutableStaticFiles(directory=str(STATIC_DIR)), name="static")
app.include_router(channel_router)
app.include_router(vods_router)
app.include_router(featured_router)
app.include_router(discovery_router)
app.include_router(chromecast_router)
app.include_router(metrics_router)
app.include_router(health_router)


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError):
    return error_json(exc.message, exc.status_code)


_unhandled_error_log = ThrottledErrorLog(summary_every=100)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    if isinstance(exc, HTTPException):
        return error_json(str(exc.detail), exc.status_code)

    _unhandled_error_log.warn(logger, f"Unhandled exception on {request.method} {request.url.path}", exc)
    return error_json("An internal server error occurred.", 500)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


@app.get("/config/languages", response_model=LanguagesConfig)
async def get_languages():
    settings = app.state.settings
    return {
        "languages": settings["FEATURED_LANGUAGES"],
        "default_language": settings["DEFAULT_LANGUAGE_CODE"],
    }


if __name__ == "__main__":
    # access_log=False: RequestContextMiddleware already logs every request
    # with correlation ID and timing; uvicorn's parallel access log is pure
    # duplicate noise.
    if Config.DEBUG:
        uvicorn.run("app:app", host="0.0.0.0", port=Config.PORT, reload=True, access_log=False)
    else:
        uvicorn.run(app, host="0.0.0.0", port=Config.PORT, access_log=False)
