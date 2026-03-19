# Kick Public API Analysis

Observed on `2026-03-19`.

This is an internal engineering memo for the reverse-engineered public Kick surface relevant to:
- streamer/channel info
- livestream discovery
- categories/subcategories
- viewer counts
- public search
- public realtime/client config that may matter for data access

All runtime findings in this document were gathered inside the active Raspberry Pi container used by the deployed app via the existing CloudScraper-backed session in `services.kick_api_service.kick_api_client.session`. That matters because the app's deployed container already has the working Cloudflare-bypass path.

This document uses three evidence labels:
- `Observed Live In Container`: runtime probe executed inside the deployed Pi container
- `Observed In Live Bundle`: value or endpoint extracted from live Kick Next.js assets served from `assets.kick.com`
- `Official Kick Source`: public `dev.kick.com` material

## Purpose And Method

Goal:
- document what public Kick surface is available today without authenticated developer keys
- identify which parts are already used by this app
- identify other useful public surfaces for future work
- explain why the current Typesense key extraction is stale

Method:
- inspected current implementation in [services/kick_api_service.py](services/kick_api_service.py)
- ran live probes inside the deployed Pi container using `kick_api_client.session`
- mined live Next.js chunks from `https://assets.kick.com/main/_next/static/chunks/...`
- checked official developer-program language from:
  - [dev.kick.com](https://dev.kick.com/)
  - [dev.kick.com/terms-of-service](https://dev.kick.com/terms-of-service)

## Official vs Reverse-Engineered Surface

### Official Kick Source

Observed from [dev.kick.com/terms-of-service](https://dev.kick.com/terms-of-service):
- Kick has an official developer program and refers to `dev.kick.com` as the developer portal.
- Kick explicitly says developer keys may be issued through the official program.
- Kick explicitly reserves rate limits and forbids abusive or excessive access.
- Kick allows Kick APIs, embeds, and chat integrations under terms, but the public web-searchable docs surface is thin.

Important practical conclusion:
- there is an official program, but the publicly indexed documentation visible from search is not a usable public API reference
- for current engineering work, the useful surface is mostly reverse-engineered from public web endpoints and live bundles

### Reverse-Engineered Surface

Confirmed today:
- public JSON endpoints on `kick.com`
- public livestream list endpoints on `kick.com/stream/*`
- a public Typesense-backed search endpoint on `search.kick.com`
- a public env-config chunk exposing client-side service roots and keys
- bundle-observed Pusher configuration and channel naming

Not confirmed today:
- a public category search collection in Typesense
- a public schema-enumeration endpoint for search
- publicly usable authenticated search endpoints under `/api/v1/live-channels/*/search`
- fully validated websocket subscriptions to Pusher channels

## Current Key Extraction Algorithm

Relevant current code:
- [services/kick_api_service.py](services/kick_api_service.py)

Current behavior:
- `_fetch_typesense_key_from_bundle()` fetches `https://kick.com/`
- it only extracts relative `/_next/static/chunks/*.js` paths from the HTML
- it sorts those paths heuristically
- it scans only the first 25 chunks
- it regexes for `TYPESENSE_API_KEY`, `typesenseApiKey`, or generic `apiKey`
- `_get_typesense_key()` falls back to a hard-coded value if scraping fails

Why this is stale:
- the live site now exposes chunk URLs as absolute `https://assets.kick.com/main/_next/static/chunks/...`
- the live env-config chunk exposing the public Typesense key was observed at:
  - `https://assets.kick.com/main/_next/static/chunks/428-8648c361edd7b568.js`
- that absolute asset form is outside the current relative-path-only scraper
- `_get_typesense_key(force_refresh=True)` currently returns the fallback even though the live bundle still contains the key

Observed live example:
- `NEXT_PUBLIC_TYPESENSE_API_KEY = nXIMW0iEN6sMujFYjFuhdrSwVow3pDQu`
- `NEXT_PUBLIC_TYPESENSE_URL = https://search.kick.com`

Evidence:
- `Observed Live In Container`: `_get_typesense_key(force_refresh=True)` returned the fallback value
- `Observed In Live Bundle`: the same value was found in chunk `428-8648c361edd7b568.js`

Recommended extraction improvement:
- parse both relative and absolute chunk URLs
- prefer env/config chunks exposing `NEXT_PUBLIC_*` defaults
- scan all discovered chunks until the needed key is found
- classify discovered public config instead of only regexing `apiKey`
- treat the hard-coded fallback as emergency-only, not the normal path

## Confirmed Public Data Endpoints

### Channel And Streamer Info

#### `GET https://kick.com/api/v2/channels/{slug}`

Evidence: `Observed Live In Container`

Status observed:
- `200` for `cavs`

What it returns:
- channel core data
- `playback_url`
- follower/subscription/channel settings
- nested `livestream` when live

Example observation:
- `https://kick.com/api/v2/channels/cavs`
- `STATUS 200`
- returned `slug`, `playback_url`, `vod_enabled`, and live `livestream.viewer_count`

Usefulness:
- best all-in-one public channel payload
- already used by this app via `KickAPIClient.get_channel_data()`

#### `GET https://kick.com/api/v2/channels/{slug}/info`

Evidence: `Observed Live In Container`

Status observed:
- `200` for `cavs`

What it returns:
- streamlined channel + livestream info
- includes `chatroom.id`
- includes live `livestream.viewer_count`

Example observation:
- `https://kick.com/api/v2/channels/cavs/info`
- `STATUS 200`

Usefulness:
- lighter than the full channel payload
- useful when playback/follower/settings detail is not required

#### `GET https://kick.com/api/v2/channels/{slug}/recent-categories`

Evidence: `Observed Live In Container`

Status observed:
- `200` for `cavs`

What it returns:
- subcategory records with:
  - `id`
  - `name`
  - `slug`
  - `viewers`
  - parent category object

Example observation:
- `https://kick.com/api/v2/channels/cavs/recent-categories`
- `STATUS 200`
- returned `Just Chatting` with `slug=just-chatting` and parent category `IRL`

Usefulness:
- good source of category/subcategory slugs
- useful for building category discovery without a separate category search API

### VODs And Clips

#### `GET https://kick.com/api/v2/channels/{slug}/videos`

Evidence: `Observed Live In Container`

Status observed:
- `200` for `cavs`

What it returns:
- list of VOD/live-session video records
- includes `source`
- includes `viewer_count`
- includes thumbnail variants

Example observation:
- `https://kick.com/api/v2/channels/cavs/videos`
- `STATUS 200`

#### `GET https://kick.com/api/v2/channels/{slug}/clips`

Evidence: `Observed Live In Container`

Status observed:
- `200` for `cavs`

What it returns:
- clip list under `clips`
- includes category metadata
- includes creator and channel metadata
- includes clip HLS URL and thumbnail

Example observation:
- `https://kick.com/api/v2/channels/cavs/clips`
- `STATUS 200`

### Livestream Discovery

#### `GET https://kick.com/stream/featured-livestreams/{lang}?page={n}`

Evidence: `Observed Live In Container`

Status observed:
- `200` for `tr?page=1`

What it returns:
- featured stream list
- stable `order` field
- embedded channel data including `playback_url`

Example observation:
- `https://kick.com/stream/featured-livestreams/tr?page=1`
- `STATUS 200`

#### `GET https://kick.com/stream/livestreams/{lang}?page={n}&limit={n}`

Evidence: `Observed Live In Container`

Status observed:
- `200`

What it returns:
- paged livestream list
- stream data plus embedded channel data
- `per_page`, `next_page_url`, and standard paginator fields
- viewer counts are present, but can be misleading when the wrong filter contract is used

Observed request contract:
- `Observed In Live Bundle`: chunk `3782-2cafe1acf82265d2.js` exposes the public client helper:
  - `/stream/livestreams/{lang}`
  - query params: `page`, `limit`, `subcategory`, `subcategories`, `sort`, `category`, `strict`, `tags`

Category/subcategory filter behavior:
- `subcategory={slug}` is the leaf-category filter
- `category={slug}` is the parent-category/group filter
- `subcategories={slug}` is the list-form slug variant
- `strict=true` materially changes the returned dataset and should be treated as part of the contract for category browsing
- numeric forms like `category=2` and `subcategory=15` did not meaningfully filter and do not appear to be the public contract

Practical conclusion:
- public filter contract behaves like slugs, not numeric IDs
- if the UI value comes from `stream.categories[0].slug`, the correct request shape is `subcategory=<slug>`
- `IRL` is the important edge case:
  - `category=irl` means the whole IRL parent group and includes categories like `just-chatting`
  - `subcategory=irl` means only leaf `irl` streams

Accepted `sort` values observed live:
- `sort=featured`
- `sort=asc`
- `sort=desc`

Rejected `sort` values observed live:
- `sort=viewers` -> `422`
- `sort=viewer_count` -> `422`
- `sort=popular` -> `422`
- `sort=trending` -> `422`

Example observations:
- `https://kick.com/stream/livestreams/tr?page=1&limit=14&category=games&strict=true` -> `200`
  - returned mixed game subcategories under the `games` parent
- `https://kick.com/stream/livestreams/tr?page=1&limit=14&category=ea-sports-fc-26&strict=true` -> `200`
  - returned the wrong dataset because `ea-sports-fc-26` is not a parent category; it is a leaf subcategory
- `https://kick.com/stream/livestreams/tr?page=1&limit=14&subcategory=ea-sports-fc-26&strict=true` -> `200`
  - returned only `EA Sports FC 26` streams
- `https://kick.com/stream/livestreams/tr?page=1&limit=14&subcategory=ea-sports-fc-26&sort=desc&strict=true` -> `200`
  - returned the same category sorted highest-to-lowest by `viewer_count`
- `https://kick.com/stream/livestreams/tr?page=1&limit=14&subcategory=irl&strict=true` -> `200`
  - returned only leaf `irl` streams
- `https://kick.com/stream/livestreams/tr?page=1&limit=14&subcategory=irl&sort=desc&strict=true` -> `200`
  - returned the Turkish IRL set ordered from highest to lowest viewers
- `https://kick.com/stream/livestreams/tr?page=1&limit=14&subcategory=just-chatting&sort=desc&strict=true` -> `200`
  - returned Turkish `just-chatting` streams sorted by viewers

### Lightweight Viewer Counts

#### `GET https://kick.com/current-viewers?ids[]={livestream_id}`

Evidence: `Observed Live In Container`

Status observed:
- `200`

What it returns:
- lightweight array of `{ livestream_id, viewers }`

Example observation:
- `https://kick.com/current-viewers?ids[]=101329688`
- `STATUS 200`
- response shape: `[{"livestream_id":101329688,"viewers":4720}]`

Usefulness:
- best low-cost public viewer-count refresh path
- already proxied by this app via `/streams/viewers`

### Additional Public Category Route

#### `GET https://kick.com/api/v2/categories/{slug}/clips`

Evidence: `Observed Live In Container`

Status observed:
- `200` for slug form
- `404` for numeric ID form

What it returns:
- category clip list under `clips`
- clip, category, creator, and channel metadata

Example observations:
- `https://kick.com/api/v2/categories/just-chatting/clips` -> `200`
- `https://kick.com/api/v2/categories/15/clips?sort=featured&time=7d` -> `404`

Notes:
- guessed `sort` and `time` values like `featured` and `7d` were invalid for this route
- only the base slug route is confirmed here

## Confirmed Search Surface

### `GET https://search.kick.com/health`

Evidence: `Observed Live In Container`

Status observed:
- `200`

Example response:
- `{"ok":true}`

### `POST https://search.kick.com/multi_search`

Evidence: `Observed Live In Container`

Status observed:
- `200` with the public Typesense key

Confirmed collection:
- `channel`

Confirmed searchable field:
- `username`

Not searchable:
- `slug` in `query_by`

Observed responses:
- `collection=channel`, `query_by=username`, `q=xqc` -> `200`, returned hits including `slug`, `username`, `followers_count`, `is_live`, `verified`
- `collection=channel`, `query_by=username,slug` -> `200` with error payload:
  - `Field slug is marked as a non-indexed field in the schema.`
- `collection=category`, `query_by=name`, `q=valorant` -> `200` with result-level error:
  - `Collection not found`

Practical conclusion:
- the public search surface is currently confirmed for channel search only
- there is no evidence yet of a public category Typesense collection

### `GET https://search.kick.com/collections`

Evidence: `Observed Live In Container`

Status observed:
- `401`

Observed response:
- `{"message": "Forbidden - a valid \`x-typesense-api-key\` header must be sent."}`

Important note:
- this still returned `401` even when probed with the current public search key
- public schema enumeration should be treated as unavailable

## Realtime/Public Client Surface

### Pusher Config

Evidence: `Observed In Live Bundle`

Confirmed env-config values:
- `NEXT_PUBLIC_PUSHER_KEY = 32cbd69e4b950bf97679`
- `NEXT_PUBLIC_PUSHER_CLUSTER = us2`

Observed source:
- env-config chunk `428-8648c361edd7b568.js`

### Pusher Auth Endpoints

Evidence: `Observed In Live Bundle`

Bundle strings observed:
- `/pusher/auth`
- `/pusher/user-auth`

Interpretation:
- at least some realtime channels are auth-gated
- public possession of the Pusher key is not enough to assume unrestricted channel access

### Channel Naming Patterns

Evidence: `Observed In Live Bundle`

Bundle-observed patterns:
- public `channel.{id}`
- private `private-{id}`
- `private-userfeed.{id}`
- `presence-*`
- `private-encrypted-*`

Important limitation:
- this document does not claim websocket subscription success
- these naming patterns are bundle-derived, not runtime-validated subscriptions

### Why This Matters

Potentially useful:
- public `channel.{id}` suggests some realtime events may be available without user auth
- private/presence/userfeed channels clearly require auth flows

Not yet validated:
- which events are published on each channel
- whether public channel subscriptions work from an unauthenticated client
- whether useful streamer-info or category events exist in realtime

## Observed Public Env Config

### Data/Realtime Relevant

Evidence: `Observed In Live Bundle`

From live env-config chunk `428-8648c361edd7b568.js`:

| Key | Value | Classification |
|---|---|---|
| `NEXT_PUBLIC_TYPESENSE_API_KEY` | `nXIMW0iEN6sMujFYjFuhdrSwVow3pDQu` | Potentially useful for data access |
| `NEXT_PUBLIC_TYPESENSE_URL` | `https://search.kick.com` | Potentially useful for data access |
| `NEXT_PUBLIC_PUSHER_KEY` | `32cbd69e4b950bf97679` | Potentially useful for data access |
| `NEXT_PUBLIC_PUSHER_CLUSTER` | `us2` | Potentially useful for data access |
| `NEXT_PUBLIC_FLAGS_URL` | `https://flags.kick.com` | Potentially useful for data access |
| `NEXT_PUBLIC_BASE_FILES_URL` | `https://files.kick.com` | Infra/service root |
| `NEXT_PUBLIC_LOGIN_URL` | `https://id.kick.com` | Infra/service root |
| `NEXT_PUBLIC_APP_WEB_URL` | `https://web.kick.com` | Infra/service root |
| `NEXT_PUBLIC_APP_MAIN_URL` | `https://kick.com` | Infra/service root |
| `NEXT_PUBLIC_APP_DASHBOARD_URL` | `https://dashboard.kick.com` | Infra/service root |
| `NEXT_PUBLIC_APP_BOUNTIES_URL` | `https://bounties.kick.com` | Infra/service root |
| `NEXT_PUBLIC_APP_DEV_PORTAL_URL` | `https://dev.kick.com` | Infra/service root |
| `NEXT_PUBLIC_APP_STREAMER_PORTAL_URL` | `https://streamer.kick.com` | Infra/service root |
| `NEXT_PUBLIC_APP_ABOUT_URL` | `https://about.kick.com` | Infra/service root |

### Interpretation

Most useful findings:
- search and realtime both use publicly exposed client config
- the live bundle is currently a better source of truth for client-search config than the app's current scraper
- `flags.kick.com` is exposed but not investigated in this memo beyond discovery

## Known Limits, Auth Gates, And Failure Modes

### Confirmed Auth Gates

`Observed Live In Container`:
- `https://kick.com/api/v1/live-channels/{term}/search` -> `401 Unauthenticated`
- `https://search.kick.com/collections` -> `401`

### Not JSON Despite API-Looking Path

`Observed Live In Container`:
- `https://kick.com/api/v2/categories/{slug}` returned HTML, not JSON
- `https://kick.com/api/v2/categories` returned HTML, not JSON

### Search Limitations

- `channel` search is confirmed
- `category` search via Typesense is not confirmed
- `slug` is returned in search results but is not queryable in `query_by`

### Viewer Count Caveat

- some public livestream list endpoints return `viewer_count: 0` for live rows
- `current-viewers` is the more reliable lightweight refresh source

### Bundle-Mining Caveat

- bundle-observed values are live at the time of observation, not stable contracts
- chunk names and public keys can rotate

## Recommended Extraction/Proxy Improvements

### Typesense Extraction

Replace the current heuristic with:
- absolute + relative chunk URL parsing
- scan all discovered chunk URLs
- prioritize env-config chunks with `NEXT_PUBLIC_*`
- capture structured public config, not only `apiKey` regex matches
- keep fallback only for failure recovery

### Public Search Proxying

If search remains in scope:
- keep `channel` collection only
- do not assume category search exists on Typesense
- document `username` as the safe `query_by` field
- continue enriching search hits with channel/live payloads when richer data is needed

### Category Discovery Strategy

Use:
- `/api/v2/channels/{slug}/recent-categories`
- `/stream/livestreams/{lang}?category={parent_slug}&strict=true`
- `/stream/livestreams/{lang}?subcategory={leaf_slug}&strict=true`
- `/stream/livestreams/{lang}?subcategories={leaf_slug}&strict=true`
- `/api/v2/categories/{slug}/clips`

Do not rely on:
- numeric category IDs in public livestream filters
- `api/v2/categories/{slug}` as a JSON metadata route

Implementation note for this app:
- selector values sourced from `stream.categories[0]` are leaf categories
- those should be sent as `subcategory`, not `category`
- reserve `category` for explicit parent-group selectors like `games`

### Viewer Count Strategy

Use:
- livestream/channel payload viewer counts as initial values
- `current-viewers` for refresh

Do not rely on:
- `viewer_count` from general livestream lists as the sole truth source

Important nuance:
- if `strict=true` or the correct `subcategory` form is missing, livestream list payloads can look misleading enough to create a false diagnosis about the upstream data

### Realtime Follow-Up

If realtime becomes a future task:
- separately validate unauthenticated subscription to `channel.{id}`
- keep private/presence/userfeed channels out of scope unless auth is added

## Reproduction Commands

All commands below are intended to run inside the deployed Pi container.

### 1. Confirm CloudScraper-backed session

```bash
python - <<'PY'
from services.kick_api_service import kick_api_client
print(type(kick_api_client.session).__name__)
print(kick_api_client.session.headers.get("User-Agent"))
PY
```

### 2. Show stale Typesense extraction fallback

```bash
python - <<'PY'
from services.kick_api_service import kick_api_client
print(kick_api_client._get_typesense_key(force_refresh=True))
PY
```

### 3. Confirm live env-config chunk exposes `NEXT_PUBLIC_TYPESENSE_*`

```bash
python - <<'PY'
from services.kick_api_service import kick_api_client
url = "https://assets.kick.com/main/_next/static/chunks/428-8648c361edd7b568.js"
text = kick_api_client.session.get(url, timeout=(3, 8)).text
for needle in ["NEXT_PUBLIC_TYPESENSE_API_KEY", "NEXT_PUBLIC_TYPESENSE_URL", "NEXT_PUBLIC_PUSHER_KEY"]:
    idx = text.find(needle)
    print(needle, idx)
    print(text[max(0, idx-120):idx+260].replace(chr(10), " "))
    print("---")
PY
```

### 4. Probe confirmed public data routes

```bash
python - <<'PY'
from services.kick_api_service import kick_api_client
urls = [
    "https://kick.com/api/v2/channels/cavs",
    "https://kick.com/api/v2/channels/cavs/info",
    "https://kick.com/api/v2/channels/cavs/recent-categories",
    "https://kick.com/api/v2/channels/cavs/videos",
    "https://kick.com/api/v2/channels/cavs/clips",
]
for url in urls:
    resp = kick_api_client.session.get(url, timeout=(3, 10))
    print(url, resp.status_code)
    print(resp.text[:600])
    print("---")
PY
```

### 5. Probe livestream list and slug filters

```bash
python - <<'PY'
from services.kick_api_service import kick_api_client
urls = [
    "https://kick.com/stream/featured-livestreams/tr?page=1",
    "https://kick.com/stream/livestreams/tr?page=1&limit=2",
    "https://kick.com/stream/livestreams/tr?page=1&limit=14&category=games&strict=true",
    "https://kick.com/stream/livestreams/tr?page=1&limit=14&category=irl&strict=true",
    "https://kick.com/stream/livestreams/tr?page=1&limit=14&subcategory=irl&strict=true",
    "https://kick.com/stream/livestreams/tr?page=1&limit=14&subcategory=irl&sort=desc&strict=true",
    "https://kick.com/stream/livestreams/tr?page=1&limit=14&subcategory=just-chatting&sort=desc&strict=true",
    "https://kick.com/stream/livestreams/tr?page=1&limit=14&subcategory=ea-sports-fc-26&strict=true",
    "https://kick.com/stream/livestreams/tr?page=1&limit=14&subcategory=ea-sports-fc-26&sort=desc&strict=true",
]
for url in urls:
    resp = kick_api_client.session.get(url, timeout=(3, 10))
    print(url, resp.status_code)
    print(resp.text[:600])
    print("---")
PY
```

### 5a. Probe accepted and rejected `sort` values

```bash
python - <<'PY'
from services.kick_api_service import kick_api_client
urls = [
    "https://kick.com/stream/livestreams/tr?page=1&limit=14&subcategory=irl&sort=featured&strict=true",
    "https://kick.com/stream/livestreams/tr?page=1&limit=14&subcategory=irl&sort=asc&strict=true",
    "https://kick.com/stream/livestreams/tr?page=1&limit=14&subcategory=irl&sort=desc&strict=true",
    "https://kick.com/stream/livestreams/tr?page=1&limit=14&subcategory=irl&sort=viewers&strict=true",
    "https://kick.com/stream/livestreams/tr?page=1&limit=14&subcategory=irl&sort=viewer_count&strict=true",
]
for url in urls:
    resp = kick_api_client.session.get(url, timeout=(3, 10))
    print(url, resp.status_code)
    print(resp.text[:400])
    print("---")
PY
```

### 6. Probe viewer counts

```bash
python - <<'PY'
from services.kick_api_service import kick_api_client
resp = kick_api_client.session.get(
    "https://kick.com/current-viewers?ids[]=101329688",
    timeout=(3, 10),
)
print(resp.status_code)
print(resp.text)
PY
```

### 7. Probe Typesense search

```bash
python - <<'PY'
from services.kick_api_service import kick_api_client
key = kick_api_client._get_typesense_key(force_refresh=True)
headers = {
    "x-typesense-api-key": key,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Referer": "https://kick.com/",
    "Origin": "https://kick.com",
}
payload = {
    "searches": [
        {"q": "xqc", "collection": "channel", "query_by": "username", "per_page": 1}
    ]
}
resp = kick_api_client.session.post(
    "https://search.kick.com/multi_search",
    json=payload,
    headers=headers,
    timeout=(3, 8),
)
print(resp.status_code)
print(resp.text[:1200])
PY
```

### 8. Probe category clips

```bash
python - <<'PY'
from services.kick_api_service import kick_api_client
urls = [
    "https://kick.com/api/v2/categories/just-chatting/clips",
    "https://kick.com/api/v2/categories/15/clips",
]
for url in urls:
    resp = kick_api_client.session.get(url, timeout=(3, 10))
    print(url, resp.status_code)
    print(resp.text[:600])
    print("---")
PY
```

### 9. Probe auth-gated routes

```bash
python - <<'PY'
from services.kick_api_service import kick_api_client
key = kick_api_client._get_typesense_key(force_refresh=True)
headers = {
    "x-typesense-api-key": key,
    "Accept": "application/json",
    "Referer": "https://kick.com/",
    "Origin": "https://kick.com",
}
for url, hdrs in [
    ("https://kick.com/api/v1/live-channels/cav/search", None),
    ("https://search.kick.com/collections", headers),
]:
    resp = kick_api_client.session.get(url, headers=hdrs, timeout=(3, 10))
    print(url, resp.status_code)
    print(resp.text[:400])
    print("---")
PY
```

### 10. Probe bundle-observed Pusher config and channel patterns

```bash
python - <<'PY'
from services.kick_api_service import kick_api_client
url = "https://assets.kick.com/main/_next/static/chunks/428-8648c361edd7b568.js"
text = kick_api_client.session.get(url, timeout=(3, 8)).text
for needle in [
    "NEXT_PUBLIC_PUSHER_KEY",
    "NEXT_PUBLIC_PUSHER_CLUSTER",
    "NEXT_PUBLIC_TYPESENSE_API_KEY",
]:
    idx = text.find(needle)
    print(needle, idx)
    print(text[max(0, idx-120):idx+260].replace(chr(10), " "))
    print("---")

url = "https://assets.kick.com/main/_next/static/chunks/8228-8c7126c8098bc2a1.js"
text = kick_api_client.session.get(url, timeout=(3, 8)).text
for needle in ["/pusher/auth", "/pusher/user-auth", "private-", "presence-"]:
    idx = text.find(needle)
    print(needle, idx)
    print(text[max(0, idx-120):idx+260].replace(chr(10), " "))
    print("---")
PY
```

## Appendix: Non-Data Public Client Keys

Evidence: `Observed In Live Bundle`

From the same live env-config chunk:

| Key | Value | Classification |
|---|---|---|
| `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` | `6LfBYREqAAAAAJG3ETRtFEhPPg5hE1xsBJnUnEAZ` | Unrelated client config |
| `NEXT_PUBLIC_STRIPE_PUBLIC_KEY` | `pk_live_51M8ug4E5WX7FB3n5ayu51Uy7gs3ZPTXJ0sZQosoPSTPHuGjkp9be2hJfJSc2w5O1FreUY6zD7vUyUfDJWjEc9rc500q1xUxGlh` | Unrelated client config |
| `NEXT_PUBLIC_STRIPE_PAYPAL_CUSTOM_PAYMENT_METHOD_ID` | `cpmt_1ScSt5E5WX7FB3n5LiL30s88` | Unrelated client config |
| `NEXT_PUBLIC_INTERCOM_APP_ID` | `per7qesc` | Unrelated client config |
| `NEXT_PUBLIC_FPJS_API_KEY` | `bnmMb7Gv1PkwUZwr5iuz` | Unrelated client config |
| `NEXT_PUBLIC_GPT_NETWORK_ID` | `23324015424` | Unrelated client config |
| `NEXT_PUBLIC_GPT_BASE_PATH_DISPLAY` | `Kick_Display` | Unrelated client config |
| `NEXT_PUBLIC_GPT_BASE_PATH_NATIVE` | `Kick_Native` | Unrelated client config |

These are intentionally kept out of the main body because they are not directly required for search, category discovery, streamer info, livestream discovery, or viewer counts.
