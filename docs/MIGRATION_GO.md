# Backend Migration Plan: Python (FastAPI) → Go

> Status: **Proposal / not started.** This document is the agreed plan for porting the
> backend from FastAPI to Go. The frontend (`static/`, `templates/`) is unaffected —
> the Go service serves the same static assets and exposes the same HTTP contract.

## 1. Why migrate

This service is a stateless streaming proxy that runs on a Raspberry Pi (see
`project_deployment`: `192.168.1.3:8081`). Go is a strong fit for that target:

- **Single static binary**, cross-compiled to `linux/arm64` — no venv, no `pip`, no
  Python runtime on the Pi.
- **Lower idle memory** and faster cold start than uvicorn + the current 3 thread pools.
- **Goroutines** map cleanly onto the existing async + thread-pool concurrency model.
- The work is bounded: **~2,500 lines** of backend code, **no database**, in-memory cache only.

**Non-goals:** no behavior changes, no new endpoints, no frontend rewrite. The HTTP
contract (paths, query params, JSON envelope) is frozen and verified against the
existing pytest parity suite (see §8).

## 2. Current architecture (source of truth)

| Layer | Python files | Notes |
|-------|--------------|-------|
| Entry / lifespan | `app.py`, `config.py` | FastAPI + uvicorn; pydantic-settings; 4 background tasks; gzip + CORS + custom middleware |
| Routes | `api/routes/{channel,vods,featured,discovery,chromecast}.py`, `api/{health,metrics}.py` | ~20 endpoints, JSON envelope `{status, message, data}` |
| Services | `services/{kick_api_service,chromecast_service,cache_service,circuit_breaker,log_throttle,transformers}.py` | external I/O + pure transforms |
| Cross-cutting | `api/{cache,deps,errors,middleware,schemas}.py` | inflight dedup, DI, error mapping, correlation IDs |
| Tests | `tests/` (14 files, 145 tests) | unit + FastAPI `TestClient` parity |

### Endpoint inventory (the frozen contract)

```
GET  /                                         index.html
GET  /config/languages                         languages + default
GET  /health, /health/live                     health / liveness
GET  /metrics                                  cache + circuit-breaker + inflight + uptime
GET  /streams/play/{slug}                      live stream + playback URL   (SWR + inflight dedup)
GET  /streams/go/{slug}                         redirect to .m3u8 proxy
GET  /streams/m3u8/{slug}.m3u8                  HLS master playlist proxy (CORS)
GET  /streams/avatar/{slug}                     channel avatar
GET  /streams/clips/{slug}                      channel clips
GET  /streams/vods/{slug}                       VOD list
GET  /streams/vods/{slug}/{vod_id}              redirect to fresh VOD source
GET  /streams/featured-livestreams              paginated featured  (SWR)
GET  /streams/search                            Typesense channel search
GET  /streams/viewers, /streams/viewers/batch   viewer counts (batch ≤ 50)
GET  /api/chromecast/devices                    list discovered devices
POST /api/chromecast/{select,cast,stop}         device control
GET  /api/chromecast/last-device                last-used device
```

## 3. Target Go architecture

Recommended stack — bias toward **stdlib + a handful of focused libraries** to keep the
Pi binary small and the dependency surface auditable.

| Concern | Python today | Go target | Rationale |
|---------|--------------|-----------|-----------|
| HTTP server / router | FastAPI + uvicorn | **stdlib `net/http`** with Go 1.22+ `ServeMux` (`GET /streams/play/{slug}`) | Routing now supports method + path wildcards; no framework needed. `chi` is the fallback if richer middleware ergonomics are wanted. |
| Config | pydantic-settings | **`caarlos0/env/v11`** + `joho/godotenv` | Struct-tag env binding mirrors `BaseSettings`. |
| Kick HTTP client | `curl_cffi` (TLS spoof) | **`bogdanfinn/tls-client`** | See §4 — the critical blocker. |
| Typesense search | `requests` | stdlib `net/http` | Typesense cluster is not behind Cloudflare; no spoofing needed. |
| Chromecast | `pychromecast` + `zeroconf` | **`vishen/go-chromecast`** (`cast`, `application`, `dns`) | See §5 — the second blocker. |
| Templating | Jinja2 | stdlib **`html/template`** | One endpoint (`/`). |
| Cache | `cache_service.InMemoryCache` | `map` + `sync.RWMutex` + `time.Time` | Direct port, zero deps. |
| Circuit breaker | `circuit_breaker.CircuitBreaker` | port the state machine; or `sony/gobreaker` | Pure logic; in-house port keeps per-lane metrics identical. |
| Inflight dedup / SWR | `asyncio.Event` + semaphores | `golang.org/x/sync/singleflight` + buffered-channel semaphore | `singleflight` *is* the thundering-herd primitive. |
| Gzip | `GZipMiddleware` | `klauspost/compress/gzhttp` (or stdlib) | gzhttp also negotiates brotli. |
| Logging | stdlib logging + JSON formatter | stdlib **`log/slog`** (`slog.JSONHandler`) | Native structured + JSON; correlation ID via `context`. |
| Metrics | hand-rolled `/metrics` | same hand-rolled JSON | No Prometheus dependency, matches today. |

