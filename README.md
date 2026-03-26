# Unofficial Kick App

<p align="center">
  <img src="static/Kick_logo.svg" alt="Kick Logo" width="100"/>
</p>

<p align="center">
  <strong>A lightweight, self-hosted FastAPI web app and proxy API for Kick.com streams.</strong>
</p>

<p align="center">
  <code>v3.1.0</code>&ensp;·&ensp;Python 3.11+&ensp;·&ensp;FastAPI&ensp;·&ensp;Vanilla JS SPA&ensp;·&ensp;Docker
</p>

---

Unofficial Kick App provides a web UI plus a REST API for Kick.com live streams, VODs, clips, featured streams, search, and Chromecast playback. It is designed to run locally, in Docker, or on a small home server such as a Raspberry Pi.

## Features

### Streaming & Playback
- Live stream lookup with HLS playback and quality picker
- Seamless mini-player handoff — live playback keeps running while you browse other channels
- Resizable mini-player video panel with drag-to-resize and double-click expand
- Picture-in-Picture support
- VOD browsing with direct playback redirection
- Recent clip browsing with search filtering
- Chromecast device discovery, fallback subnet probing, cast control, and SSE status streaming

### Discovery & Navigation
- Featured streams with infinite scroll, language and category filtering
- Smart prefetching — next page is cached in the background before you scroll to it
- Two-tier channel search: instant local results + full Typesense server-side search with keyboard navigation
- Favorites and History tracking with localStorage persistence
- SPA architecture with hash-based client-side routing and View Transitions

### UI & Design
- System/Light/Dark theme toggle with `prefers-color-scheme` auto-detection
- Atmospheric grain texture overlay and ambient glow orbs
- Syne display typography for headers, Inter for UI text
- Staggered card entrance animations and enhanced hover glow effects
- Glassmorphism surfaces, skeleton loaders, and smooth transitions
- Keyboard shortcuts modal (`?`) with two-key navigation combos (`g b`, `g f`, `g h`, `g s`)
- WCAG AA accessible: skip link, focus rings, ARIA combobox search, tab pattern, `prefers-contrast` and `prefers-reduced-motion` support

### Backend & Operations
- Circuit breaker for upstream API resilience
- Stale-while-revalidate caching with in-flight deduplication
- Request correlation IDs and structured logging
- LRU-bounded in-memory cache with hit/miss stats and max-size eviction
- Batch viewer count endpoint (up to 50 IDs in one request)
- Swagger/OpenAPI docs at `/docs`
- Operational metrics at `/metrics`
- 68 tests (contract, unit, concurrency, lifecycle)
- GitHub Actions CI pipeline
- Cloudscraper-based Kick API access with thread-safe per-worker sessions

## Quick Start

### Clone

```bash
git clone https://github.com/orkunevran/UnofficialKickApp.git
cd UnofficialKickApp
```

### Run with Docker

```bash
docker compose up --build
```

The app will be available at `http://localhost:8081`.

## Local Development

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # customize if needed
python app.py
# or: uvicorn app:app --reload
```

The app will be available at `http://localhost:8081`.

### Running Tests

```bash
pytest tests/ -v
```

The test suite includes 102 tests across 10 modules:

| Module | Coverage |
| --- | --- |
| `test_fastapi_parity.py` | API contract tests for all endpoints (26 tests) |
| `test_transformers.py` | Data transformation edge cases (17 tests) |
| `test_route_helpers.py` | Thumbnail extraction, category parsing (14 tests) |
| `test_cache_service.py` | Cache LRU eviction, TTL, thread safety (11 tests) |
| `test_inflight_tracker.py` | Async dedup: waiters, timeout, sweep (11 tests) |
| `test_circuit_breaker.py` | State machine transitions, half-open probe (8 tests) |
| `test_chromecast_service.py` | Device discovery lifecycle (6 tests) |
| `test_health_and_middleware.py` | Health endpoint, security headers (4 tests) |
| `test_kick_api_service.py` | Typesense key concurrency and fallback (4 tests) |
| `test_lifespan.py` | App startup/shutdown sequence (1 test) |

Tests use `monkeypatch` to stub service methods and `httpx.ASGITransport` for direct FastAPI testing without a live server.

## API Endpoints

