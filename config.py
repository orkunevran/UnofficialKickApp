import os
import logging

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
    # Note: SimpleCache is generally thread-safe in recent versions of Flask-Caching,
    # but for high-load production, consider RedisCache or FileSystemCache.
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

    # Chromecast Settings
    CHROMECAST_SCAN_TIMEOUT = int(os.environ.get('CHROMECAST_SCAN_TIMEOUT', 5))
    CHROMECAST_SELECT_MAX_RETRIES = int(os.environ.get('CHROMECAST_SELECT_MAX_RETRIES', 2))
    CHROMECAST_SELECT_RETRY_DELAY = int(os.environ.get('CHROMECAST_SELECT_RETRY_DELAY', 2))
    CHROMECAST_MAX_CONNECTION_FAILURES = int(os.environ.get('CHROMECAST_MAX_CONNECTION_FAILURES', 3))
    CHROMECAST_DEVICE_CACHE_SECONDS = int(os.environ.get('CHROMECAST_DEVICE_CACHE_SECONDS', 30))
    CHROMECAST_STOP_WAIT_SECONDS = float(os.environ.get('CHROMECAST_STOP_WAIT_SECONDS', 2.0))
