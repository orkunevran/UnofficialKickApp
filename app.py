import asyncio
import hashlib
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

logging.basicConfig(level=Config.LOG_LEVEL, format="%(asctime)s %(levelname)s [%(request_id)s] %(message)s")
# Replace all formatters with CorrelationIDFormatter so request_id is injected
# at format time — works for all loggers including uvicorn's and background threads
_cid_fmt = CorrelationIDFormatter("%(asctime)s %(levelname)s [%(request_id)s] %(message)s")
for _handler in logging.getLogger().handlers:
    _handler.setFormatter(_cid_fmt)
# Also patch uvicorn's loggers which may create their own handlers later
for _name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
    _uv_logger = logging.getLogger(_name)
    for _h in _uv_logger.handlers:
        _h.setFormatter(_cid_fmt)
logger = logging.getLogger(__name__)


# Suppress noisy /api/chromecast/status polling lines from uvicorn access log
class _StatusPollFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return "/api/chromecast/status" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_StatusPollFilter())


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

    if Config.ASYNCIO_THREAD_WORKERS > 0:
        loop = asyncio.get_event_loop()
        loop.set_default_executor(
            ThreadPoolExecutor(
                max_workers=Config.ASYNCIO_THREAD_WORKERS,
                thread_name_prefix="kick-worker",
            )
        )
        logger.info("asyncio default executor set to %d workers.", Config.ASYNCIO_THREAD_WORKERS)

    cache.init_app(settings)
    chromecast_service.configure(settings)
    logger.info("Starting Chromecast device scan during app startup.")
    chromecast_service.scan_for_devices_async(force=True)

    # Periodic background scan keeps the device list fresh without user action
    async def _periodic_chromecast_scan():
        interval = Config.CHROMECAST_PERIODIC_SCAN_INTERVAL
        while True:
            await asyncio.sleep(interval)
            try:
                await asyncio.to_thread(chromecast_service.scan_for_devices_async)
                logger.debug("Periodic Chromecast scan completed.")
            except Exception:
                logger.warning("Periodic Chromecast scan failed.", exc_info=True)

    # Periodic sweep of stale in-flight dedup entries (prevents memory leaks)
    async def _periodic_inflight_sweep():
        while True:
            await asyncio.sleep(60)
            try:
                inflight_tracker.sweep_stale()
            except Exception:
                logger.debug("In-flight sweep failed.", exc_info=True)

    scan_task = asyncio.create_task(_periodic_chromecast_scan())
    sweep_task = asyncio.create_task(_periodic_inflight_sweep())

    yield

    scan_task.cancel()
    sweep_task.cancel()
    logger.info("Shutting down Chromecast service from FastAPI lifespan.")
    await asyncio.to_thread(chromecast_service.shutdown)


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
