from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="",
        case_sensitive=True,
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Application Settings
    FLASK_DEBUG: bool = False
    PORT: int = Field(8081, ge=1, le=65535)
    LOG_LEVEL: str = "INFO"

    # API Settings
    KICK_API_BASE_URL: str = "https://kick.com/api/v2/channels/"
    KICK_FEATURED_LIVESTREAMS_URL: str = "https://kick.com/stream/featured-livestreams/"
    KICK_ALL_LIVESTREAMS_URL: str = "https://kick.com/stream/livestreams/"

    # Cache Settings
    CACHE_DEFAULT_TIMEOUT: int = Field(300, ge=1)
    CACHE_MAX_SIZE: int = Field(2000, ge=100, le=50000)
    LIVE_CACHE_DURATION_SECONDS: int = Field(30, ge=1)
    VOD_CACHE_DURATION_SECONDS: int = Field(300, ge=1)
    FEATURED_CACHE_DURATION_SECONDS: int = Field(120, ge=1)

    # Featured Languages
    FEATURED_LANGUAGES: list[dict] = [
        {"code": "en", "name": "English"},
        {"code": "tr", "name": "Turkish"},
        {"code": "es", "name": "Spanish"},
        {"code": "de", "name": "German"},
        {"code": "fr", "name": "French"},
        {"code": "ru", "name": "Russian"},
    ]
    DEFAULT_LANGUAGE_CODE: str = "tr"

    # Thread pool size for asyncio.to_thread() calls (0 = Python default)
    ASYNCIO_THREAD_WORKERS: int = Field(0, ge=0)

    # Chromecast Settings
    CHROMECAST_SCAN_TIMEOUT: int = Field(5, ge=1)
    CHROMECAST_SELECT_MAX_RETRIES: int = Field(2, ge=0)
    CHROMECAST_SELECT_RETRY_DELAY: int = Field(2, ge=0)
    CHROMECAST_MAX_CONNECTION_FAILURES: int = Field(3, ge=1)
    CHROMECAST_DEVICE_CACHE_SECONDS: int = Field(30, ge=1)
    CHROMECAST_STOP_WAIT_SECONDS: float = Field(2.0, ge=0.1)
    CHROMECAST_FALLBACK_SCAN_ENABLED: bool = True
    CHROMECAST_FALLBACK_SCAN_SUBNETS: str = "192.168.0.0/24,192.168.1.0/24,192.168.2.0/24,10.0.0.0/24,10.0.1.0/24,10.0.2.0/24"
    CHROMECAST_FALLBACK_SCAN_WORKERS: int = Field(96, ge=1, le=256)
    CHROMECAST_FALLBACK_SCAN_PROBE_TIMEOUT: float = Field(1.5, ge=0.05)
    CHROMECAST_FALLBACK_DEVICE_INFO_TIMEOUT: float = Field(3.0, ge=0.5)
    CHROMECAST_PERIODIC_SCAN_INTERVAL: int = Field(90, ge=10)

    # Per-endpoint cache durations
    SEARCH_CACHE_DURATION_SECONDS: int = Field(30, ge=1)
    AVATAR_CACHE_DURATION_SECONDS: int = Field(604800, ge=1)  # 7 days
    VIEWER_CACHE_DURATION_SECONDS: int = Field(30, ge=1)
    NEGATIVE_CACHE_DURATION_SECONDS: int = Field(10, ge=1)
    FEATURED_STALE_TTL_SECONDS: int = Field(300, ge=1)

    # Circuit breaker settings
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: int = Field(5, ge=1)
    CIRCUIT_BREAKER_RECOVERY_SECONDS: int = Field(30, ge=5)

    # CORS settings — set CORS_ORIGINS to a comma-separated list to enable
    CORS_ORIGINS: str = ""
    CORS_ALLOW_CREDENTIALS: bool = False

    # Security headers
    SECURITY_HEADERS_ENABLED: bool = True

    # Structured JSON logging (useful for production log aggregation)
    LOG_FORMAT_JSON: bool = False

    def to_dict(self) -> dict:
        return self.model_dump()


# Module-level singleton — import as `from config import Config`
Config = Settings()
