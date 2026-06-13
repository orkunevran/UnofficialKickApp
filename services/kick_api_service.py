import asyncio
import logging
import re
import time
from typing import Union
from urllib.parse import quote_plus

from curl_cffi import requests as curl_requests
from curl_cffi.requests import AsyncSession
import requests

from config import Config

logger = logging.getLogger(__name__)


class RequestsCompatibleAsyncSession(AsyncSession):
    async def request(self, *args, **kwargs):
        try:
            resp = await super().request(*args, **kwargs)
            original_raise = resp.raise_for_status
            def new_raise():
                try:
                    original_raise()
                except curl_requests.errors.RequestsError as exc:
                    import requests.exceptions
                    raise requests.exceptions.HTTPError(
                        str(exc),
                        response=resp,
                    ) from exc
            resp.raise_for_status = new_raise
            return resp
        except curl_requests.errors.RequestsError as exc:
            import requests.exceptions
            response_obj = getattr(exc, "response", None)
            if response_obj is not None:
                raise requests.exceptions.HTTPError(
                    str(exc),
                    response=response_obj,
                ) from exc
            code = getattr(exc, "code", None)
            if code == 28 or "timeout" in str(exc).lower():
                raise requests.exceptions.Timeout(
                    str(exc),
                    response=response_obj,
                ) from exc
            raise requests.exceptions.ConnectionError(
                str(exc),
                response=response_obj,
            ) from exc


