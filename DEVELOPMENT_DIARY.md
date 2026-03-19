# Development Diary

This file is the working memo for ongoing development of `kick-api`.
Use it as the running diary for product behavior, deployment workflow, known constraints, and dated development notes.

## How To Use This File

- Append new entries at the top of the `Diary Entries` section.
- Keep entries factual: what changed, why it changed, what was verified, and what remains unclear.
- When a bug is diagnosed but not fixed, record the evidence and next step.
- When deployment to the Raspberry Pi is part of the work, note the Pi-side behavior and any relevant container logs.

## Current Product Snapshot

`kick-api` is a self-hosted Flask application that provides:

- A web UI for checking whether a Kick channel is live
- In-browser playback for live HLS streams
- Browsing of recent VODs
- Browsing of recent clips
- A featured streams view with language filtering, category filtering, rolling lazy loading, sorting, and refresh behavior
- A proxy-style API over Kick endpoints
- Chromecast discovery, selection, cast, disconnect, and status handling
- Swagger documentation at `/docs`

### Main User Flow

1. User opens `/`
2. User enters a Kick channel slug
3. Frontend fetches, in parallel:
   - `/streams/play/<channel_slug>`
   - `/streams/vods/<channel_slug>`
   - `/streams/clips/<channel_slug>`
4. UI renders live/offline state
5. If live, UI exposes:
   - embedded player
   - playback URL copy
   - cast action
   - direct redirect endpoint
6. UI renders VODs and clips with cast actions

### Featured Streams Flow

- Featured streams load on page open
- Language options come from `/config/languages`
- Featured streams are fetched from `/streams/featured-livestreams?language=<code>&page=<n>`
- The UI builds a client-side search pool from the currently loaded featured page cache
- Current featured table refreshes every 90 seconds
- Featured data is merged across loaded pages, then sorted and filtered globally before rendering

## Development Pipeline Snapshot

The actual development loop is Pi-centered, not CI-centered.

### Canonical Workflow

1. Make code changes locally on the Mac
2. Run `./deploy.sh`
3. Script syncs the local repository to the Raspberry Pi via `rsync`
4. Script runs `docker compose down`
5. Script runs `docker compose up --build -d`
6. Script waits briefly, then health-checks `http://<pi>:8081/config/languages`
7. If health check fails, script tails Pi container logs
8. If health check passes, script smoke-tests Chromecast endpoints

### Why Pi Docker Logs Matter

Seeing the Pi's Docker logs is part of the development workflow, not just production debugging.

Reasons:

- The Pi is the real integration environment for deployment
- Chromecast behavior depends on the Pi's network environment
- Docker build/runtime issues only show up after remote rebuild
- Kick/Cloudflare access behavior may differ between local machine and Pi
- The current deploy script already uses container logs as the first failure signal after health-check failure

### Current Deploy Script Behavior

`deploy.sh` currently:

- Loads Pi credentials from `~/.kick-api.env` if present
- Falls back to SSH key auth if no password is provided
- Deploys to `/home/pi/Desktop/kick-api-v4`
- Assumes Pi host `192.168.1.3`
- Uses container name `kick-api-kick-proxy-1`
- Shows container logs only on failed health checks

### Runtime Container Shape

- Docker Compose uses `network_mode: "host"`
- App listens on port `8081`
- Restart policy is `always`
- Health check uses `/config/languages`
- Gunicorn runs with `--workers 1 --threads 4`

The single-worker setup is intentional because the Chromecast service is stateful and should not be split across multiple worker processes.

## Architecture Notes

### Backend

- `app.py` wires Flask, cache, namespaces, root page, config endpoint, and global error handler
- `routes/stream_routes.py` contains stream, VOD, clip, featured, redirect, and viewer endpoints
- `routes/chromecast_routes.py` contains Chromecast API endpoints
- `services/kick_api_service.py` wraps Kick-facing HTTP calls using `cloudscraper`
- `services/chromecast_service.py` maintains Chromecast discovery and selection state
- `services/cache_service.py` initializes Flask-Caching

### Frontend

