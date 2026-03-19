# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

**kick-api** is a lightweight, self-hosted FastAPI proxy API for Kick.com live streams and VODs. It provides both a web UI and a RESTful API with Swagger documentation. The application is designed to be easy to deploy (Docker support) and run on various platforms including Raspberry Pi.

## Development Workflow

### Local Development (Mac)
```bash
# Create and activate virtual environment
python -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Development server (Uvicorn with reload in debug mode)
python app.py  # or: uvicorn app:app --reload

# Test endpoints locally
curl http://localhost:8081/config/languages
```

### Deployment to Raspberry Pi
The app is deployed on a Raspberry Pi. Connection details (IP, credentials) should be stored securely outside this repository (for example in `~/.kick-api.env` or SSH config).

**Prerequisites:** Set up SSH key-based authentication to avoid storing passwords in scripts.

**Deployment directories on Pi:** `/home/pi/Desktop/kick-api-v<X>/` (use versioned directories for rollback)

**Deploy steps:**
```bash
# 1. Copy your local changes to the Pi (set PI_HOST / PI_USER first)
rsync -av --delete ./ ${PI_USER}@${PI_HOST}:${DEPLOY_DIR}/ --exclude='venv' --exclude='.DS_Store'

# 2. SSH into the Pi and rebuild
ssh ${PI_USER}@${PI_HOST}
cd ${DEPLOY_DIR}
docker compose down
docker compose up --build -d

# 3. Verify the deployment
curl http://${PI_HOST}:8081/config/languages
docker logs kick-api-kick-proxy-1
```

### Local Testing
```bash
# Run chromecast tests (requires local environment)
python chromecast_test.py
```

### Docker (Local Testing on Mac)
```bash
# Build image
docker build -t kick-api:latest .

# Run with Docker Compose
docker compose up --build

# Application will be available at http://localhost:8080 (or 8081 with raw compose)
```

## Architecture

### High-Level Structure

```
app.py                          # FastAPI app initialization and router registration
├── api/                        # Native FastAPI route modules
│   ├── streams.py              # Stream/VOD/clip/search/avatar/viewer endpoints
│   ├── chromecast.py           # Chromecast device control endpoints
│   ├── cache.py                # Cache key helpers and response serialization
│   ├── errors.py               # ApiError and response helpers
│   └── schemas.py              # Pydantic request/response schemas
├── services/                   # Business logic layer
│   ├── kick_api_service.py     # HTTP client for Kick.com API
│   ├── cache_service.py        # Transport-neutral in-memory cache adapter
│   └── chromecast_service.py   # Chromecast protocol/communication
├── helpers/                    # Utility functions
│   └── response_helper.py      # JSON response formatting
├── config.py                   # Configuration from environment variables
├── templates/                  # HTML templates (Jinja2)
├── static/                     # CSS, JavaScript, images
└── tests/                      # pytest contract and service tests
```

### Key Patterns

**Routes & API Design:**
- Routes are organized as FastAPI routers in `api/` and registered from `app.py`
- Endpoints are async functions; blocking Kick API calls are wrapped with `asyncio.to_thread()`
- Keep response envelopes and HTTP status codes stable during transport changes
- Use native FastAPI/OpenAPI docs at `/docs` for schema generation and interactive testing

**Caching Strategy:**
- Cache service is a transport-neutral in-memory adapter initialized during app startup
- Cache keys follow the existing route-based patterns for live data, VODs, featured streams, clips, avatars, search, viewers, and Chromecast redirects
- Different TTLs for live data, featured streams, VODs/clips, avatars, search, and viewer counts - configured via environment variables
- Cache entries are written only for successful responses

**Service Layer (Business Logic):**
- `KickAPIClient` in `services/kick_api_service.py` handles all HTTP requests to Kick.com
- Uses Cloudscraper (via requests.Session monkey-patch) to bypass Cloudflare
- Methods: `get_channel_data()`, `get_channel_videos()`, `get_featured_livestreams()`, `get_all_livestreams()`, `get_channel_clips()`, `search_channels_typesense()`, `get_viewer_count()`
- All methods are synchronous and handle timeouts (10-15 second defaults)

