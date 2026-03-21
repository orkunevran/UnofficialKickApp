import os

class Config:
    # Application Settings
    FLASK_DEBUG = os.environ.get('FLASK_DEBUG', 'False').lower() == 'true'
    PORT = int(os.environ.get('PORT', 8081))
    LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO').upper()

    # API Settings
    KICK_API_BASE_URL = os.environ.get('KICK_API_BASE_URL', "https://kick.com/api/v2/channels/")
    KICK_FEATURED_LIVESTREAMS_URL = os.environ.get('KICK_FEATURED_LIVESTREAMS_URL', "https://kick.com/stream/featured-livestreams/")
    KICK_ALL_LIVESTREAMS_URL = os.environ.get('KICK_ALL_LIVESTREAMS_URL', "https://kick.com/stream/livestreams/")

    # Cache Settings
    # The app now uses a transport-neutral in-memory cache adapter.
    CACHE_TYPE = os.environ.get('CACHE_TYPE', 'SimpleCache')
    CACHE_DEFAULT_TIMEOUT = int(os.environ.get('CACHE_DEFAULT_TIMEOUT', 300))
    LIVE_CACHE_DURATION_SECONDS = int(os.environ.get('LIVE_CACHE_DURATION_SECONDS', 30))
    VOD_CACHE_DURATION_SECONDS = int(os.environ.get('VOD_CACHE_DURATION_SECONDS', 300))
    # Featured streams change slower than live stream status — 60s avoids hammering Kick
    # while keeping the list fresh enough for the 90s client auto-refresh cycle.
    FEATURED_CACHE_DURATION_SECONDS = int(os.environ.get('FEATURED_CACHE_DURATION_SECONDS', 60))

    # Featured Languages
    FEATURED_LANGUAGES = [
        {'code': 'en', 'name': 'English'},
        {'code': 'tr', 'name': 'Turkish'},
        {'code': 'es', 'name': 'Spanish'},
        {'code': 'de', 'name': 'German'},
        {'code': 'fr', 'name': 'French'},
        {'code': 'ru', 'name': 'Russian'},
    ]
    DEFAULT_LANGUAGE_CODE = os.environ.get('DEFAULT_LANGUAGE_CODE', 'tr')

    # Thread pool size for asyncio.to_thread() calls (0 = Python default)
    ASYNCIO_THREAD_WORKERS = int(os.environ.get('ASYNCIO_THREAD_WORKERS', 0))

    # Chromecast Settings
    CHROMECAST_SCAN_TIMEOUT = int(os.environ.get('CHROMECAST_SCAN_TIMEOUT', 5))
    CHROMECAST_SELECT_MAX_RETRIES = int(os.environ.get('CHROMECAST_SELECT_MAX_RETRIES', 2))
    CHROMECAST_SELECT_RETRY_DELAY = int(os.environ.get('CHROMECAST_SELECT_RETRY_DELAY', 2))
    CHROMECAST_MAX_CONNECTION_FAILURES = int(os.environ.get('CHROMECAST_MAX_CONNECTION_FAILURES', 3))
    CHROMECAST_DEVICE_CACHE_SECONDS = int(os.environ.get('CHROMECAST_DEVICE_CACHE_SECONDS', 30))
    CHROMECAST_STOP_WAIT_SECONDS = float(os.environ.get('CHROMECAST_STOP_WAIT_SECONDS', 2.0))
    # Docker Desktop on macOS does not expose LAN multicast reliably, so fall back
    # to probing common private /24 ranges when mDNS discovery returns nothing.
    CHROMECAST_FALLBACK_SCAN_ENABLED = os.environ.get('CHROMECAST_FALLBACK_SCAN_ENABLED', 'True').lower() == 'true'
    CHROMECAST_FALLBACK_SCAN_SUBNETS = os.environ.get(
        'CHROMECAST_FALLBACK_SCAN_SUBNETS',
        '192.168.0.0/24,192.168.1.0/24,192.168.2.0/24,10.0.0.0/24,10.0.1.0/24,10.0.2.0/24',
    )
    CHROMECAST_FALLBACK_SCAN_WORKERS = int(os.environ.get('CHROMECAST_FALLBACK_SCAN_WORKERS', 96))
    CHROMECAST_FALLBACK_SCAN_PROBE_TIMEOUT = float(os.environ.get('CHROMECAST_FALLBACK_SCAN_PROBE_TIMEOUT', 0.25))
    CHROMECAST_FALLBACK_DEVICE_INFO_TIMEOUT = float(os.environ.get('CHROMECAST_FALLBACK_DEVICE_INFO_TIMEOUT', 3.0))

    # Per-endpoint cache durations (previously hardcoded in route files)
    SEARCH_CACHE_DURATION_SECONDS   = int(os.environ.get('SEARCH_CACHE_DURATION_SECONDS', 30))
    AVATAR_CACHE_DURATION_SECONDS   = int(os.environ.get('AVATAR_CACHE_DURATION_SECONDS', 604800))  # 7 days
    VIEWER_CACHE_DURATION_SECONDS   = int(os.environ.get('VIEWER_CACHE_DURATION_SECONDS', 10))
    # Short TTL for error responses — avoids hammering Kick for invalid/rate-limited slugs
    NEGATIVE_CACHE_DURATION_SECONDS = int(os.environ.get('NEGATIVE_CACHE_DURATION_SECONDS', 10))
    # Stale-while-revalidate window for featured streams — data served up to this age
    # while a background refresh runs silently
    FEATURED_STALE_TTL_SECONDS      = int(os.environ.get('FEATURED_STALE_TTL_SECONDS', 300))

    @classmethod
    def to_dict(cls):
        return {name: getattr(cls, name) for name in dir(cls) if name.isupper()}