### Stream Routes

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/streams/play/{channel_slug}` | Get live stream data for a channel |
| `GET` | `/streams/go/{channel_slug}` | Redirect to the live HLS playback URL |
| `GET` | `/streams/vods/{channel_slug}` | List VODs for a channel |
| `GET` | `/streams/vods/{channel_slug}/{vod_id}` | Redirect to a specific VOD |
| `GET` | `/streams/clips/{channel_slug}` | List recent clips for a channel |
| `GET` | `/streams/featured-livestreams?language=&page=&category=&subcategory=&sort=&strict=` | Get featured/filtered streams |
| `GET` | `/streams/search?q={query}` | Search Kick channels via Typesense |
| `GET` | `/streams/avatar/{channel_slug}` | Get the channel profile image URL |
| `GET` | `/streams/viewers?id={livestream_id}` | Get current viewer count for a live stream |
| `GET` | `/streams/viewers/batch?ids={id1},{id2},...` | Batch viewer counts (up to 50, chunked at 10) |
| `GET` | `/config/languages` | Get available featured stream languages |

### Chromecast Routes

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/chromecast/devices` | Discover available Chromecast devices |
| `POST` | `/api/chromecast/select` | Select a Chromecast device |
| `POST` | `/api/chromecast/cast` | Start casting a stream |
| `POST` | `/api/chromecast/stop` | Stop or disconnect casting |
| `GET` | `/api/chromecast/last-device` | Get the last connected device |
| `GET` | `/api/chromecast/status` | Get Chromecast connection status |
| `GET` | `/api/chromecast/status/stream` | SSE stream for live Chromecast status updates |

### Operational Routes

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/health` | Component-level health check (cache, circuit breaker); 200 or 503 |
| `GET` | `/health/live` | Minimal liveness probe (always 200) |
| `GET` | `/metrics` | Cache stats, circuit breaker state, upstream call count, uptime |
| `GET` | `/docs` | Interactive Swagger/OpenAPI documentation |

## Architecture

```
app.py                              # FastAPI init, lifespan, middleware, router registration
config.py                           # pydantic-settings with env var validation
api/
  deps.py                           # FastAPI Depends() — CacheDep, KickClientDep, ChromecastDep
  middleware.py                      # Correlation ID + request timing middleware
  metrics.py                        # /metrics endpoint
  cache.py                          # In-flight dedup (InflightTracker) + cache helpers
  errors.py                         # ApiError, success_json/error_json
  schemas.py                        # Pydantic request/response models
  chromecast.py                     # Chromecast endpoints + SSE status stream
  routes/
    _common.py                      # kick_call (with circuit breaker), validate_slug
    channel.py                      # /play, /go, /avatar, /clips
    vods.py                         # /vods/{slug}, /vods/{slug}/{id}
    featured.py                     # /featured-livestreams (stale-while-revalidate)
    discovery.py                    # /search, /viewers, /viewers/batch
services/
  kick_api_service.py               # HTTP client for Kick.com (Cloudscraper, thread-local sessions)
  cache_service.py                  # LRU in-memory cache with max_size and stats
  circuit_breaker.py                # Upstream circuit breaker (closed/open/half-open)
  chromecast_service.py             # Chromecast device discovery and cast control
  transformers.py                   # Pure data transformations + cache warm-up
templates/
  index.html                        # SPA shell with Jinja2 hash-based cache busting
static/
  style.css                         # Full design system (CSS variables, both themes, responsive)
  script.js                         # Main entry: router, search, theme system, modal inert mgmt
  js/
    router.js                       # Hash-based SPA router with View Transitions
    state.js                        # Central app state + preferences (localStorage)
    api.js                          # Fetch wrappers with timeout + connection status tracking
    ui.js                           # Card rendering, ARIA, keyboard activation, grid patching
    player.js                       # Mini-player: HLS handoff, resize, expand/collapse
    shortcuts.js                    # Keyboard shortcuts: ?, t, g+b/f/h/s, Esc, /
    chromecast.js                   # Chromecast modal: discovery, selection, focus trap
    toast.js                        # Toast notification system (role=alert, auto-dismiss)
    favorites.js                    # Favorites store (localStorage)
    history.js                      # Watch history store (localStorage)
    sorting.js                      # Client-side featured stream sorting
    utils.js                        # Escaping, formatting, debounce, clipboard
    views/
      browse.js                     # Featured streams: infinite scroll, prefetch, auto-refresh
      channel.js                    # Channel profile: HLS player, tabs, viewer refresh
      favorites.js                  # Favorites grid with live status fetch
      history.js                    # Watch history list
      settings.js                   # Preferences: theme, language, view mode, data clearing
  art/                              # Generative art (p5.js) — Signal Drift, Signal Propagation
