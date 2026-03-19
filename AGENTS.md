# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

**kick-api** is a lightweight, self-hosted Flask proxy API for Kick.com live streams and VODs. It provides both a web UI and a RESTful API with Swagger documentation. The application is designed to be easy to deploy (Docker support) and run on various platforms including Raspberry Pi.

## Development Workflow

### Local Development (Mac)
```bash
# Create and activate virtual environment
python -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Development server (Flask built-in, debug mode)
python app.py  # Runs on http://localhost:8081

# Test endpoints locally
curl http://localhost:8081/config/languages
```

### Deployment to Raspberry Pi
The app is deployed on a Raspberry Pi. Connection details (IP, credentials) should be stored securely outside this repository (e.g., in a local `.env` file or SSH config).

**Prerequisites:** Set up SSH key-based authentication to avoid storing passwords in scripts.

**Deployment directories on Pi:** `/home/pi/Desktop/kick-api-v<X>/` (currently running v3)

**Deploy steps:**
```bash
# 1. Copy your local changes to the Pi (configure PI_HOST in your environment)
rsync -av --delete /Users/humanleague/Desktop/kick-api/ ${PI_USER}@${PI_HOST}:/home/pi/Desktop/kick-api-v4/ --exclude='venv' --exclude='.DS_Store'

# 2. SSH into the Pi and rebuild
ssh ${PI_USER}@${PI_HOST}
cd /home/pi/Desktop/kick-api-v4
docker-compose down
docker-compose up --build -d

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
docker-compose up --build

# Application will be available at http://localhost:8080 (or 8081 with raw compose)
```

## Architecture

### High-Level Structure

```
app.py                          # Flask app initialization, routes registration
├── routes/                     # API endpoint definitions (Flask-RESTX Namespaces)
│   ├── stream_routes.py        # Stream/VOD endpoints
│   └── chromecast_routes.py    # Chromecast device control endpoints
├── services/                   # Business logic layer
│   ├── kick_api_service.py     # HTTP client for Kick.com API
│   ├── cache_service.py        # Cache initialization (Flask-Caching wrapper)
│   └── chromecast_service.py   # Chromecast protocol/communication
├── helpers/                    # Utility functions
│   ├── error_handlers.py       # Error handling decorator
│   └── response_helper.py      # JSON response formatting
├── config.py                   # Configuration from environment variables
├── templates/                  # HTML templates (Jinja2)
└── static/                     # CSS, JavaScript, images
```

### Key Patterns

**Routes & API Design:**
- Routes are organized as Flask-RESTX Namespaces (`ns`) for modular resource definitions
- Each endpoint is a Resource class with HTTP methods (`get`, `post`, etc.)
- Use `@ns.route()` to define paths and `@ns.param()` for documented parameters
- Models defined with `ns.model()` generate Swagger documentation automatically

**Caching Strategy:**
- Cache service wraps Flask-Caching and is initialized early in app startup
- Cache keys follow patterns: `'live:%s'` (channel slug), `'vods:%s'`, `'featured-livestreams'`
- Different TTLs for live data (30s) vs VODs (300s) - configured via environment variables
- Cache is bypassed in error handlers (errors aren't cached)

**Service Layer (Business Logic):**
- `KickAPIClient` in `services/kick_api_service.py` handles all HTTP requests to Kick.com
- Uses Cloudscraper (via requests.Session monkey-patch) to bypass Cloudflare
- Methods: `get_channel_data()`, `get_channel_videos()`, `get_featured_livestreams()`
- All methods are synchronous and handle timeouts (10-15 second defaults)

**Error Handling:**
- `@handle_kick_api_errors` decorator catches exceptions and returns standardized error responses
- Response helpers (`success_response`, `error_response`) ensure consistent JSON format
- HTTP status codes: 404 for not found, 500 for server errors, 307 for redirects

### Special Implementation Details

**Cloudflare Bypass:**
- Dockerfile applies a sitecustomize.py patch that replaces `requests.Session` with `cloudscraper.create_scraper()`
- This happens at import time, so all subsequent HTTP requests from the app use Cloudscraper
- Log output will show `"sitecustomize: requests.Session -> Cloudscraper"` if the patch is active

**Configuration:**
- All configurable values are in `config.py` and come from environment variables
- Key settings: `FLASK_DEBUG`, `PORT`, `LOG_LEVEL`, `KICK_API_BASE_URL`, `KICK_FEATURED_LIVESTREAMS_URL`, cache timeouts, supported languages
- Default port is 8081 (dev) / 8080 (Docker)

## API Endpoints

Main stream-related endpoints (prefix: `/api/streams`):
- `GET /streams/play/<channel_slug>` - Get live stream data (JSON)
- `GET /streams/vods/<channel_slug>` - List VODs for channel (JSON)
- `GET /streams/vods/<channel_slug>/<vod_id>` - Redirect to VOD M3U8 file
- `GET /streams/featured-livestreams?language=<code>` - Get featured streams for language
- `GET /streams/go/<channel_slug>` - Redirect to live stream M3U8

Swagger/OpenAPI docs available at `/docs` when the app is running.

Chromecast endpoints (prefix: `/api/chromecast`):
- Device discovery and playback control endpoints
- See `routes/chromecast_routes.py` for details

## Raspberry Pi Deployment Details

**Current Setup:**
- **OS:** Linux (aarch64 ARMv8)
- **Python:** 3.11.2
- **Deployment:** Docker with docker-compose
- **App Directory:** `/home/pi/Desktop/kick-api-v3` (current production)
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
- **Testing:** The `chromecast_test.py` file can be used to verify Chromecast device discovery and communication.
- **Docker Volume Mounts:** The docker-compose.yml has volume mounting commented out. Uncommenting it enables hot-reloading for development, but it's disabled for production stability.
- **Deployment Versioning:** Use versioned directories (v1, v2, v3, v4...) to keep previous versions on the Pi for easy rollback.
- **Docker Port:** The internal port (8081) is exposed in Dockerfile. Docker Compose uses the same port with `network_mode: host`.