- `templates/index.html` defines the single-page UI shell
- `static/script.js` coordinates page boot, featured streams, search suggestions, and channel fetch flow
- `static/js/ui.js` renders live stream, VOD, clips, and featured tables
- `static/js/chromecast.js` handles device discovery modal and connection lifecycle
- `static/js/chromecast_logic.js` sends cast requests for selected media

## Known Constraints And Findings

### 1. Local Search Is Feature-Pool Based

The current UI search does not rely on a full backend channel search.
It searches client-side over already loaded featured streams and extra featured pages.

Impact:

- Search coverage depends on featured data, not all Kick channels
- Search is fast, but incomplete by design

### 2. Backend Search Route Looks Broken

`/streams/search` calls `kick_api_client.search_channels_typesense(q)`, but the client currently defines `search_channels(...)`, not `search_channels_typesense(...)`.

Impact:

- The backend search route appears incomplete or stale
- This route should be treated as suspect until fixed or removed

### 3. Pi Is The Real Environment For Chromecast Work

Chromecast discovery and device-control behavior should be validated on the Pi deployment, not assumed from local development.

### 4. Logs Should Be Considered A First-Class Development Artifact

For any issue involving:

- startup failures
- health-check failures
- Chromecast discovery/selection issues
- Kick upstream failures
- Cloudflare-related errors

the Pi container logs should be checked immediately.

## Suggested Diary Entry Format

Use this template for future notes:

```md
### YYYY-MM-DD - Short Title

Context:
- What was being worked on

Changes:
- Code or config changes made

Verification:
- Local checks run
- Pi deploy result
- Relevant endpoints tested

Pi Logs:
- Key log lines or summary

Open Questions:
- Remaining unknowns or risks
```

## Diary Entries

### 2026-03-19 - Preserve Last Known Live Viewer Count On Faulty Polls

Context:
- The live channel page could hydrate a correct viewer count initially, then regress back to `0` on a later poll
- The requirement was to treat these zero-value refreshes as faulty and keep showing the last known positive count instead

Changes:
- Added `data-last-known-viewer-count` to the live viewer element in `static/js/ui.js` when the initial live payload already has a positive viewer count
- Added a small viewer-display helper in `static/script.js` that stores the last known positive count and refuses to downgrade it to `0` or `N/A` on later bad polls
- Kept the existing immediate fallback + 30-second poll strategy, so request volume did not increase
- Bumped the `script.js` asset version in `templates/index.html` for cache busting

Verification:
- Deployed to the Raspberry Pi with `./deploy.sh`
- Health check passed on `http://192.168.1.3:8081/config/languages`
- Chromecast smoke tests passed:
  - `/api/chromecast/status` returned `disconnected`
  - `/api/chromecast/devices` returned one discovered device and `scanning: false`

Open Questions:
- Manual browser verification is still needed on a live channel page to confirm a later bad poll no longer replaces the displayed count with `0`

### 2026-03-19 - Hydrate Live Viewer Count When Channel Payload Returns Zero

Context:
- Some live channel pages were rendering `Viewers: 0` even while the stream was clearly live
- The live channel payload already carries a viewer count field, but it is sometimes stale or zeroed compared with Kick's lighter current-viewers endpoint

Changes:
- Kept the existing live-page viewer poll cadence in `static/script.js`
- Added an immediate viewer-count fallback fetch only when the initial live payload reports a missing or non-positive viewer count
- Reused the existing `/streams/viewers?id=<livestream_id>` endpoint instead of adding a new API path
- Scoped the DOM update so a late viewer-count response cannot overwrite a newer channel selection
- Left the featured table on its existing page-refresh strategy, avoiding per-row viewer-count polling there to keep API usage low

Verification:
- Deployed to the Raspberry Pi with `./deploy.sh`
- Health check passed on `http://192.168.1.3:8081/config/languages`
- Chromecast smoke tests passed:
  - `/api/chromecast/status` returned `disconnected`
  - `/api/chromecast/devices` returned one discovered device and `scanning: false`

Open Questions:
- Manual browser verification is still needed on a live channel page to confirm the initial `0` now hydrates quickly from the cached viewer endpoint
- The backend `/streams/viewers` route is already cached for 10 seconds, which keeps the fallback lightweight, but the real-world cadence should still be observed on the Pi

