# Unofficial Kick App

<p align="center">
  <img src="static/Kick_logo.svg" alt="Kick Logo" width="100"/>
</p>

<p align="center">
  <strong>A lightweight, self-hosted FastAPI web app and proxy API for Kick.com streams.</strong>
</p>

---

Unofficial Kick App provides a web UI plus a REST API for Kick.com live streams, VODs, clips, featured streams, search, and Chromecast playback. It is designed to run locally, in Docker, or on a small home server such as a Raspberry Pi.

## Features

- Live stream lookup with playback redirection
- VOD browsing and direct VOD playback links
- Recent clip browsing
- Featured streams with infinite scroll, language and category filtering
- Single Page Application (SPA) architecture with ultra-fast client-side routing
- Favorites and History tracking for quick access to your most-watched channels
- Smart prefetching: next page is cached in the background before you scroll to it
- Seamless auto-refresh: viewer counts and stream data update silently every 90 seconds
- Two-tier channel search: instant local results + full Typesense server-side search, with loading/empty states and keyboard navigation
- Avatar lookup and current viewer counts (single and batch)
- Chromecast device discovery, cast control, and SSE status streaming
- Glassmorphism UI with skeleton loaders, smooth staggered animations, and responsive polish
- Circuit breaker for upstream API resilience
- Request correlation IDs and structured logging
- LRU-bounded in-memory cache with hit/miss stats
- Swagger/OpenAPI docs at `/docs`
- Operational metrics at `/metrics`
- Multi-stage Docker build with health checks
- GitHub Actions CI pipeline
- Cloudscraper-based Kick API access

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
python app.py
# or: uvicorn app:app --reload
```

The app will be available at `http://localhost:8081`.

### Running Tests

```bash
pytest tests/ -v
```

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
| `GET` | `/streams/viewers/batch?ids={id1},{id2},...` | Batch viewer counts (up to 50) |
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
  kick_api_service.py               # HTTP client for Kick.com API (Cloudscraper)
  cache_service.py                  # LRU in-memory cache with max_size and stats
  circuit_breaker.py                # Upstream circuit breaker (closed/open/half-open)
  chromecast_service.py             # Chromecast device discovery and cast control
  transformers.py                   # Pure data transformation functions
tests/
  test_fastapi_parity.py            # API contract tests (all endpoints)
  test_transformers.py              # Data transformation edge cases
  test_cache_service.py             # Cache LRU eviction, TTL, thread safety
  test_circuit_breaker.py           # State machine transitions
  test_kick_api_service.py          # Typesense key concurrency
  test_chromecast_service.py        # Device discovery lifecycle
  test_lifespan.py                  # App startup/shutdown sequence
```

## Configuration

The application is configured with environment variables (or a `.env` file):

| Variable | Default | Description |
| --- | --- | --- |
| `FLASK_DEBUG` | `False` | Enable reload mode for local development |
| `PORT` | `8081` | Application port |
| `LOG_LEVEL` | `INFO` | Logging level |
| `DEFAULT_LANGUAGE_CODE` | `tr` | Default featured-stream language |
| `KICK_API_BASE_URL` | `https://kick.com/api/v2/channels/` | Kick channel API base URL |
| `KICK_FEATURED_LIVESTREAMS_URL` | `https://kick.com/stream/featured-livestreams/` | Featured livestreams URL |
| `KICK_ALL_LIVESTREAMS_URL` | `https://kick.com/stream/livestreams/` | Public livestream discovery URL |
| `CACHE_TYPE` | `SimpleCache` | Cache adapter backend |
| `CACHE_DEFAULT_TIMEOUT` | `300` | Default cache timeout in seconds |
| `CACHE_MAX_SIZE` | `2000` | Maximum cache entries before LRU eviction |
| `LIVE_CACHE_DURATION_SECONDS` | `30` | Cache duration for live stream data |
| `VOD_CACHE_DURATION_SECONDS` | `300` | Cache duration for VOD and clip data |
| `FEATURED_CACHE_DURATION_SECONDS` | `120` | Fresh TTL for featured streams |
| `FEATURED_STALE_TTL_SECONDS` | `300` | Stale-while-revalidate window for featured streams |
| `SEARCH_CACHE_DURATION_SECONDS` | `30` | Cache duration for search results |
| `AVATAR_CACHE_DURATION_SECONDS` | `604800` | Cache duration for avatars (7 days) |
| `VIEWER_CACHE_DURATION_SECONDS` | `30` | Cache duration for viewer counts |
| `NEGATIVE_CACHE_DURATION_SECONDS` | `10` | Short TTL for error responses (e.g. 404/429) |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `5` | Consecutive failures before circuit opens |
| `CIRCUIT_BREAKER_RECOVERY_SECONDS` | `30` | Seconds before half-open probe |
| `ASYNCIO_THREAD_WORKERS` | `0` | Thread pool size for async ops (0 = default) |
| `CHROMECAST_SCAN_TIMEOUT` | `5` | Chromecast discovery timeout |
| `CHROMECAST_SELECT_MAX_RETRIES` | `2` | Max connection retries for Chromecast |
| `CHROMECAST_SELECT_RETRY_DELAY` | `2` | Delay between Chromecast connection retries |
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

The Dockerfile uses a multi-stage build (build dependencies in stage 1, slim runtime in stage 2) and runs a single Uvicorn worker to keep the Chromecast singleton in-process.

## Frontend Architecture

The web UI uses a custom infinite scroll system with three render modes for optimal performance:

| Mode | Trigger | Behavior |
| --- | --- | --- |
| **full** | Initial load, language/category switch, sort | Full DOM diff with FLIP reorder animations |
| **append** | Scroll-triggered page load, background prefetch | Entry animations for new rows only; existing rows untouched |
| **refresh** | 90-second auto-refresh | Silent cell-level updates; zero animation overhead |

Key design decisions:
- **1-page-ahead prefetch** — after each scroll load, the next page is silently fetched so it is ready instantly when the user scrolls further
- **Page-1-only auto-refresh** — the 90-second timer re-fetches only page 1 (most dynamic data) instead of all loaded pages, keeping API usage minimal
- **Observer self-re-triggering** — if the scroll sentinel is still visible after a page loads, the next page loads immediately without waiting for the IntersectionObserver frame delay
- **Server-side stale-while-revalidate** — each page response is cached with a short fresh TTL and a longer stale TTL; stale responses are served instantly while a single background refresh runs

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `403 Forbidden` from Kick | Rebuild and check that the Cloudscraper patch is active |
| `uvicorn: command not found` | Reinstall dependencies and rebuild the image |
| Chromecast devices do not appear | Check the local network and re-run device discovery |
| Container exits immediately | Inspect `docker logs kick-api` for the traceback |
| Circuit breaker open (503s) | Check `/metrics` — upstream may be down; breaker resets after 30s |

## Contributing

Pull requests and issues are welcome.

## License

MIT. See [LICENSE](LICENSE).
