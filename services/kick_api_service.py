import re
import time
import threading
import cloudscraper
from urllib.parse import quote_plus
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import logging
from config import Config

logger = logging.getLogger(__name__)


class KickAPIClient:
    BASE_URL = Config.KICK_API_BASE_URL

    def __init__(self):
        self.session = cloudscraper.create_scraper()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36",
            "Accept": "application/json",
            "Content-Type": "application/json"
        })

        # Connection pooling and retry strategy
        # Worst case: 2 retries × (0.3s, 0.6s backoff) + 3 attempts × 8s timeout = ~25s max
        retry_strategy = Retry(
            total=2,
            backoff_factor=0.3,
            status_forcelist=[502, 503, 504],
            allowed_methods=["GET"],
        )
        
        # We must configure cloudscraper's existing adapters instead of replacing them!
        # Replacing them with HTTPAdapter breaks the Cloudflare bypass.
        for protocol in ["http://", "https://"]:
            adapter = self.session.get_adapter(protocol)
            adapter.max_retries = retry_strategy
            # The pool size properties for HTTPAdapter
            adapter._pool_connections = 5
            adapter._pool_maxsize = 10

    def get_channel_data(self, channel_slug: str, timeout: int = 8) -> dict:
        url = f"{self.BASE_URL}{channel_slug}"
        logger.debug(f"Fetching Kick API URL: {url}")
        response = self.session.get(url, timeout=(3, timeout))  # (connect, read) timeout
        response.raise_for_status()
        return response.json()

    def get_channel_videos(self, channel_slug: str, timeout: int = 10) -> list:
        url = f"{self.BASE_URL}{channel_slug}/videos"
        logger.debug(f"Fetching Kick API URL: {url}")
        response = self.session.get(url, timeout=(3, timeout))
        response.raise_for_status()
        return response.json()

    def get_featured_livestreams(self, language: str = "en", page: int = 1, timeout: int = 8) -> dict:
        url = f"{Config.KICK_FEATURED_LIVESTREAMS_URL}{language}?page={page}"
        logger.debug(f"Fetching Kick API URL for featured livestreams: {url}")
        response = self.session.get(url, timeout=(3, timeout))
        response.raise_for_status()
        return response.json()

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
        logger.debug(
            f"Fetching all livestreams for language: {language}, page: {page}, "
            f"category: {category!r}, subcategory: {subcategory!r}, "
            f"subcategories: {subcategories!r}, sort: {sort!r}, strict: {strict!r}"
        )
        response = self.session.get(url, timeout=(3, timeout))
        response.raise_for_status()
        return response.json()

    def get_channel_clips(self, channel_slug: str, timeout: int = 10) -> dict:
        url = f"{self.BASE_URL}{channel_slug}/clips"
        logger.debug(f"Fetching clips for channel: {channel_slug}")
        response = self.session.get(url, timeout=(3, timeout))
        response.raise_for_status()
        return response.json()

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

    # Shared across all instances so the key isn't re-fetched per-request
    _ts_key_cache: str | None = None
    _ts_key_fetched_at: float = 0.0
    _ts_key_lock = threading.Lock()

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
                        logger.info(f"Typesense key found in chunk: {path}")
                        return m.group(1)
                except Exception:
                    continue
        except Exception as exc:
            logger.warning(f"Typesense key bundle fetch failed: {exc}")
        return None

    def _get_typesense_key(self, force_refresh: bool = False) -> str:
        """
        Return a valid Typesense key.
        Priority: in-memory cache (24 h TTL) → fresh bundle scrape → hard fallback.
        Thread-safe via class-level lock.
        """
        with self._ts_key_lock:
            now = time.time()
            if (
                not force_refresh
                and KickAPIClient._ts_key_cache
                and (now - KickAPIClient._ts_key_fetched_at) < self._TYPESENSE_KEY_TTL
            ):
                return KickAPIClient._ts_key_cache

            logger.info("Refreshing Typesense API key from Kick JS bundle…")
            fresh = self._fetch_typesense_key_from_bundle()
            # Always update the timestamp so we don't hammer the bundle on failures
            KickAPIClient._ts_key_fetched_at = now
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

    def search_channels_typesense(self, query: str, timeout: int = 8) -> list:
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
                    f"Typesense auth failed (attempt {attempt + 1}), "
                    "invalidating cached key."
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

    def search_channels(self, query: str, timeout: int = 8) -> list:
        url = "https://search.kick.com/multi_search"
        payload = {
            "queries": [{
                "indexUid": "channel",
                "q": query,
                "limit": 8,
                "attributesToRetrieve": ["slug", "username", "profile_pic", "followers_count", "is_live"]
            }]
        }
        logger.debug(f"Searching channels for query: {query}")
        response = self.session.post(url, json=payload, timeout=(3, timeout))
        response.raise_for_status()
        data = response.json()
        # Meilisearch multi_search returns {"results": [{"hits": [...]}]}
        results = data.get("results", [])
        return results[0].get("hits", []) if results else []

    def get_viewer_count(self, livestream_id: int, timeout: int = 5) -> int:
        url = f"https://kick.com/api/v1/current-viewers?ids[]={livestream_id}"
        logger.debug(f"Fetching viewer count for livestream_id: {livestream_id}")
        response = self.session.get(url, timeout=(3, timeout))
        response.raise_for_status()
        if not response.text.strip():
            return 0
        try:
            data = response.json()
        except Exception:
            logger.debug(f"Non-JSON viewer count response for livestream_id: {livestream_id}")
            return 0
        # Response: [{"id": <int>, "viewers": <int>}]
        if isinstance(data, list) and data:
            return data[0].get("viewers", 0)
        return 0


kick_api_client = KickAPIClient()