### 2026-03-19 - Rolling Featured Page Cache And Refresh Invalidation

Context:
- The grouped first-5-pages lazy loading was still too static for the intended UX
- The next requirement was to grow the featured dataset as the user advanced, keep two pages of lookahead ready, and stop stale prefetched pages from being revealed after a scheduled refresh

Changes:
- Removed the fixed grouped featured fetch path from `static/js/api.js`
- Reworked `static/script.js` so featured streams are loaded page-by-page into a rolling cache keyed by backend page number
- Added page-cache state for loaded page count, visible chunk count, per-page size, `has_next`, refresh generation, and in-flight prefetch tracking
- Changed initial featured load to fetch pages `1..3` concurrently, but only reveal chunk 1
- Kept global featured sorting and category filtering over the merged loaded dataset rather than page-local ordering
- Added two-page lookahead prefetching so advancing into chunk `N+1` keeps chunks `N+1` and `N+2` ready and starts fetching the next page after that
- Reworked scheduled refresh so it refetches the already-loaded page range into a new generation and only reactivates deeper reveal after a fresh cache has been committed
- Locked reveal and prefetch to the last fully committed generation so a failed refresh cannot mix fresh later pages into stale earlier pages
- Updated the featured footer messaging in `static/js/ui.js` to describe loaded live pages instead of the old fixed-pool lazy-load copy
- Bumped the `script.js` asset version in `templates/index.html` for cache busting

Verification:
- Deployed to the Raspberry Pi with `./deploy.sh`
- Health check passed on `http://192.168.1.3:8081/config/languages`
- Chromecast smoke tests passed:
  - `/api/chromecast/status` returned `disconnected`
  - `/api/chromecast/devices` returned one discovered device and `scanning: false`

Open Questions:
- Background-refresh failure currently leaves the visible dataset stable but locks deeper reveal until a fresh generation is committed; this is safe, but the exact UX should be observed in-browser
- A local JavaScript parser/runtime is still unavailable in this workspace, so frontend syntax confidence still relies on code inspection plus successful Pi deploy

### 2026-03-19 - Replace Featured Pagination With Grouped Lazy Loading

Context:
- Pagination was breaking the mental model for featured sorting because a high-viewer stream on page 2 could outrank items on page 1
- The new requirement was to treat the first 5 featured pages as one dataset, sort/filter globally, and reveal results lazily instead of paging

Changes:
- Added grouped featured fetch in `static/js/api.js` to load pages 1-5 as a single combined dataset
- Removed page-local featured rendering logic from `static/script.js`
- Changed featured refresh to work against the grouped dataset, preserving current sort and category filter across refreshes
- Replaced pagination UI with lazy-loading status + sentinel in `templates/index.html`
- Added batch reveal behavior in `static/script.js` using `IntersectionObserver`
- Updated `static/js/ui.js` to render `visibleCount / totalCount / hasMore` metadata instead of pagination controls

Verification:
- Deployed to the Raspberry Pi with `./deploy.sh`
- Health check passed on `http://192.168.1.3:8081/config/languages`
- Chromecast smoke tests passed:
  - `/api/chromecast/status` returned `disconnected`
  - `/api/chromecast/devices` returned one discovered device and `scanning: false`

Open Questions:
- Frontend runtime behavior still needs manual browser verification for the exact lazy-load feel and global sorting outcome
- A local JavaScript parser/runtime was not available in this workspace, so validation relied on code inspection plus successful deploy

### 2026-03-19 - Seamless Featured Refresh And Row Reorder Motion

Context:
- The featured streams table felt wobbly during timed refreshes because the DOM was fully redrawn
- The next iteration goal was to keep the list stable during fetches and add subtle motion when rows reorder

