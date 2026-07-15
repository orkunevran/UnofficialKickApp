// Package config loads runtime settings from the environment, mirroring the
// fields and defaults of the Python pydantic-settings `Settings` class
// (config.py). Phase 0 uses pure stdlib parsing — no external dependency.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Language is one selectable featured-content language (matches the
// {"code", "name"} dicts in FEATURED_LANGUAGES).
type Language struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

// Config is the parsed application configuration. Field names mirror the
// env var names from config.py (CamelCased); env keys are preserved verbatim.
type Config struct {
	// Application
	Debug                      bool
	Port                       int
	LogLevel                   string
	LogFormatJSON              bool
	ControlToken               string
	MaxJSONBodyBytes           int
	RateLimitRequestsPerSecond float64
	RateLimitBurst             int

	// Kick API endpoints
	KickAPIBaseURL             string
	KickFeaturedLivestreamsURL string
	KickAllLivestreamsURL      string
	KickMaxResponseBytes       int
	KickMaxPlaylistBytes       int

	// Cache
	CacheMaxSize                 int
	LiveCacheDurationSeconds     int
	LiveStaleTTLSeconds          int
	VODCacheDurationSeconds      int
	FeaturedCacheDurationSeconds int
	SearchCacheDurationSeconds   int
	AvatarCacheDurationSeconds   int
	ViewerCacheDurationSeconds   int
	NegativeCacheDurationSeconds int
	FeaturedStaleTTLSeconds      int

	// Languages
	FeaturedLanguages   []Language
	DefaultLanguageCode string

	LiveInflightWaitTimeoutSeconds float64

	// Concurrency
	BackgroundRefreshMaxConcurrency        int
	BackgroundRefreshAcquireTimeoutSeconds float64

	// Circuit breaker
	CircuitBreakerFailureThreshold         int
	CircuitBreakerCriticalFailureThreshold int
	CircuitBreakerRecoverySeconds          int
	RefreshBackoffSeconds                  int

	// Chromecast
	ChromecastScanTimeout               int
	ChromecastSelectMaxRetries          int
	ChromecastSelectRetryDelay          int
	ChromecastDeviceCacheSeconds        int
	ChromecastPeriodicScanInterval      int
	ChromecastFallbackScanEnabled       bool
	ChromecastFallbackScanSubnets       string
	ChromecastFallbackScanWorkers       int
	ChromecastFallbackScanProbeTimeout  float64
	ChromecastFallbackDeviceInfoTimeout float64
	ChromecastStatusUpdateTimeout       float64
	ChromecastConnectCooldown           float64
	ChromecastStatePath                 string

	// HTTP / security
	CORSOrigins            string
	CORSAllowCredentials   bool
	SecurityHeadersEnabled bool
}