### Proposed layout

```
cmd/server/main.go          # wire config, deps, router, lifespan, graceful shutdown
internal/config/            # env binding (caarlos0/env)
internal/httpapi/           # handlers (one file per current route module) + middleware + router
internal/kick/              # KickClient (tls-client), Typesense key mgmt
internal/chromecast/        # discovery + control wrapper over vishen/go-chromecast
internal/cache/             # InMemoryCache + singleflight inflight + SWR helpers
internal/breaker/           # circuit breaker (critical / non-critical lanes)
internal/transform/         # pure transformers (channel profile, vod, clip, featured)
internal/logging/           # slog setup + repeat-suppressing throttle
web/                        # embed static/ + templates/ via //go:embed
go.mod
```

## 4. Blocker #1 — TLS fingerprinting (curl_cffi)

**Problem.** Kick.com sits behind Cloudflare, which fingerprints the TLS ClientHello.
`curl_cffi` impersonates Chrome so requests aren't blocked. A naïve Go `net/http` client
has a Go-specific fingerprint and **will be challenged/blocked**.

**Solution.** [`bogdanfinn/tls-client`](https://pkg.go.dev/github.com/bogdanfinn/tls-client) —
built on `utls` + `fhttp`, ships browser impersonation profiles (Chrome/Firefox/Safari).
Wrap it behind a small interface so the rest of the code is agnostic:

```go
type Doer interface { Do(*http.Request) (*http.Response, error) }
// kickClient holds a tls_client.HttpClient configured with
// profiles.Chrome_120 (match the Chrome version curl_cffi impersonates today).
```

**2026 risk to budget for.** Cloudflare now inspects **JA4+ and HTTP/2 frame coherence**,
not just JA3 — shallow spoofing is weaker than it was. `tls-client` mitigates this because
it bundles `fhttp` (correct HTTP/2 SETTINGS + frame ordering), but the impersonation
profile must stay current with the Chrome version. **De-risk this in Phase 1, before
committing to the rest of the port** — if a profile gets blocked, fallbacks are:
1. Bump/rotate the impersonation profile (cheap).
2. `juzeon/spoofed-round-tripper` as a drop-in `http.RoundTripper`.
3. Last resort: shell out to `curl-impersonate` binary (keeps the Pi dependency-light-ish).

**Typesense key scraping** (`kick_api_service` scrapes Kick's JS bundles for the search
API key) ports directly: same regex against the bundle text, 24h cache, 401/403 → re-scrape,
shared across the process behind a `sync.Mutex` + `sync.Once`-style refresh.

## 5. Blocker #2 — Chromecast (pychromecast, 910 lines)

**Problem.** `chromecast_service.py` is the largest, most stateful component: dual-path
discovery (long-lived mDNS browser + a fallback ~1,500-probe TCP subnet scan), connection
lifecycle with retries, persisted known-hosts, and per-operation thread pools.

**Solution.** [`vishen/go-chromecast`](https://github.com/vishen/go-chromecast) is
importable as a library (not just a CLI): `dns` (mDNS discovery), `cast`/`application`
(connect, `LoadMedia`, play/pause/stop/seek/volume). It covers the **primary mDNS path
and all device control**.

**What `go-chromecast` does *not* give us → port by hand:**
- The **fallback TCP subnet scan** (probe :8009 across configured subnets with a worker
  pool). Straightforward in Go: `errgroup` + a semaphore over the subnet host list,
  `net.DialTimeout` per host, fetch device info over TLS for responders.
- **Known-host persistence** (`.kilo/chromecast_hosts.json`): same JSON file, `os` + `encoding/json`.
- **Discovery/connection state machine** + reconnect backoff: reimplement with a
  `sync.RWMutex`-guarded device registry (goroutines replace the per-op thread pools).

**Risk:** medium-high — this is the largest behavioral surface and the hardest to unit-test
without real devices. Mitigation: port it **last** (Phase 3), keep the existing
`test_chromecast_service.py` scenarios as the spec, and gate cutover on a manual cast test
against the real LAN devices.

## 6. Concurrency translation

| Python (asyncio) | Go |
|------------------|-----|
| `async def` handler | `http.HandlerFunc` (each request already its own goroutine) |
| `await asyncio.to_thread(blocking)` | call directly — blocking I/O in a goroutine is fine |
| `asyncio.Semaphore(4)` (non-critical / background limiters) | buffered channel `make(chan struct{}, 4)` or `x/sync/semaphore` |
| `asyncio.Event` inflight dedup | `singleflight.Group.Do` (single fetch, others share result) |
| SWR background refresh task | `go func(){ ... }()` guarded by the bg-refresh semaphore + claim flag |
| `asyncio.create_task` background loops (scan/sweep/warm) | goroutines + `time.Ticker`, cancelled via a root `context.Context` |
| per-request timeout | `context.WithTimeout` threaded into `http.Request` + client |
| `contextvars` correlation ID | value on `context.Context`, read by the slog handler |
| graceful shutdown (lifespan) | `signal.NotifyContext` → `http.Server.Shutdown(ctx)` → cancel bg ctx |

The InflightTracker’s `sweep_stale()` (60s) becomes unnecessary — `singleflight` cleans up
its own keys when the in-flight call returns.

## 7. Phased sequence

Each phase is independently shippable and testable. **Order is deliberate: hardest
external risks (TLS, Chromecast) are isolated so a blocker can't strand the whole effort.**

- **Phase 0 — Scaffold + pure logic** ✅ **DONE** (zero external deps, pure stdlib)
  `go.mod` (module `kickapi`, root layout), `//go:embed static templates`, and endpoints
  `/`, `/health`, `/health/live`, `/config/languages`, `/metrics` + static serving with
  hash-busted immutable caching. Ported packages: `config`, `cache` (two-pass eviction +
  insertion-order parity), `breaker` (3-state, half-open probe), `transform` (null-vs-value
  parity), `obs` (upstream + per-lane counters), `logging` (slog text/JSON), `httpapi`
  (router, correlation-ID/timing/security-header middleware, Jinja `url_for`+`range` index
  renderer). **Exit met:** `go vet` + `go build` clean; unit + handler tests green; live
  server verified (JSON shapes match the Python `/health` and `/metrics` contracts).

- **Phase 1 — Kick client + the TLS blocker** ✅ **DONE (verified live)**
  `internal/kick` on `bogdanfinn/tls-client` (Chrome_131 profile, coherent UA) + Typesense
  key scrape with 24h cache/fallback. `internal/apierr` ports the upstream-status mapping;
  `kickCall` (in `httpapi`) ports `_common.py` (breaker gating + upstream/lane counters +
  error mapping). Wired read-only endpoints: `/streams/play`, `/go`, `/m3u8`, `/avatar`,
  `/clips`, `/vods`, `/vods/{id}`, `/featured-livestreams`, `/search`, `/viewers`,
  `/viewers/batch`. Offline route tests use a fake client via the `kickClient` interface seam.
  **Exit met (from this Mac):** Cloudflare bypass confirmed — `featured` returned 14 live
  items; `play`/`avatar`/`search`/`viewers`/`clips`/`vods`/`m3u8` all returned real data;
  404→"channel not found" and invalid-slug→400 mapping correct; `/metrics` upstream
  counter incremented. ⚠️ **Still must be re-confirmed from the Pi (192.168.1.3)** —
  Cloudflare behavior can differ by source IP.
  **Deferred to Phase 2:** SWR (stale+fresh keys), in-flight dedup, negative caching, and
  the background-refresh limiter — Phase 1 uses simple single-key TTL caching per endpoint.

- **Phase 2 — Caching semantics: SWR + inflight dedup + circuit-breaker lanes** ✅ **DONE (verified live)**
  `internal/inflight` ports `InflightTracker` (DedupGet/DedupSet/ClaimInflight/SweepStale +
  active-keys/timeout metrics) using a closed-channel broadcast (the asyncio.Event analog).
  `play` and `featured` now do stale-while-revalidate (stale+fresh keys, background refresh
  via a bounded `limiter`, breaker-open hold-off, refresh cooldown), negative caching of
  404s, and `warm_caches_from_featured`. A 60s sweeper goroutine (cancelled on shutdown)
  removes abandoned markers; `/metrics` reports real inflight stats. Per-lane breakers were
  already wired in Phase 1. Tests pass under `-race`.
  **Exit met (live):** `featured` warmed 47 entries; featured-channel avatar served from warm
  cache; `play` served the partial instantly then background-refreshed; 404 negative-cached
  (0.92s → 0.0007s on replay); `inflight active_keys=0` after fetches.
  *Chose the ported tracker over `singleflight` — the SWR `ClaimInflight` primitive and the
  metrics counters need state singleflight doesn't expose.*

- **Phase 3 — Chromecast** ✅ **DONE (unit tests green; manual cast test pending)**
  `vishen/go-chromecast` + hand-ported fallback TCP subnet scan + LRU known-host
  persistence + state machine (discovery/selection/control). 11 HTTP endpoints wired.
  32 unit tests cover: ScanAsync state, device registry/dedup, SelectDevice state machine
  (not-found/scanning/busy/timeout/success), CastStream/StopCast, volume clamping,
  GetStatus, LRU eviction, candidateHosts IP math, subnet parsing.
  Config fields added: ScanTimeout, SelectMaxRetries, SelectRetryDelay,
  DeviceCacheSeconds, FallbackScanWorkers, FallbackScanProbeTimeout, FallbackDeviceInfoTimeout.
  ⚠️ **Manual cast/stop against real LAN devices still required before cutover.**

- **Phase 4 — Middleware + ops polish** ✅ **DONE**
  All items complete:
  - Correlation IDs (`X-Request-ID` generated/propagated in `requestContext`)
  - Security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
    `Permissions-Policy`) via `requestContext`
  - Request logging with method/path/status/duration/request_id (skip-list for high-freq
    health+SSE+metrics paths)
  - JSON log mode (`LOG_FORMAT_JSON` → `slog.JSONHandler`)
  - Immutable static cache-control (`Cache-Control: public, max-age=31536000, immutable`
    for `?h=`-busted URLs; 5-min TTL otherwise)
  - Gzip compression (`klauspost/compress/gzhttp`, ≥1 KB, level 5 — matches
    Python `GZipMiddleware(minimum_size=1024, compresslevel=5)`; preserves `http.Flusher`
    for SSE stream endpoint)
  - Log throttle (`logging.ThrottledLogger` + `StateChangeLog` — ports
    `ThrottledErrorLog` / `StateChangeLog` from `services/log_throttle.py`)

- **Phase 5 — Parity gate, Docker build, cutover** ✅ **DONE (local; Pi soak pending)**
  **Parity gate:** Go parity test suite (`internal/httpapi/parity_test.go`) mirrors
  `tests/test_fastapi_parity.py` — same 20 route/contract assertions + 7 validation
  error cases, all green under `-race`. Tests use in-process fakeKick + fakeChromecast
  (no live network needed). Covers: play/live, play/offline, vods, vods/{id} redirect,
  featured-livestreams (with pagination), go-to-live redirect, m3u8 proxy, clips, search,
  avatar, viewers, viewers/batch, all chromecast routes (devices, status, last-device,
  select, cast, stop), plus slug/query validation errors.
  **Docker:** `Dockerfile.goserver` — `golang:1.24-bookworm` builder → distroless static
  final; `CGO_ENABLED=0 GOOS=linux GOARCH=arm64`; self-contained binary with
  `//go:embed static templates`. `docker-compose.yaml` updated: `kick-proxy` now builds
  from `Dockerfile.goserver`; legacy Python service kept under `profiles: ["python"]`
  on port 8082 for side-by-side comparison. Memory limit dropped 512 MB → 128 MB.
  `cmd/server/main.go` gained a `-healthcheck` flag (GET /health/live, exit 0/1)
  since distroless has no curl/wget.
  **Local live validation (from Mac, 2026-06-13):**
  - Cloudflare bypass confirmed: featured-livestreams returned real data (Old School
    RuneScape, Odablock, …); viewer counts live (34 720, 49 215); M3U8 playlist proxied
    successfully for a live stream (solomission); search returned 8 results; redirects,
    health, and metrics all correct.
  - arm64 binary cross-compiled: `CGO_ENABLED=0 GOOS=linux GOARCH=arm64` → 13 MB static
    ELF (no libc dep), BuildID verified.
  - Deploy script: `scripts/deploy-pi.sh` — builds arm64 binary, rsyncs to versioned
    dir on Pi, smoke-tests on port 8082 (no clash with running Python container),
    then cuts over via nohup with PID file. Rollback = kill PID + restart Python container.

  **Pi cutover complete (2026-06-13, Pi at 192.168.68.53):**
  - Cloudflare bypass confirmed from Pi IP: 14 live streams returned, viewer counts live
  - Smoke test on port 8082 passed before cutover
  - Python container (kick-api-v4-kick-proxy-1) stopped; Go binary started on port 8081
  - Handed to systemd (`kick-api.service`, enabled for reboot survival)
  - Memory at 34s uptime: **10 MB** (vs Python container's 512 MB limit)
  - All endpoints verified: 200 health/live/config/featured/play/search/avatar/chromecast,
    307 redirect (go/{slug}), 404 unknown route, 400 bad slug
  - Metrics: 4 upstream calls, 93 cache entries, 9 hits / 64 misses, both breakers closed,
    0 inflight, 0 rejections/failures
  - Binary at `/home/pi/Desktop/kick-api-v5/kick-api-arm64` (13 MB, statically linked)
  - Rollback: `sudo systemctl stop kick-api && cd /home/pi/Desktop/kick-api-v4 && docker compose up -d`

  ✅ **Migration complete. Python app left in place at kick-api-v4 for rollback only.**

## 8. Testing & parity strategy

The biggest de-risking lever: **reuse the existing Python parity suite as a black-box
conformance harness against the Go server.**

- `tests/test_fastapi_parity.py` drives the contract via HTTP. Add a mode that points its
  client at the running Go server (env-selected base URL) so the *same* assertions validate
  both implementations. Any divergence in JSON envelope, status codes, or pagination fails CI.
- Optional during transition: a tiny **response-diffing reverse proxy** that fans each
  request to both Python and Go and logs payload diffs — turns real traffic into a parity test.
- Port the pure-unit tests (`cache`, `breaker`, `transform`, inflight) to Go `testing` +
  `httptest`; these are 1:1 and cheap.
- Chromecast: keep `test_chromecast_service.py` scenarios as the behavioral spec; cover the
  fallback-scan and state-machine logic with Go unit tests using a fake dialer/discovery.

## 9. Deployment

- **Build:** multi-stage Dockerfile — `golang:1.2x` builder → `FROM scratch` or
  `gcr.io/distroless/static` final. `CGO_ENABLED=0 GOOS=linux GOARCH=arm64`. Resulting
  image is a few MB vs. the current Python image.
- **Static assets:** `//go:embed static templates` so the binary is self-contained (no
  volume mounts for assets).
- **Compose:** the Pi `docker-compose.pi.yaml` overlay stays; just swap the service image.
- **Rollback:** versioned directories on the Pi already provide this (per `project_deployment`).
- **Config:** same env vars; `.env.example` carries over almost verbatim.

## 10. Risk matrix

| Component | Difficulty | Risk | Mitigation |
|-----------|-----------|------|------------|
| TLS fingerprinting | High | Cloudflare JA4+/HTTP2 coherence checks | `tls-client` + fhttp; profile rotation; `curl-impersonate` fallback. **Prove in Phase 1.** |
| Chromecast discovery + control | High | No 1:1 lib for fallback scan / state machine | `go-chromecast` for mDNS+control; hand-port scan; manual device test gate |
| SWR + inflight dedup | Medium | Subtle races vs. asyncio version | `singleflight` is the proven primitive; parity tests |
| Background-task lifecycle | Medium | Goroutine leaks on shutdown | single root `context`, `errgroup`, `Server.Shutdown` |
| Routes / schemas / envelope | Low | — | mechanical; frozen contract + parity suite |
| Cache / breaker / transformers | Low | — | pure logic, direct port |
| Templating / static / gzip | Low | — | stdlib |

## 11. Decisions

Defaulted for Phase 0 (revisit any before Phase 1 — none are locked in):

1. **Router:** ✅ stdlib `net/http` (Go 1.22 `ServeMux`, method+path patterns, `/{$}` exact
   root). No framework, no external dep.
2. **Repo strategy:** ✅ Go module at **repo root** (module `kickapi`, `cmd/server` +
   `internal/*`), Python left in place. Enables `//go:embed static templates`. Python can
   move to `/legacy/` once Go reaches parity.

Still open (needed before the phases that depend on them):

3. **Cutover style** (before Phase 5): strangler-fig proxy splitting traffic per endpoint
   vs. parallel rewrite then atomic swap once parity is green. Parallel + parity gate is
   simpler for a single-service home deployment.
4. **Fallback TCP subnet scan** (before Phase 3): still needed, or is mDNS-only acceptable
   on the current LAN? Dropping it removes the hardest-to-test chunk of the Chromecast port.

---

### Source references
- TLS in Go: <https://pkg.go.dev/github.com/bogdanfinn/tls-client>,
  <https://github.com/juzeon/spoofed-round-tripper>
- Chromecast in Go: <https://github.com/vishen/go-chromecast>,
  <https://pkg.go.dev/github.com/vishen/go-chromecast/cast>
- Thundering-herd dedup: <https://pkg.go.dev/golang.org/x/sync/singleflight>