Changes:
- Replaced featured-table full redraw with keyed row reconciliation in `static/js/ui.js`
- Reused existing `<tr>` nodes keyed by channel slug, updated cell contents in place, and only created rows for new streams
- Added FLIP-style row movement with `Element.animate()` for moved rows and a light entry animation for newly inserted rows
- Skipped animation automatically when `prefers-reduced-motion: reduce` is active
- Updated `static/script.js` refresh flow so timed refreshes pause while the document is hidden or the featured section is hovered/focused
- Added deferred catch-up refresh behavior and coalesced overlapping refresh requests so only one fetch is active at a time
- Kept the featured table visible during pending fetches and changed the spinner to use fixed footprint + opacity instead of `display: none`

Verification:
- Deployed to the Raspberry Pi with `./deploy.sh`
- Health check passed on `http://192.168.1.3:8081/config/languages`
- Chromecast smoke tests passed:
  - `/api/chromecast/status` returned `disconnected`
  - `/api/chromecast/devices` returned one discovered device and `scanning: false`

Open Questions:
- No local JavaScript parser/runtime was available in this workspace, so frontend syntax was validated by manual code inspection plus successful deploy
- Manual browser confirmation is still needed for the exact visual feel of row motion and the 90-second refresh idle behavior

### 2026-03-19 - Fix Featured Lazy-Load Sentinel Stalling

Context:
- The featured streams list could stop at the first visible chunk even though multiple pages were already loaded
- The footer kept saying `Scroll or swipe for more`, but reaching the footer did not always reveal the next chunk

Changes:
- Added a viewport-based lazy-load fallback in `static/script.js`
- Re-armed the sentinel observer after each featured-table render instead of only once at startup
- Added passive `scroll` and `resize` checks so reaching the footer still advances the visible chunk count even if the observer misses a transition
- Replaced the old direct sentinel checks after page fetches with a shared scheduled viewport check
- Bumped the frontend asset version in `templates/index.html` to force clients to load the new script

Verification:
- Static code inspection confirms the featured lazy-load path now has both observer and viewport-triggered advancement
- A local JavaScript runtime was still unavailable, so final validation requires browser verification on the Pi deployment

Open Questions:
- Manual confirmation is still needed for the exact feel on Safari and touch scrolling after deployment

### 2026-03-19 - Replace Featured Lazy Loading With Smart Pagination

Context:
- The featured streams infinite-scroll behavior remained unreliable in real browsing
- The requirement changed to explicit pagination, but without giving up the rolling page-cache and ahead-of-time fetching
- The target behavior is: when the user advances to page `N`, the app should already be fetching or have fetched pages `N+1` and `N+2`

Changes:
- Replaced the featured lazy-load controller in `static/script.js` with explicit featured-page navigation state
- Kept the rolling backend page cache and changed the prefetch logic so navigation to a new page grows the loaded dataset and fetches two pages ahead
- Added pagination-aware availability checks so moving beyond the currently loaded page range triggers fetches for the requested page plus lookahead
- Replaced the footer sentinel UI with pagination controls in `templates/index.html`
- Updated `static/js/ui.js` to render a featured pager with previous/next buttons, numbered page buttons, and prefetch-aware status text
- Updated `static/style.css` to style the new featured pagination controls
- Bumped the frontend asset version in `templates/index.html`

Verification:
- Static code inspection confirms the sentinel-based lazy-load path is fully removed from the featured table
- The featured page cache still grows incrementally and the navigation path now explicitly waits for the requested page range when needed
- Final browser validation still requires a Pi deployment because no local JavaScript runtime/parser is available in this workspace

Open Questions:
- Manual confirmation is still needed that moving from page `3` to `4` leaves pages `5` and `6` warm enough on the Pi
- If the page-button window should be wider or show first/last shortcuts more aggressively, that can be tuned after UI verification

### 2026-03-19 - Fix Featured Pager Stuck In Refreshing State

Context:
- After switching to explicit featured pagination, the footer could stay stuck on `Fetching ahead...`
- The numbered page buttons were rendered disabled even though the first three backend pages had already loaded

Root Cause:
- The featured table was rendered while `featuredRefreshInFlight` was still `true`
- When the initial featured refresh completed, the code cleared the flag but did not re-render the footer controls
- Result: the first painted disabled pager state remained on screen until some later unrelated render happened