tests/
  conftest.py                       # Shared fixtures (cache clearing, sample API data)
  test_fastapi_parity.py            # Contract tests for all API endpoints
  test_transformers.py              # Data transformation edge cases
  test_cache_service.py             # Cache LRU eviction, TTL, thread safety
  test_circuit_breaker.py           # State machine transitions
  test_kick_api_service.py          # Typesense key concurrency and fallback
  test_chromecast_service.py        # Device discovery lifecycle
  test_lifespan.py                  # App startup/shutdown sequence
```

## Frontend Architecture

The web UI is a vanilla JS Single Page Application with hash-based routing. No build step required.

### Rendering Pipeline

The browse view uses three render modes for optimal performance:

| Mode | Trigger | Behavior |
| --- | --- | --- |
| **full** | Initial load, language/category switch, sort | Full DOM replacement with staggered card-enter animations |
| **append** | Scroll-triggered page load | New cards animated in, existing cards untouched |
| **refresh** | 90-second auto-refresh, mid-cycle viewer update | Silent cell-level DOM patching, zero animation overhead |

### Key Design Decisions

- **1-page-ahead prefetch** — after each scroll load, the next page is silently fetched so it is ready instantly when the user scrolls further
- **Page-1-only auto-refresh** — the 90-second timer re-fetches only page 1 instead of all loaded pages, keeping API usage minimal
- **Mid-cycle viewer refresh** — at the 60-second mark, batch viewer counts are fetched and animated in-place with eased counting transitions
- **Server-side stale-while-revalidate** — each featured page is cached with a short fresh TTL and a longer stale TTL; stale responses are served instantly while a single background refresh runs
- **Mini-player HLS handoff** — when navigating away from a live channel, the HLS.js instance is transferred (detach + attach) into a persistent mini-player bar instead of being destroyed and recreated
- **Observer self-re-triggering** — if the scroll sentinel is still visible after a page loads, the next page loads immediately without waiting for the IntersectionObserver frame delay

### Theme System

Three-state theme (System / Light / Dark) with `prefers-color-scheme` auto-detection, real-time OS change tracking, smooth 300ms CSS transitions, and dynamic `<meta name="theme-color">` / `<meta name="color-scheme">` updates. Accessible via top-bar toggle button or `t` keyboard shortcut.

### Accessibility

WCAG AA compliance: skip-to-content link, distinct `aria-label` on nav landmarks, full combobox ARIA pattern for search, tab ARIA for profile tabs, focusable cards with Enter/Space activation, modal focus trapping with background `inert`, `prefers-contrast: more` and `prefers-reduced-motion: reduce` media queries, 4.8:1 minimum contrast ratio on light theme text, and `rel="noopener noreferrer"` on all external links.

## Configuration

The application is configured with environment variables (or a `.env` file):

| Variable | Default | Description |
| --- | --- | --- |
| `FLASK_DEBUG` | `False` | Enable reload mode for local development |
| `PORT` | `8081` | Application port |
| `LOG_LEVEL` | `INFO` | Logging level |
| `LOG_FORMAT_JSON` | `False` | Structured JSON logging for production |
| `DEFAULT_LANGUAGE_CODE` | `tr` | Default featured-stream language |
| `KICK_API_BASE_URL` | `https://kick.com/api/v2/channels/` | Kick channel API base URL |
| `KICK_FEATURED_LIVESTREAMS_URL` | `https://kick.com/stream/featured-livestreams/` | Featured livestreams URL |
| `KICK_ALL_LIVESTREAMS_URL` | `https://kick.com/stream/livestreams/` | Public livestream discovery URL |
| `CACHE_DEFAULT_TIMEOUT` | `300` | Default cache timeout in seconds |
| `CACHE_MAX_SIZE` | `2000` | Maximum cache entries before LRU eviction |
| `LIVE_CACHE_DURATION_SECONDS` | `30` | Cache duration for live stream data |
| `VOD_CACHE_DURATION_SECONDS` | `300` | Cache duration for VOD and clip data |
| `FEATURED_CACHE_DURATION_SECONDS` | `120` | Fresh TTL for featured streams |
| `FEATURED_STALE_TTL_SECONDS` | `300` | Stale-while-revalidate window |
| `SEARCH_CACHE_DURATION_SECONDS` | `30` | Cache duration for search results |
| `AVATAR_CACHE_DURATION_SECONDS` | `604800` | Cache duration for avatars (7 days) |
| `VIEWER_CACHE_DURATION_SECONDS` | `30` | Cache duration for viewer counts |
| `NEGATIVE_CACHE_DURATION_SECONDS` | `10` | Short TTL for error responses (404/429) |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `5` | Consecutive failures before circuit opens |
| `CIRCUIT_BREAKER_RECOVERY_SECONDS` | `30` | Seconds before half-open probe |
| `ASYNCIO_THREAD_WORKERS` | `0` | Thread pool size for async ops (0 = default) |
| `CORS_ORIGINS` | `""` | Comma-separated CORS origins (empty = disabled) |
| `CORS_ALLOW_CREDENTIALS` | `False` | Allow credentials in CORS requests |
| `SECURITY_HEADERS_ENABLED` | `True` | Enable security response headers |
| `CHROMECAST_SCAN_TIMEOUT` | `5` | Chromecast discovery timeout |
| `CHROMECAST_SELECT_MAX_RETRIES` | `2` | Max retries for Chromecast connection |
| `CHROMECAST_SELECT_RETRY_DELAY` | `2` | Delay between connection retries |
| `CHROMECAST_MAX_CONNECTION_FAILURES` | `3` | Max failures before dropping device |
| `CHROMECAST_DEVICE_CACHE_SECONDS` | `30` | Chromecast device cache lifetime |
| `CHROMECAST_STOP_WAIT_SECONDS` | `2.0` | Seconds to wait when stopping a cast |
| `CHROMECAST_PERIODIC_SCAN_INTERVAL` | `90` | Background scan interval in seconds |
| `CHROMECAST_FALLBACK_SCAN_ENABLED` | `True` | Enable subnet probing when mDNS fails |
| `CHROMECAST_FALLBACK_SCAN_SUBNETS` | _(private ranges)_ | Subnets for fallback scanning |
| `CHROMECAST_FALLBACK_SCAN_WORKERS` | `96` | Max concurrent fallback scan workers |
| `CHROMECAST_FALLBACK_SCAN_PROBE_TIMEOUT` | `0.25` | TCP probe timeout during scan |
| `CHROMECAST_FALLBACK_DEVICE_INFO_TIMEOUT` | `3.0` | Device metadata HTTP timeout |