// Load reads configuration from the environment, applying the same defaults
// as the Python Settings class.
func Load() *Config {
	return &Config{
		Debug:                      envBool("DEBUG", false),
		Port:                       envInt("PORT", 8081),
		LogLevel:                   envStr("LOG_LEVEL", "INFO"),
		LogFormatJSON:              envBool("LOG_FORMAT_JSON", false),
		ControlToken:               envStr("CONTROL_TOKEN", ""),
		MaxJSONBodyBytes:           envInt("MAX_JSON_BODY_BYTES", 16384),
		RateLimitRequestsPerSecond: envFloat("RATE_LIMIT_REQUESTS_PER_SECOND", 50),
		RateLimitBurst:             envInt("RATE_LIMIT_BURST", 100),

		KickAPIBaseURL:             envStr("KICK_API_BASE_URL", "https://kick.com/api/v2/channels/"),
		KickFeaturedLivestreamsURL: envStr("KICK_FEATURED_LIVESTREAMS_URL", "https://kick.com/stream/featured-livestreams/"),
		KickAllLivestreamsURL:      envStr("KICK_ALL_LIVESTREAMS_URL", "https://kick.com/stream/livestreams/"),
		KickMaxResponseBytes:       envInt("KICK_MAX_RESPONSE_BYTES", 4*1024*1024),
		KickMaxPlaylistBytes:       envInt("KICK_MAX_PLAYLIST_BYTES", 1024*1024),

		CacheMaxSize:                 envInt("CACHE_MAX_SIZE", 2000),
		LiveCacheDurationSeconds:     envInt("LIVE_CACHE_DURATION_SECONDS", 60),
		LiveStaleTTLSeconds:          envInt("LIVE_STALE_TTL_SECONDS", 120),
		VODCacheDurationSeconds:      envInt("VOD_CACHE_DURATION_SECONDS", 300),
		FeaturedCacheDurationSeconds: envInt("FEATURED_CACHE_DURATION_SECONDS", 120),
		SearchCacheDurationSeconds:   envInt("SEARCH_CACHE_DURATION_SECONDS", 30),
		AvatarCacheDurationSeconds:   envInt("AVATAR_CACHE_DURATION_SECONDS", 604800),
		ViewerCacheDurationSeconds:   envInt("VIEWER_CACHE_DURATION_SECONDS", 30),
		NegativeCacheDurationSeconds: envInt("NEGATIVE_CACHE_DURATION_SECONDS", 10),
		FeaturedStaleTTLSeconds:      envInt("FEATURED_STALE_TTL_SECONDS", 3600),

		LiveInflightWaitTimeoutSeconds: envFloat("LIVE_INFLIGHT_WAIT_TIMEOUT_SECONDS", 5.0),

		FeaturedLanguages:   envLanguages("FEATURED_LANGUAGES", defaultLanguages()),
		DefaultLanguageCode: envStr("DEFAULT_LANGUAGE_CODE", "en"),

		BackgroundRefreshMaxConcurrency:        envInt("BACKGROUND_REFRESH_MAX_CONCURRENCY", 4),
		BackgroundRefreshAcquireTimeoutSeconds: envFloat("BACKGROUND_REFRESH_ACQUIRE_TIMEOUT_SECONDS", 0.05),

		CircuitBreakerFailureThreshold:         envInt("CIRCUIT_BREAKER_FAILURE_THRESHOLD", 5),
		CircuitBreakerCriticalFailureThreshold: envInt("CIRCUIT_BREAKER_CRITICAL_FAILURE_THRESHOLD", 8),
		CircuitBreakerRecoverySeconds:          envInt("CIRCUIT_BREAKER_RECOVERY_SECONDS", 30),
		RefreshBackoffSeconds:                  envInt("REFRESH_BACKOFF_SECONDS", 5),

		ChromecastScanTimeout:               envInt("CHROMECAST_SCAN_TIMEOUT", 5),
		ChromecastSelectMaxRetries:          envInt("CHROMECAST_SELECT_MAX_RETRIES", 2),
		ChromecastSelectRetryDelay:          envInt("CHROMECAST_SELECT_RETRY_DELAY", 2),
		ChromecastDeviceCacheSeconds:        envInt("CHROMECAST_DEVICE_CACHE_SECONDS", 30),
		ChromecastPeriodicScanInterval:      envInt("CHROMECAST_PERIODIC_SCAN_INTERVAL", 90),
		ChromecastFallbackScanEnabled:       envBool("CHROMECAST_FALLBACK_SCAN_ENABLED", true),
		ChromecastFallbackScanSubnets:       envStr("CHROMECAST_FALLBACK_SCAN_SUBNETS", "192.168.0.0/24,192.168.1.0/24,192.168.2.0/24,10.0.0.0/24,10.0.1.0/24,10.0.2.0/24"),
		ChromecastFallbackScanWorkers:       envInt("CHROMECAST_FALLBACK_SCAN_WORKERS", 96),
		ChromecastFallbackScanProbeTimeout:  envFloat("CHROMECAST_FALLBACK_SCAN_PROBE_TIMEOUT", 1.5),
		ChromecastFallbackDeviceInfoTimeout: envFloat("CHROMECAST_FALLBACK_DEVICE_INFO_TIMEOUT", 3.0),
		ChromecastStatusUpdateTimeout:       envFloat("CHROMECAST_STATUS_UPDATE_TIMEOUT", 8.0),
		ChromecastConnectCooldown:           envFloat("CHROMECAST_CONNECT_COOLDOWN", 20.0),
		ChromecastStatePath:                 envStr("CHROMECAST_STATE_PATH", ".kick_chromecast_cache.json"),

		CORSOrigins:            envStr("CORS_ORIGINS", ""),
		CORSAllowCredentials:   envBool("CORS_ALLOW_CREDENTIALS", false),
		SecurityHeadersEnabled: envBool("SECURITY_HEADERS_ENABLED", true),
	}
}