**Error Handling:**
- FastAPI exception handlers return standardized error responses from `api/errors.py`
- Response helpers (`success_json`, `error_json`) ensure consistent JSON format
- HTTP status codes: 400 for validation errors, 404 for not found, 500 for server errors, 307 for redirects

### Special Implementation Details

**Cloudflare Bypass:**
- Dockerfile applies a sitecustomize.py patch that replaces `requests.Session` with `cloudscraper.create_scraper()`
- This happens at import time, so all subsequent HTTP requests from the app use Cloudscraper
- Log output will show `"sitecustomize: requests.Session -> Cloudscraper"` if the patch is active

**Configuration:**
- All configurable values are in `config.py` and come from environment variables
- Key settings: `FLASK_DEBUG`, `PORT`, `LOG_LEVEL`, `KICK_API_BASE_URL`, `KICK_FEATURED_LIVESTREAMS_URL`, `KICK_ALL_LIVESTREAMS_URL`, cache timeouts, supported languages, Chromecast settings
- Default port is 8081 (dev) / 8080 (Docker)

## API Endpoints

Main stream-related endpoints (prefix: `/streams`):
- `GET /streams/play/{channel_slug}` - Get live stream data (JSON)
- `GET /streams/go/{channel_slug}` - Redirect to live stream M3U8
- `GET /streams/vods/{channel_slug}` - List VODs for channel (JSON)
- `GET /streams/vods/{channel_slug}/{vod_id}` - Redirect to VOD M3U8 file
- `GET /streams/clips/{channel_slug}` - List channel clips
- `GET /streams/featured-livestreams?language=<code>&page=<n>` - Get featured streams for language
- `GET /streams/search?q=<query>` - Search Kick channels
- `GET /streams/avatar/{channel_slug}` - Get the channel profile image URL
- `GET /streams/viewers?id=<livestream_id>` - Get current viewer count for a live stream

Config endpoint:
- `GET /config/languages` - Supported language codes and default language

Swagger/OpenAPI docs available at `/docs` when the app is running.

Chromecast endpoints (prefix: `/api/chromecast`):
- `GET /api/chromecast/devices` - List discovered devices
- `GET /api/chromecast/status` - Current cast status
- `GET /api/chromecast/last-device` - Last used device
- `POST /api/chromecast/select` - Select a device
- `POST /api/chromecast/cast` - Start casting
- `POST /api/chromecast/stop` - Stop casting

## Raspberry Pi Deployment Details

**Current Setup:**
- **OS:** Linux (aarch64 ARMv8)
- **Python:** 3.11.2
- **Deployment:** Docker with `docker compose`
- **App Directory:** `/home/pi/Desktop/kick-api-v<version>` (see `DEPLOY_DIR` in `deploy.sh`)
- **Network Mode:** `host` (direct access to Pi's port 8081)
- **Restart Policy:** `always` (auto-restarts on failure or reboot)
- **Container Name:** `kick-api-kick-proxy-1`

**Chromecast Integration:**
- Chromecast devices are auto-discovered on the local network
- Chromecast service handles connection retries and graceful reconnection

**Port Mapping:**
- Pi internal port: 8081 (exposed in Dockerfile)
- Swagger docs available at: `http://<PI_HOST>:8081/docs`

## Important Notes

- **Cloudscraper Requirement:** The app relies on Cloudscraper to bypass Cloudflare. If Kick changes their protection, updates may be needed. Look for `403 Forbidden` errors in logs.
- **Cache Keys & TTL:** When modifying API endpoints or responses, consider cache key naming and whether existing cache should be invalidated.
- **Language Support:** Featured streams support multiple languages (en, tr, es, de, fr, ru). Language codes are configurable in `Config.FEATURED_LANGUAGES`.
- **Testing:** Run `pytest tests/` for contract coverage; `chromecast_test.py` remains available for manual Chromecast checks.
- **Docker Volume Mounts:** The compose file has volume mounting commented out. Uncommenting it enables hot-reloading for development, but it's disabled for production stability.
- **Deployment Versioning:** Use versioned directories (v1, v2, v3, v4...) to keep previous versions on the Pi for easy rollback.
- **Docker Port:** The internal port (8081) is exposed in Dockerfile. Docker Compose uses the same port with `network_mode: host`.