## Docker

### Build an image

```bash
docker build -t kick-api:latest .
```

### Run the container

```bash
docker run -d \
  --name kick-api \
  --restart unless-stopped \
  -p 8081:8081 \
  kick-api:latest
```

The Dockerfile uses a multi-stage build (build dependencies in stage 1, slim runtime in stage 2) and runs a single Uvicorn worker to keep the Chromecast singleton in-process. A `sitecustomize.py` patch replaces `requests.Session` with Cloudscraper at import time.

## Kick API Reference

The file [`KICK_PUBLIC_API.md`](KICK_PUBLIC_API.md) contains a detailed reverse-engineering memo of Kick's public API surface, including confirmed endpoints, search infrastructure, Typesense key extraction, official developer API status, Pusher/realtime config, and reproduction commands. It is the authoritative reference for understanding which upstream Kick endpoints this app depends on.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `403 Forbidden` from Kick | Rebuild and check that the Cloudscraper patch is active |
| `uvicorn: command not found` | Reinstall dependencies and rebuild the image |
| Chromecast devices do not appear | Check the local network and re-run device discovery |
| Container exits immediately | Inspect `docker logs kick-api` for the traceback |
| Circuit breaker open (503s) | Check `/metrics` — upstream may be down; breaker resets after 30s |
| Theme not applying | Clear localStorage (`kick-api-preferences`) and reload |
| Stale search results | Typesense key may have rotated — app auto-refreshes on 401/403 |

## Contributing

Pull requests and issues are welcome. The codebase follows these conventions:

- **Backend**: FastAPI with async routes, sync Kick API calls wrapped in `asyncio.to_thread()`, dependency injection via `api/deps.py`
- **Frontend**: Vanilla JS ES modules (no build step), all rendering via string templates in `static/js/ui.js`
- **Tests**: pytest with `monkeypatch` stubs and `httpx.ASGITransport` for in-process API testing
- **Style**: CSS custom properties for theming, mobile-first responsive design
- **Accessibility**: all interactive elements must be keyboard-focusable with visible focus rings and ARIA attributes

## License

MIT. See [LICENSE](LICENSE).