class KickAPIClient:
    BASE_URL = Config.KICK_API_BASE_URL

    _COMMON_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }

    # Shared across all instances so the key isn't re-fetched per-request.
    _ts_key_cache = None
    _ts_key_fetched_at: float = 0.0  # monotonic clock
    _ts_lock = None

    def __init__(self):
        self.session = RequestsCompatibleAsyncSession(impersonate="chrome120")
        self.session.headers.update(self._COMMON_HEADERS)

    async def _get_json(self, url: str, timeout: int = 8) -> Union[dict, list]:
        """GET *url*, raise on HTTP errors, return decoded JSON."""
        logger.debug("Fetching Kick API URL: %s", url)
        response = await self.session.get(url, timeout=(3, timeout))
        response.raise_for_status()
        return response.json()

    async def get_channel_data(self, channel_slug: str, timeout: int = 8) -> dict:
        return await self._get_json(f"{self.BASE_URL}{channel_slug}", timeout)

    async def get_channel_videos(self, channel_slug: str, timeout: int = 10) -> list:
        return await self._get_json(f"{self.BASE_URL}{channel_slug}/videos", timeout)

    async def get_featured_livestreams(self, language: str = "en", page: int = 1, timeout: int = 8) -> dict:
        return await self._get_json(f"{Config.KICK_FEATURED_LIVESTREAMS_URL}{language}?page={page}", timeout)

    # Match featured-livestreams page size (Kick's all-livestreams default is 5)
    ALL_LIVESTREAMS_PAGE_SIZE = 14

    async def get_all_livestreams(
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
        return await self._get_json(url, timeout)

    async def get_channel_clips(self, channel_slug: str, timeout: int = 10) -> dict:
        return await self._get_json(f"{self.BASE_URL}{channel_slug}/clips", timeout)

    TYPESENSE_URL = "https://search.kick.com"
    TYPESENSE_KEY_FALLBACK = "nXIMW0iEN6sMujFYjFuhdrSwVow3pDQu"
    _TYPESENSE_KEY_TTL = 86_400   # 24 hours
    _TYPESENSE_KEY_PATTERN = re.compile(
        r'(?:TYPESENSE_API_KEY|typesenseApiKey|apiKey)[^\w"\']{0,10}["\']([A-Za-z0-9]{20,50})["\']'
    )

    async def _fetch_typesense_key_from_bundle(self) -> Union[str, None]:
        """Scrape Kick's Next.js JS chunks to find the current Typesense API key."""
        try:
            home = await self.session.get("https://kick.com/", timeout=(3, 10))
            if not home.ok:
                return None
            chunk_paths = list(dict.fromkeys(
                re.findall(r'/_next/static/chunks/[^\s"\'<>]+\.js', home.text)
            ))
            chunk_paths.sort(key=lambda p: (
                0 if 'pages/_app' in p or 'webpack' in p else
                1 if re.search(r'/\d{3}-', p) else 2
            ))
            for path in chunk_paths[:25]:
                try:
                    cr = await self.session.get(f"https://kick.com{path}", timeout=(3, 6))
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

    async def _get_typesense_key(self, force_refresh: bool = False) -> str:
        """
        Return a valid Typesense key.
        Priority: in-memory cache (24 h TTL) → fresh bundle scrape → hard fallback.
        """
        now = time.monotonic()
        if (
            not force_refresh
            and KickAPIClient._ts_key_cache
            and (now - KickAPIClient._ts_key_fetched_at) < self._TYPESENSE_KEY_TTL
        ):
            return KickAPIClient._ts_key_cache

        if KickAPIClient._ts_lock is None:
            KickAPIClient._ts_lock = asyncio.Lock()
        async with KickAPIClient._ts_lock:
            now = time.monotonic()
            if (
                not force_refresh
                and KickAPIClient._ts_key_cache
                and (now - KickAPIClient._ts_key_fetched_at) < self._TYPESENSE_KEY_TTL
            ):
                return KickAPIClient._ts_key_cache

            logger.info("Refreshing Typesense API key from Kick JS bundle…")
            fresh = await self._fetch_typesense_key_from_bundle()

            KickAPIClient._ts_key_fetched_at = time.monotonic()
            if fresh:
                KickAPIClient._ts_key_cache = fresh
                logger.info("Typesense key refreshed successfully.")
                return fresh
            if KickAPIClient._ts_key_cache:
                logger.warning("Bundle scrape returned nothing — keeping previous key.")
                return KickAPIClient._ts_key_cache
            logger.warning("Using hard-coded Typesense fallback key.")
            KickAPIClient._ts_key_cache = self.TYPESENSE_KEY_FALLBACK
            return self.TYPESENSE_KEY_FALLBACK

    async def search_channels_typesense(self, query: str, timeout: int = 3) -> list[dict[str, object]]:
        """
        Search all Kick channels via Typesense.
        Returns live channels first (sorted by followers), then offline matches.
        Auto-retries once with a fresh key on 401/403.
        """
        for attempt in range(2):
            key = await self._get_typesense_key(force_refresh=(attempt > 0))
            headers = {
                "x-typesense-api-key": key,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Referer": "https://kick.com/",
                "Origin": "https://kick.com",
            }
            payload = {"searches": [
                {
                    "q": query, "collection": "channel", "query_by": "username",
                    "filter_by": "is_live:true", "sort_by": "followers_count:desc",
                    "per_page": 8,
                },
                {
                    "q": query, "collection": "channel", "query_by": "username",
                    "sort_by": "followers_count:desc", "per_page": 8,
                },
            ]}
            response = await self.session.post(
                f"{self.TYPESENSE_URL}/multi_search",
                json=payload, headers=headers, timeout=(3, timeout)
            )

            if response.status_code in (401, 403):
                logger.warning(
                    "Typesense auth failed (attempt %d), invalidating cached key.",
                    attempt + 1,
                )
                KickAPIClient._ts_key_cache = None
                if attempt == 0:
                    continue
                response.raise_for_status()

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
                            "profile_picture": None,
                        })
                    if len(merged) >= 8:
                        break
                if len(merged) >= 8:
                    break
            return merged

        return []

    async def get_viewer_count(self, livestream_id: int, timeout: int = 5) -> int:
        url = f"https://kick.com/current-viewers?ids[]={livestream_id}"
        logger.debug("Fetching viewer count for livestream_id: %s", livestream_id)
        response = await self.session.get(url, timeout=(3, timeout))
        response.raise_for_status()
        if not response.text.strip():
            return 0
        try:
            data = response.json()
        except (ValueError, TypeError):
            logger.debug("Non-JSON viewer count response for livestream_id: %s", livestream_id)
            return 0
        if isinstance(data, list) and data:
            return data[0].get("viewers", 0)
        return 0

    _BATCH_VIEWER_MAX = 10  # Kick.com enforces max 10 ids per request

    async def get_viewer_counts_batch(self, livestream_ids: list[int], timeout: int = 5) -> dict[int, int]:
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
                response = await self.session.get(url, timeout=(3, timeout))
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
