package config

import "testing"

func TestValidate(t *testing.T) {
	cfg := Load()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("defaults should validate: %v", err)
	}

	t.Run("port", func(t *testing.T) {
		bad := *cfg
		bad.Port = 70000
		if err := bad.Validate(); err == nil {
			t.Fatal("invalid port should fail")
		}
	})

	t.Run("stale TTL", func(t *testing.T) {
		bad := *cfg
		bad.LiveStaleTTLSeconds = bad.LiveCacheDurationSeconds - 1
		if err := bad.Validate(); err == nil {
			t.Fatal("stale TTL shorter than fresh TTL should fail")
		}
	})

	t.Run("default language", func(t *testing.T) {
		bad := *cfg
		bad.DefaultLanguageCode = "missing"
		if err := bad.Validate(); err == nil {
			t.Fatal("unknown default language should fail")
		}
	})
}