// Validate rejects unsafe or nonsensical production configuration instead of
// silently starting with values that make caches, timeouts, or listeners
// ineffective. CONTROL_TOKEN remains optional for local development; the Pi
// deployment provisions it in the service EnvironmentFile.
func (c *Config) Validate() error {
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("PORT must be between 1 and 65535")
	}
	if c.CacheMaxSize < 1 {
		return fmt.Errorf("CACHE_MAX_SIZE must be positive")
	}
	if c.MaxJSONBodyBytes < 1024 || c.KickMaxResponseBytes < 1024 || c.KickMaxPlaylistBytes < 1024 {
		return fmt.Errorf("I/O byte limits must be at least 1024")
	}
	if c.BackgroundRefreshMaxConcurrency < 1 || c.ChromecastFallbackScanWorkers < 1 || c.RateLimitBurst < 1 {
		return fmt.Errorf("concurrency limits must be positive")
	}
	if c.RateLimitRequestsPerSecond <= 0 {
		return fmt.Errorf("RATE_LIMIT_REQUESTS_PER_SECOND must be positive")
	}
	if c.LiveCacheDurationSeconds < 1 || c.LiveStaleTTLSeconds < c.LiveCacheDurationSeconds ||
		c.FeaturedCacheDurationSeconds < 1 || c.FeaturedStaleTTLSeconds < c.FeaturedCacheDurationSeconds ||
		c.VODCacheDurationSeconds < 1 || c.SearchCacheDurationSeconds < 1 ||
		c.AvatarCacheDurationSeconds < 1 || c.ViewerCacheDurationSeconds < 1 ||
		c.NegativeCacheDurationSeconds < 1 {
		return fmt.Errorf("cache TTLs must be positive and stale TTLs must not be shorter than fresh TTLs")
	}
	if c.LiveInflightWaitTimeoutSeconds <= 0 || c.BackgroundRefreshAcquireTimeoutSeconds < 0 ||
		c.ChromecastStatusUpdateTimeout <= 0 || c.ChromecastConnectCooldown < 0 {
		return fmt.Errorf("timeouts must be positive (connect cooldown may be zero)")
	}
	if strings.TrimSpace(c.ChromecastStatePath) == "" {
		return fmt.Errorf("CHROMECAST_STATE_PATH must not be empty")
	}
	foundDefault := false
	for _, lang := range c.FeaturedLanguages {
		if strings.TrimSpace(lang.Code) == "" || strings.TrimSpace(lang.Name) == "" {
			return fmt.Errorf("FEATURED_LANGUAGES entries require code and name")
		}
		if lang.Code == c.DefaultLanguageCode {
			foundDefault = true
		}
	}
	if !foundDefault {
		return fmt.Errorf("DEFAULT_LANGUAGE_CODE must exist in FEATURED_LANGUAGES")
	}
	return nil
}

func defaultLanguages() []Language {
	return []Language{
		{Code: "en", Name: "English"},
		{Code: "tr", Name: "Turkish"},
		{Code: "es", Name: "Spanish"},
		{Code: "de", Name: "German"},
		{Code: "fr", Name: "French"},
		{Code: "ru", Name: "Russian"},
	}
}

// ── env helpers ───────────────────────────────────────────────────────

func envStr(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envBool(key string, def bool) bool {
	if v, ok := os.LookupEnv(key); ok {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v, ok := os.LookupEnv(key); ok {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

// envLanguages parses a JSON array of {code,name} objects from the env, or
// returns the provided default when unset/invalid.
func envLanguages(key string, def []Language) []Language {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return def
	}
	var langs []Language
	if err := json.Unmarshal([]byte(v), &langs); err != nil || len(langs) == 0 {
		return def
	}
	return langs
}
