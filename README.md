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
- Avatar lookup and current viewer counts
- Chromecast device discovery and cast control
- Glassmorphism UI with skeleton loaders, smooth staggered animations, and responsive polish
- Swagger/OpenAPI docs at `/docs`
- Docker and Docker Compose support
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

## API Endpoints

### Stream Routes

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/streams/play/<channel_slug>` | Get live stream data for a channel |
| `GET` | `/streams/go/<channel_slug>` | Redirect to the live HLS playback URL |
| `GET` | `/streams/vods/<channel_slug>` | List VODs for a channel |
| `GET` | `/streams/vods/<channel_slug>/<vod_id>` | Redirect to a specific VOD |
| `GET` | `/streams/clips/<channel_slug>` | List recent clips for a channel |
| `GET` | `/streams/featured-livestreams?language=<code>&page=<n>` | Get featured streams for a language |
| `GET` | `/streams/search?q=<query>` | Search Kick channels |
| `GET` | `/streams/avatar/<channel_slug>` | Get the channel profile image URL |
| `GET` | `/streams/viewers?id=<livestream_id>` | Get current viewer count for a live stream |
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

## Configuration

The application is configured with environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `FLASK_DEBUG` | `False` | Enable reload mode for local development |
| `PORT` | `8081` | Application port |
| `LOG_LEVEL` | `INFO` | Logging level |
| `DEFAULT_LANGUAGE_CODE` | `tr` | Default featured-stream language |
| `KICK_API_BASE_URL` | `https://kick.com/api/v2/channels/` | Kick channel API base URL |
| `KICK_FEATURED_LIVESTREAMS_URL` | `https://kick.com/stream/featured-livestreams/` | Featured livestreams URL |
| `KICK_ALL_LIVESTREAMS_URL` | `https://kick.com/stream/livestreams/` | Public livestream discovery URL |
| `CACHE_TYPE` | `SimpleCache` | In-memory cache adapter backend |
| `CACHE_DEFAULT_TIMEOUT` | `300` | Default cache timeout in seconds |
| `LIVE_CACHE_DURATION_SECONDS` | `30` | Cache duration for live stream data |
| `VOD_CACHE_DURATION_SECONDS` | `300` | Cache duration for VOD and clip data |
| `FEATURED_CACHE_DURATION_SECONDS` | `60` | Cache duration for featured streams |
| `FEATURED_STALE_TTL_SECONDS` | `300` | Stale-while-revalidate window for featured streams |
| `SEARCH_CACHE_DURATION_SECONDS` | `30` | Cache duration for search results |
| `AVATAR_CACHE_DURATION_SECONDS` | `604800` | Cache duration for avatars (7 days) |
| `VIEWER_CACHE_DURATION_SECONDS` | `10` | Cache duration for viewer counts |
| `NEGATIVE_CACHE_DURATION_SECONDS`| `10` | Short TTL for error responses (e.g. 404/429) |
| `ASYNCIO_THREAD_WORKERS` | `0` | Thread pool size for async ops (0 = default) |
| `CHROMECAST_SCAN_TIMEOUT` | `5` | Chromecast discovery timeout |
| `CHROMECAST_SELECT_MAX_RETRIES`| `2` | Max connection retries for Chromecast |
| `CHROMECAST_SELECT_RETRY_DELAY`| `2` | Delay between Chromecast connection retries |
| `CHROMECAST_MAX_CONNECTION_FAILURES`| `3` | Max general failures before dropping CC |
| `CHROMECAST_DEVICE_CACHE_SECONDS` | `30` | Chromecast device cache lifetime |
| `CHROMECAST_STOP_WAIT_SECONDS` | `2.0` | Seconds to wait when stopping a cast |
| `CHROMECAST_PERIODIC_SCAN_INTERVAL`| `90` | How often to scan for Chromecasts |
| `CHROMECAST_FALLBACK_SCAN_ENABLED` | `True` | Enable fallback probing for Chromecasts |
| `CHROMECAST_FALLBACK_SCAN_SUBNETS` | `(subnets)` | Subnets for fallback CC scanning |
| `CHROMECAST_FALLBACK_SCAN_WORKERS` | `96` | Max concurrent CC fallback scan workers |
| `CHROMECAST_FALLBACK_SCAN_PROBE_TIMEOUT` | `0.25` | Target TCP port timeout during CC scan |
| `CHROMECAST_FALLBACK_DEVICE_INFO_TIMEOUT`| `3.0` | Device metadata HTTP timeout |

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

## Contributing

Pull requests and issues are welcome.

## License

MIT. See [LICENSE](LICENSE).
