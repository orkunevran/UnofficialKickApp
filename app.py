import logging
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlencode

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from api.chromecast import router as chromecast_router
from api.errors import ApiError, error_json
from api.schemas import LanguagesConfig
from api.streams import router as streams_router
from config import Config
from services.cache_service import cache
from services.chromecast_service import chromecast_service
from services.kick_api_service import kick_api_client

BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"

logging.basicConfig(level=Config.LOG_LEVEL, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


def _flask_style_url_for(endpoint: str, **values):
    anchor = values.pop("_anchor", values.pop("anchor", None))
    filename = values.pop("filename", None)
    path = values.pop("path", None)

    if endpoint == "static":
        static_path = filename or path
        url = app.url_path_for("static", path=static_path)
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


@asynccontextmanager
async def lifespan(fastapi_app: FastAPI):
    settings = Config.to_dict()
    fastapi_app.state.settings = settings
    fastapi_app.state.cache = cache
    fastapi_app.state.kick_api_client = kick_api_client
    fastapi_app.state.chromecast_service = chromecast_service

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

    yield

    logger.info("Shutting down Chromecast service from FastAPI lifespan.")
    await asyncio.to_thread(chromecast_service.shutdown)


app = FastAPI(
    title="Kick Stream Proxy API",
    version="1.0",
    description="A proxy API for Kick.com live streams and VODs.",
    docs_url="/docs",
    redoc_url=None,
    lifespan=lifespan,
)

templates.env.globals["url_for"] = _flask_style_url_for
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.include_router(streams_router)
app.include_router(chromecast_router)


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