Changes:
- Added a follow-up `renderVisibleFeaturedStreams()` call in the featured refresh `finally` block after `featuredRefreshInFlight` is cleared
- Bumped the frontend asset version in `templates/index.html` to invalidate cached broken pager code

Verification:
- Static code inspection confirms the pager is now re-rendered after the refresh flag flips back to idle
- Final confirmation still requires browser verification on the Pi deployment

Open Questions:
- Manual confirmation is still needed that page buttons become active immediately after the first featured fetch completes

### 2026-03-19 - Correct Category Fetch Contract After Live Container Probing

Context:
- The earlier category-selector change was made before the upstream category contract was fully re-validated inside the active Pi container
- That was incomplete. The correct next step was container-side probing of Kick's live bundle and live discovery endpoints before finalizing selector behavior

Evidence Gathered:
- Inside `kick-api-v4-kick-proxy-1`, bundle chunk `3782-2cafe1acf82265d2.js` showed the public client helper for `/stream/livestreams/{lang}` accepts:
  - `page`
  - `limit`
  - `subcategory`
  - `subcategories`
  - `sort`
  - `category`
  - `strict`
  - `tags`
- Live probes showed:
  - `subcategory=ea-sports-fc-26&strict=true` returned only EA Sports FC 26 rows
  - `category=ea-sports-fc-26&strict=true` returned the wrong dataset because that slug is not a parent category
  - `subcategory=irl&strict=true` returned only leaf `irl` rows
  - `category=irl&strict=true` returned the broader IRL parent-group mix, including `just-chatting`
  - accepted sort values are `featured`, `asc`, `desc`
  - rejected sort values include `viewers`, `viewer_count`, `popular`, `trending`

Root Cause:
- The selector values in this app come from `stream.categories[0].slug`, which are leaf category slugs
- The previous logic tried to infer whether a slug should be sent as `category` or `subcategory`
- That inference was wrong for cases like `IRL`, where the leaf slug and parent slug are both `irl`

Changes:
- Updated `KICK_PUBLIC_API.md` with the corrected live contract and reproduction commands
- Updated the backend featured proxy path to pass through:
  - `subcategory`
  - `subcategories`
  - `sort`
  - `strict`
- Updated the frontend category mode to:
  - send leaf selector values as `subcategory`
  - send `strict=true`
  - send `sort=featured` when no explicit featured sort is active
  - send `sort=asc|desc` when the active featured sort is viewer-count order
- Kept promoted featured mode unchanged when no category is selected
- Bumped the frontend asset version in `templates/index.html`

Verification:
- Container-side live probing confirmed the corrected contract before code changes
- Final browser validation is still required after deployment:
  - `Turkish + IRL + viewers desc`
  - `Turkish + EA Sports FC 26`
  - `Turkish + Just Chatting`

### 2026-03-19 - Keep Featured Category Filtering Local To Featured Pages

Context:
- Selecting a featured category like `IRL` was producing nonsense rows
- The desired behavior is to keep the Turkish featured dataset coherent, respect any active sort, and avoid unnecessary extra server-side calls

Root Cause:
- The frontend category selector was triggering a new server-side category/subcategory fetch path
- Kick's broader livestream discovery endpoint is not reliable for this screen:
  - it can return mixed-language rows
  - it can surface obviously wrong viewer counts
  - it breaks the expected "featured Turkish streams" mental model
- The table also defaulted to an always-active viewer sort, so there was no true "server order" fallback state

Changes:
- Stopped sending category/subcategory params from the featured pagination fetch path in `static/script.js`
- Switched the category selector to client-side filtering over the already-loaded featured page cache
- Kept pagination/prefetch intact so additional featured pages are only fetched when needed
- Reset the default featured sort state to inactive by setting `featuredSortState.column = null` in `static/js/state.js`
- Preserved active sort behavior by continuing to apply `applyFeaturedStreamsSort()` only when a sort column has actually been selected
- Updated the category dropdown refresh logic so it always rebuilds from the loaded featured dataset and preserves the current selection when possible
- Bumped the frontend asset version in `templates/index.html`

Verification:
- Static inspection confirms category changes no longer trigger the broken server-side category query path
- With no active sort, the merged featured dataset now preserves upstream featured order
- With an active sort, the filtered subset inherits that active sort order
- Final UX confirmation still requires browser validation after loading the new frontend asset

