// Package config loads runtime settings from the environment, mirroring the
// fields and defaults of the Python pydantic-settings `Settings` class
// (config.py). Phase 0 uses pure stdlib parsing — no external dependency.
package config

import (
	"encoding/json"
	"os"
	"strconv"
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
	Debug         bool
	Port          int
	LogLevel      string
	LogFormatJSON bool

	// Kick API endpoints
	KickAPIBaseURL             string
	KickFeaturedLivestreamsURL string
	KickAllLivestreamsURL      string

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

	// HTTP / security
	CORSOrigins            string
	CORSAllowCredentials   bool
	SecurityHeadersEnabled bool
}

// Load reads configuration from the environment, applying the same defaults
// as the Python Settings class.
func Load() *Config {
	return &Config{
		Debug:         envBool("DEBUG", false),
		Port:          envInt("PORT", 8081),
		LogLevel:      envStr("LOG_LEVEL", "INFO"),
		LogFormatJSON: envBool("LOG_FORMAT_JSON", false),

		KickAPIBaseURL:             envStr("KICK_API_BASE_URL", "https://kick.com/api/v2/channels/"),
		KickFeaturedLivestreamsURL: envStr("KICK_FEATURED_LIVESTREAMS_URL", "https://kick.com/stream/featured-livestreams/"),
		KickAllLivestreamsURL:      envStr("KICK_ALL_LIVESTREAMS_URL", "https://kick.com/stream/livestreams/"),

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

		CORSOrigins:            envStr("CORS_ORIGINS", ""),
		CORSAllowCredentials:   envBool("CORS_ALLOW_CREDENTIALS", false),
		SecurityHeadersEnabled: envBool("SECURITY_HEADERS_ENABLED", true),
	}
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
