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
    # Patch uvicorn loggers which may create their own handlers
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        for h in logging.getLogger(name).handlers:
            h.setFormatter(fmt)


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


_STATIC_HASHES = _compute_static_hashes(STATIC_DIR)


@asynccontextmanager
async def lifespan(fastapi_app: FastAPI):
    settings = Config.to_dict()
    fastapi_app.state.settings = settings
    fastapi_app.state.cache = cache
    fastapi_app.state.kick_api_client = kick_api_client
    fastapi_app.state.chromecast_service = chromecast_service
    fastapi_app.state.inflight_tracker = inflight_tracker
    fastapi_app.state.circuit_breaker = CircuitBreaker(
        failure_threshold=Config.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
        recovery_timeout=Config.CIRCUIT_BREAKER_RECOVERY_SECONDS,
    )

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
    logger.info("Starting Chromecast device scan during app startup.")
    chromecast_service.scan_for_devices_async(force=True)

    # Periodic background scan keeps the device list fresh without user action
    async def _periodic_chromecast_scan():
        interval = Config.CHROMECAST_PERIODIC_SCAN_INTERVAL
        try:
            while True:
                await asyncio.sleep(interval)
                try:
                    await asyncio.to_thread(chromecast_service.scan_for_devices_async)
                    logger.debug("Periodic Chromecast scan completed.")
                except Exception:
                    logger.warning("Periodic Chromecast scan failed.", exc_info=True)
        except asyncio.CancelledError:
            logger.debug("Periodic Chromecast scan task cancelled.")

    # Periodic sweep of stale in-flight dedup entries (prevents memory leaks)
    async def _periodic_inflight_sweep():
        try:
            while True:
                await asyncio.sleep(60)
                try:
                    inflight_tracker.sweep_stale()
                except Exception:
                    logger.debug("In-flight sweep failed.", exc_info=True)
        except asyncio.CancelledError:
            logger.debug("In-flight sweep task cancelled.")

    scan_task = asyncio.create_task(_periodic_chromecast_scan())
    sweep_task = asyncio.create_task(_periodic_inflight_sweep())

    yield

    scan_task.cancel()
    sweep_task.cancel()
    # Wait for tasks to acknowledge cancellation before proceeding
    for task in (scan_task, sweep_task):
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
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
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


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    if isinstance(exc, HTTPException):
        return error_json(str(exc.detail), exc.status_code)

    logger.error("An unhandled exception occurred: %s", exc, exc_info=True)
    return error_json("An internal server error occurred.", 500)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/config/languages", response_model=LanguagesConfig)
async def get_languages():
    settings = app.state.settings
    return {
        "languages": settings["FEATURED_LANGUAGES"],
        "default_language": settings["DEFAULT_LANGUAGE_CODE"],
    }


if __name__ == "__main__":
    if Config.FLASK_DEBUG:
        uvicorn.run("app:app", host="0.0.0.0", port=Config.PORT, reload=True)
    else:
        uvicorn.run(app, host="0.0.0.0", port=Config.PORT)