Open Questions:
- If the category dropdown should eventually include secondary categories beyond `stream.categories[0]`, that should be handled as a separate UI change

### 2026-03-19 - Correct Featured Category Filter Mode

Context:
- Selecting a category like `IRL` was returning nonsense low-viewer results instead of the expected Turkish IRL streams
- The desired behavior is to keep server-side requests low and let the server do the category filter once per requested page

Root Cause:
- The frontend was treating every selector value as `subcategory=...`
- Kick's livestream discovery surface does not use the same filter key for everything:
  - top-level categories like `IRL` need `category=irl`
  - subcategories like `just-chatting` need `subcategory=just-chatting`
- The backend route only accepted `subcategory`, so even a correct frontend `category` request would have been ignored

Changes:
- Added selector-side filter-type tracking in `static/script.js` so each option knows whether it maps to `category` or `subcategory`
- Updated `static/js/api.js` to send `category` and `subcategory` as distinct query params
- Updated `routes/stream_routes.py` to accept both params and pass them through
- Updated `services/kick_api_service.py` so the Kick all-livestreams client can send either `category=` or `subcategory=`
- Bumped the frontend asset version in `templates/index.html`

Verification:
- Direct Pi route probing confirmed the behavior mismatch before the fix:
  - `subcategory=irl` returned low-viewer nonsense rows
  - `category=irl` returned the expected Turkish IRL list shape
- Final browser validation still requires checking the deployed UI after the new code is loaded

Open Questions:
- Manual confirmation is still needed for a few representative filters like `IRL`, `Just Chatting`, and `League of Legends`

### 2026-03-19 - Preserve Featured Stream Sort Across Auto-Refresh

Context:
- The homepage featured streams table auto-refreshes periodically
- After a user clicked a sortable column, later refreshes replaced the visible ordering with fresh API order
- The sort indicator stayed active, but the data was no longer sorted accordingly

Root Cause:
- `handleFetchFeaturedStreams()` replaced `appState.featuredStreams` with fresh API data
- The existing sort state in `featuredSortState` was not reapplied before render
- Result: refresh and pagination effectively discarded the user's active sort preference

Changes:
- Added `applyFeaturedStreamsSort()` in `static/js/sorting.js`
- Updated `static/script.js` so newly fetched featured stream data is sorted with the current `featuredSortState` before rendering

Verification:
- Static code inspection confirms the active sort is now reapplied on every featured-stream fetch
- This should preserve ordering for both timed refreshes and page changes in featured pagination
- Deployed to the Raspberry Pi with `./deploy.sh`
- Health check passed on `http://192.168.1.3:8081/config/languages`
- Chromecast smoke tests passed:
  - `/api/chromecast/status` returned `disconnected`
  - `/api/chromecast/devices` returned one discovered device and `scanning: false`

Open Questions:
- No frontend test harness currently exists for this behavior
- Manual browser confirmation is still recommended to verify the visible featured-table order remains stable after the 90-second refresh

### 2026-03-19 - Initial Codebase Recon And Pipeline Memo

Context:
- Reviewed the repository to understand what the product does
- Reviewed deployment behavior to understand the real development pipeline

Findings:
- The product is a self-hosted Kick utility, not a full Kick client
- Primary features are live stream lookup, VOD browsing, clips browsing, featured stream discovery, and Chromecast casting
- The frontend is an active UI layer over the backend API, not just static documentation
- The Pi deployment path is central to development, especially for Chromecast and runtime validation
- The deploy script uses Pi Docker logs as the failure investigation mechanism after health-check failure

What This Means For Future Work:
- Product changes should be documented here as dated entries
- Any changes affecting runtime behavior should be verified on the Pi when relevant
- Bugs involving startup or device/network behavior should include a Pi log summary in the diary

Known Follow-Up Items:
- Confirm whether `/streams/search` should be repaired or removed
- Consider improving `deploy.sh` to optionally tail logs after every deploy, not only on failed health checks
- Keep this file updated as the authoritative engineering memo
