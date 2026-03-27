import logging
import re
import threading
import time
from urllib.parse import quote_plus

import cloudscraper
import requests
from urllib3.util.retry import Retry

from config import Config

logger = logging.getLogger(__name__)


class KickAPIClient:
    BASE_URL = Config.KICK_API_BASE_URL

    # ------------------------------------------------------------------ #
    # Thread-safe session management                                      #
    #                                                                     #
    # requests.Session (and its CloudScraper subclass) is NOT thread-safe.#
    # asyncio.to_thread() dispatches blocking calls to a thread pool, so  #
    # concurrent requests (featured refresh + batch viewer + channel data) #
    # can corrupt shared session state (cookies, redirect history, etc.). #
    #                                                                     #
    # Fix: use threading.local() to give each worker thread its own       #
    # CloudScraper session. Sessions are created lazily and reused within #
    # the same thread, maintaining connection pooling benefits.            #
    # ------------------------------------------------------------------ #

    _COMMON_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }

    _RETRY_STRATEGY = Retry(
        total=2,
        backoff_factor=0.3,
        status_forcelist=[502, 503, 504],
        allowed_methods=["GET"],
    )

    def __init__(self):
        self._local = threading.local()

    @property
    def session(self) -> cloudscraper.CloudScraper:
        """Return a thread-local CloudScraper session (created lazily)."""
        s = getattr(self._local, "session", None)
        if s is None:
            s = self._create_session()
            self._local.session = s
        return s

    @classmethod
    def _create_session(cls) -> cloudscraper.CloudScraper:
        s = cloudscraper.create_scraper()
        s.headers.update(cls._COMMON_HEADERS)
        for protocol in ("http://", "https://"):
            adapter = s.get_adapter(protocol)
            adapter.max_retries = cls._RETRY_STRATEGY
            adapter._pool_connections = 5
            adapter._pool_maxsize = 10
        return s

    def _get_json(self, url: str, timeout: int = 8) -> dict | list:
        """GET *url*, raise on HTTP errors, return decoded JSON."""
        logger.debug("Fetching Kick API URL: %s", url)
        response = self.session.get(url, timeout=(3, timeout))
        response.raise_for_status()
        return response.json()

    def get_channel_data(self, channel_slug: str, timeout: int = 8) -> dict:
        return self._get_json(f"{self.BASE_URL}{channel_slug}", timeout)

    def get_channel_videos(self, channel_slug: str, timeout: int = 10) -> list:
        return self._get_json(f"{self.BASE_URL}{channel_slug}/videos", timeout)

    def get_featured_livestreams(self, language: str = "en", page: int = 1, timeout: int = 8) -> dict:
        return self._get_json(f"{Config.KICK_FEATURED_LIVESTREAMS_URL}{language}?page={page}", timeout)

    # Match featured-livestreams page size (Kick's all-livestreams default is 5)
    ALL_LIVESTREAMS_PAGE_SIZE = 14

    def get_all_livestreams(
        self,
        language: str = "en",
        page: int = 1,
        category: str = "",
        subcategory: str = "",
        subcategories: str = "",
        sort: str = "",
        strict: bool = False,
        timeout: int = 10,
    ) -> dict:
        url = f"{Config.KICK_ALL_LIVESTREAMS_URL}{language}?page={page}&limit={self.ALL_LIVESTREAMS_PAGE_SIZE}"
        if category:
            url += f"&category={quote_plus(category)}"
        if subcategory:
            url += f"&subcategory={quote_plus(subcategory)}"
        if subcategories:
            url += f"&subcategories={quote_plus(subcategories)}"
        if sort:
            url += f"&sort={quote_plus(sort)}"
        if strict:
            url += "&strict=true"
        return self._get_json(url, timeout)

    def get_channel_clips(self, channel_slug: str, timeout: int = 10) -> dict:
        return self._get_json(f"{self.BASE_URL}{channel_slug}/clips", timeout)

    # ------------------------------------------------------------------ #
    # Typesense search — covers ALL Kick channels (500k+, 8k+ live)       #
    # Key is a public NEXT_PUBLIC env var that Kick rotates periodically.  #
    # We cache it 24 h and auto-refresh from Kick's JS bundle on expiry   #
    # or auth failure; last-known-good key is kept as a hard fallback.    #
    # ------------------------------------------------------------------ #
    TYPESENSE_URL = "https://search.kick.com"
    TYPESENSE_KEY_FALLBACK = "nXIMW0iEN6sMujFYjFuhdrSwVow3pDQu"
    _TYPESENSE_KEY_TTL = 86_400   # 24 hours
    _TYPESENSE_KEY_PATTERN = re.compile(
        r'(?:TYPESENSE_API_KEY|typesenseApiKey|apiKey)[^\w"\']{0,10}["\']([A-Za-z0-9]{20,50})["\']'
    )

    # Shared across all instances so the key isn't re-fetched per-request.
    # Two-lock pattern: _ts_key_lock guards cache reads/writes (held briefly);
    # _ts_fetch_lock serializes the expensive bundle scrape so only one thread
    # fetches at a time while concurrent cache-hit readers are never blocked.
    _ts_key_cache = None
    _ts_key_fetched_at: float = 0.0  # monotonic clock
    _ts_key_lock = threading.Lock()
    _ts_fetch_lock = threading.Lock()

    def _fetch_typesense_key_from_bundle(self) -> str | None:
        """Scrape Kick's Next.js JS chunks to find the current Typesense API key."""
        try:
            home = self.session.get("https://kick.com/", timeout=(3, 10))
            if not home.ok:
                return None
            # Collect unique /_next/static/chunks/*.js paths from the HTML
            chunk_paths = list(dict.fromkeys(
                re.findall(r'/_next/static/chunks/[^\s"\'<>]+\.js', home.text)
            ))
            # Prioritise smaller "pages/_app" / "webpack" / numbered chunks that
            # are most likely to contain environment-variable substitutions.
            chunk_paths.sort(key=lambda p: (
                0 if 'pages/_app' in p or 'webpack' in p else
                1 if re.search(r'/\d{3}-', p) else 2
            ))
            for path in chunk_paths[:25]:          # cap at 25 chunks
                try:
                    cr = self.session.get(f"https://kick.com{path}", timeout=(3, 6))
                    if not cr.ok:
                        continue
                    m = self._TYPESENSE_KEY_PATTERN.search(cr.text)
                    if m:
                        logger.info("Typesense key found in chunk: %s", path)
                        return m.group(1)
                except Exception:
                    continue
        except Exception as exc:
            logger.warning("Typesense key bundle fetch failed: %s", exc)
        return None

    def _get_typesense_key(self, force_refresh: bool = False) -> str:
        """
        Return a valid Typesense key.
        Priority: in-memory cache (24 h TTL) → fresh bundle scrape → hard fallback.

        Two-lock design:
          _ts_key_lock  – held only for brief cache reads/writes (never during I/O).
          _ts_fetch_lock – serializes the expensive bundle scrape so only one thread
                          fetches at a time. Threads that lose the race recheck the
                          cache inside _ts_fetch_lock and return early if it's warm.
        """
        now = time.monotonic()
        # Fast path: concurrent cache hits never touch _ts_fetch_lock
        with self._ts_key_lock:
            if (
                not force_refresh
                and KickAPIClient._ts_key_cache
                and (now - KickAPIClient._ts_key_fetched_at) < self._TYPESENSE_KEY_TTL
            ):
                return KickAPIClient._ts_key_cache

        # Slow path: serialize fetches so only one thread hits the network
        with self._ts_fetch_lock:
            # Second check — another thread may have fetched while we waited
            now = time.monotonic()
            with self._ts_key_lock:
                if (
                    not force_refresh
                    and KickAPIClient._ts_key_cache
                    and (now - KickAPIClient._ts_key_fetched_at) < self._TYPESENSE_KEY_TTL
                ):
                    return KickAPIClient._ts_key_cache

            logger.info("Refreshing Typesense API key from Kick JS bundle…")
            fresh = self._fetch_typesense_key_from_bundle()

            with self._ts_key_lock:
                # Always update the timestamp so we don't hammer the bundle on failures
                KickAPIClient._ts_key_fetched_at = time.monotonic()
                if fresh:
                    KickAPIClient._ts_key_cache = fresh
                    logger.info("Typesense key refreshed successfully.")
                    return fresh
                # Keep the old cached value if present, otherwise use hard fallback
                if KickAPIClient._ts_key_cache:
                    logger.warning("Bundle scrape returned nothing — keeping previous key.")
                    return KickAPIClient._ts_key_cache
                logger.warning("Using hard-coded Typesense fallback key.")
                KickAPIClient._ts_key_cache = self.TYPESENSE_KEY_FALLBACK
                return self.TYPESENSE_KEY_FALLBACK

    def search_channels_typesense(self, query: str, timeout: int = 8) -> list[dict[str, object]]:
        """
        Search all Kick channels via Typesense.
        Returns live channels first (sorted by followers), then offline matches.
        Auto-retries once with a fresh key on 401/403.
        """
        for attempt in range(2):
            key = self._get_typesense_key(force_refresh=(attempt > 0))
            headers = {
                "x-typesense-api-key": key,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Referer": "https://kick.com/",
                "Origin": "https://kick.com",
            }
            payload = {"searches": [
                # Pass 1: live channels — most relevant for a streaming app
                {
                    "q": query, "collection": "channel", "query_by": "username",
                    "filter_by": "is_live:true", "sort_by": "followers_count:desc",
                    "per_page": 8,
                },
                # Pass 2: all channels (catches offline channels the user might want)
                {
                    "q": query, "collection": "channel", "query_by": "username",
                    "sort_by": "followers_count:desc", "per_page": 8,
                },
            ]}
            response = self.session.post(
                f"{self.TYPESENSE_URL}/multi_search",
                json=payload, headers=headers, timeout=(3, timeout)
            )

            if response.status_code in (401, 403):
                logger.warning(
                    "Typesense auth failed (attempt %d), invalidating cached key.",
                    attempt + 1,
                )
                with self._ts_key_lock:
                    KickAPIClient._ts_key_cache = None
                if attempt == 0:
                    continue          # retry with refreshed key
                response.raise_for_status()  # raise on second failure

            response.raise_for_status()
            data = response.json()

            seen: set = set()
            merged: list = []
            for res in data.get("results", []):
                for hit in res.get("hits", []):
                    doc = hit.get("document", {})
                    slug = doc.get("slug", "")
                    if slug and slug not in seen:
                        seen.add(slug)
                        merged.append({
                            "slug": slug,
                            "username": doc.get("username", slug),
                            "followers_count": doc.get("followers_count", 0),
                            "is_live": doc.get("is_live", False),
                            "verified": doc.get("verified", False),
                            "profile_picture": None,  # not in Typesense index
                        })
                    if len(merged) >= 8:
                        break
                if len(merged) >= 8:
                    break
            return merged

        return []   # unreachable but satisfies type checkers



    def get_viewer_count(self, livestream_id: int, timeout: int = 5) -> int:
        url = f"https://kick.com/current-viewers?ids[]={livestream_id}"
        logger.debug("Fetching viewer count for livestream_id: %s", livestream_id)
        response = self.session.get(url, timeout=(3, timeout))
        response.raise_for_status()
        if not response.text.strip():
            return 0
        try:
            data = response.json()
        except (ValueError, TypeError):
            logger.debug("Non-JSON viewer count response for livestream_id: %s", livestream_id)
            return 0
        # Response: [{"livestream_id": <int>, "viewers": <int>}]
        if isinstance(data, list) and data:
            return data[0].get("viewers", 0)
        return 0

    _BATCH_VIEWER_MAX = 10  # Kick.com enforces max 10 ids per request

    def get_viewer_counts_batch(self, livestream_ids: list[int], timeout: int = 5) -> dict[int, int]:
        """Batch viewer count — chunked into max-10-ID calls to Kick.com.

        Returns {livestream_id: viewer_count, ...}.
        """
        if not livestream_ids:
            return {}
        ids = [int(lid) for lid in livestream_ids[:50]]
        merged: dict[int, int] = {}
        for i in range(0, len(ids), self._BATCH_VIEWER_MAX):
            chunk = ids[i:i + self._BATCH_VIEWER_MAX]
            params = "&".join(f"ids[]={lid}" for lid in chunk)
            url = f"https://kick.com/current-viewers?{params}"
            logger.debug("Fetching batch viewer counts for %d livestream(s)", len(chunk))
            try:
                response = self.session.get(url, timeout=(3, timeout))
                response.raise_for_status()
            except requests.exceptions.RequestException:
                logger.warning("Batch viewer chunk failed for %d IDs, skipping", len(chunk))
                continue
            if not response.text.strip():
                continue
            try:
                data = response.json()
            except (ValueError, TypeError):
                logger.debug("Non-JSON batch viewer count response")
                continue
            if isinstance(data, list):
                for item in data:
                    if "livestream_id" in item:
                        merged[item["livestream_id"]] = item.get("viewers", 0)
        return merged


kick_api_client = KickAPIClient()
