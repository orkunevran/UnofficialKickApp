package httpapi

// parity_test.go is the Go analogue of tests/test_fastapi_parity.py.
// It runs the same contract assertions (status codes + exact JSON envelopes)
// against the Go handler using an in-process fake Kick client and fake
// Chromecast service, so it exercises the same surface area without a live
// network or a running Python server.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"kickapi/internal/config"
)

// ── fake Chromecast service ────────────────────────────────────────────────

type fakeChromecast struct {
	devices    []map[string]any
	status     map[string]any
	lastDevice map[string]any
}

func (f *fakeChromecast) ScanAsync(bool, []string) bool { return false }
func (f *fakeChromecast) IsScanning() bool              { return false }
func (f *fakeChromecast) GetDevices() []map[string]any  { return f.devices }
func (f *fakeChromecast) SelectDevice(uuid string, _ time.Duration) (bool, string) {
	return true, ""
}
func (f *fakeChromecast) CastStream(string, string) bool { return true }
func (f *fakeChromecast) StopCast(string) bool           { return true }
func (f *fakeChromecast) GetLastDevice() map[string]any  { return f.lastDevice }
func (f *fakeChromecast) GetStatus() map[string]any      { return f.status }
func (f *fakeChromecast) Subscribe() (<-chan map[string]any, func()) {
	ch := make(chan map[string]any)
	return ch, func() { close(ch) }
}
func (f *fakeChromecast) PauseMedia() bool       { return true }
func (f *fakeChromecast) PlayMedia() bool        { return true }
func (f *fakeChromecast) SetVolume(float64) bool { return true }
func (f *fakeChromecast) SeekMedia(float64) bool { return true }

// ── sample data (mirrors tests/conftest.py sample_api_data) ──────────────

var (
	sampleLiveChannel = map[string]any{
		"user": map[string]any{
			"username":    "live-user",
			"profile_pic": "https://img.example/live.png",
			"bio":         "Live bio",
			"instagram":   "live_insta",
			"twitter":     "live_twitter",
			"youtube":     "live_youtube",
			"discord":     "live_discord",
			"tiktok":      "live_tiktok",
		},
		"banner_image":         map[string]any{"url": "https://img.example/banner.png"},
		"followers_count":      float64(4242),
		"verified":             true,
		"subscription_enabled": true,
		"recent_categories":    []any{map[string]any{"name": "Just Chatting"}, map[string]any{"name": "Gaming"}},
		"livestream": map[string]any{
			"id":            float64(9876),
			"thumbnail":     map[string]any{"src": "https://img.example/thumb.png"},
			"categories":    []any{map[string]any{"name": "Just Chatting"}},
			"session_title": "Live Session",
			"viewer_count":  float64(321),
		},
		"playback_url": "https://cdn.example/live-user/master.m3u8",
	}

	sampleOfflineChannel = map[string]any{
		"user": map[string]any{
			"username":    "live-user",
			"profile_pic": "https://img.example/live.png",
			"bio":         "Live bio",
			"instagram":   "live_insta",
			"twitter":     "live_twitter",
			"youtube":     "live_youtube",
			"discord":     "live_discord",
			"tiktok":      "live_tiktok",
		},
		"banner_image":         map[string]any{"url": "https://img.example/banner.png"},
		"followers_count":      float64(4242),
		"verified":             true,
		"subscription_enabled": true,
		"recent_categories":    []any{map[string]any{"name": "Just Chatting"}, map[string]any{"name": "Gaming"}},
		"livestream":           nil,
		"playback_url":         nil,
	}

	sampleVODs = []any{
		map[string]any{
			"id":            float64(42),
			"video":         map[string]any{"uuid": "vod-uuid-42", "views": float64(1337)},
			"session_title": "VOD 42",
			"source":        "https://cdn.example/vod-42.m3u8",
			"thumbnail":     map[string]any{"src": "https://img.example/vod-42.png"},
			"duration":      float64(3600000),
			"created_at":    "2026-01-01T00:00:00Z",
			"language":      "en",
			"is_mature":     false,
		},
	}

	sampleFeaturedStream = map[string]any{
		"session_title": "Featured Live",
		"channel":       map[string]any{"user": map[string]any{"username": "live-user"}},
		"viewer_count":  float64(99),
		"categories":    []any{map[string]any{"name": "Just Chatting"}},
	}

	sampleClipsRaw = map[string]any{
		"clips": map[string]any{
			"data": []any{
				map[string]any{
					"id":            float64(7),
					"title":         "Highlight",
					"clip_url":      "https://cdn.example/clip-7",
					"thumbnail_url": "https://img.example/clip-7.png",
					"duration":      float64(12),
					"views":         float64(123),
					"category":      map[string]any{"name": "Just Chatting"},
					"created_at":    "2026-02-01T00:00:00Z",
					"channel":       map[string]any{"slug": "live-user"},
				},
			},
		},
	}

	sampleSearchResults = []map[string]any{
		{"slug": "live-user", "username": "live-user", "followers_count": float64(4242), "is_live": true, "verified": true, "profile_picture": nil},
		{"slug": "offline-user", "username": "offline-user", "followers_count": float64(1111), "is_live": false, "verified": false, "profile_picture": nil},
	}

	sampleDevices = []map[string]any{
		{"name": "Living Room TV", "uuid": "device-1"},
	}

	sampleCCStatus = map[string]any{
		"status":      "connected",
		"device_name": "Living Room TV",
		"is_playing":  true,
	}

	sampleLastDevice = map[string]any{
		"uuid": "device-1",
		"name": "Living Room TV",
	}
)

// ── test app builder ──────────────────────────────────────────────────────

func newParityApp(t *testing.T) *App {
	t.Helper()
	cfg := config.Load()
	cfg.RateLimitRequestsPerSecond = 1_000_000
	cfg.RateLimitBurst = 1_000_000
	app, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), os.DirFS("../.."))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	app.kick = &fakeKick{
		channel: sampleLiveChannel,
		clips:   sampleClipsRaw,
		videos:  sampleVODs,
		featured: map[string]any{
			"data":          []any{sampleFeaturedStream},
			"current_page":  float64(2),
			"per_page":      float64(14),
			"next_page_url": nil,
			"prev_page_url": "/prev",
		},
		search:   sampleSearchResults,
		viewers:  777,
		batch:    map[int]int{9876: 9976, 42: 142},
		playlist: []byte("#EXTM3U\n#EXT-X-VERSION:3\n..."),
	}
	app.chromecast = &fakeChromecast{
		devices:    sampleDevices,
		status:     sampleCCStatus,
		lastDevice: sampleLastDevice,
	}
	return app
}

// doReq fires a request and returns (statusCode, body-bytes).
func doReq(app *App, method, path string, body []byte) *httptest.ResponseRecorder {
	var reqBody io.Reader
	if body != nil {
		reqBody = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reqBody)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, req)
	return rec
}

func decodeJSON(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("decode JSON: %v\nbody: %s", err, b)
	}
	return m
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// ── expected responses (mirrors test_fastapi_parity.py _expected_response) ─

func parityExpected(path string) map[string]any {
	channelProfile := map[string]any{
		"channel_slug":         "live-user",
		"username":             "live-user",
		"profile_picture":      "https://img.example/live.png",
		"banner_image_url":     "https://img.example/banner.png",
		"bio":                  "Live bio",
		"followers_count":      float64(4242),
		"verified":             true,
		"subscription_enabled": true,
		"social_links":         map[string]any{"instagram": "live_insta", "twitter": "live_twitter", "youtube": "live_youtube", "discord": "live_discord", "tiktok": "live_tiktok"},
		"recent_categories":    []any{"Just Chatting", "Gaming"},
	}

	switch path {
	case "/streams/play/live-user":
		data := copyMap(channelProfile)
		data["status"] = "live"
		data["playback_url"] = "/streams/m3u8/live-user.m3u8"
		data["livestream_id"] = float64(9876)
		data["livestream_thumbnail_url"] = "https://img.example/thumb.png"
		data["livestream_title"] = "Live Session"
		data["livestream_viewer_count"] = float64(321)
		data["livestream_category"] = "Just Chatting"
		return env("success", "", data)

	case "/streams/play/offline-user":
		// offline channel uses the same user data as live_channel in sample
		data := copyMap(channelProfile)
		data["status"] = "offline"
		return env("success", "", data)

	case "/streams/vods/live-user":
		return env("success", "", map[string]any{
			"vods": []any{
				map[string]any{
					"vod_id":           float64(42),
					"video_uuid":       "vod-uuid-42",
					"title":            "VOD 42",
					"source_url":       "https://cdn.example/vod-42.m3u8",
					"thumbnail_url":    "https://img.example/vod-42.png",
					"views":            float64(1337),
					"duration_seconds": float64(3600),
					"created_at":       "2026-01-01T00:00:00Z",
					"language":         "en",
					"is_mature":        false,
				},
			},
		})

	case "/streams/featured-livestreams":
		return map[string]any{
			"status":  "success",
			"message": "",
			"data":    []any{sampleFeaturedStream},
			"pagination": map[string]any{
				"current_page": float64(2),
				"per_page":     float64(14),
				"has_next":     false,
				"has_prev":     true,
			},
		}

	case "/streams/clips/live-user":
		return env("success", "", map[string]any{
			"clips": []any{
				map[string]any{
					"clip_id":          float64(7),
					"title":            "Highlight",
					"clip_url":         "https://cdn.example/clip-7",
					"thumbnail_url":    "https://img.example/clip-7.png",
					"duration_seconds": float64(12),
					"views":            float64(123),
					"category_name":    "Just Chatting",
					"created_at":       "2026-02-01T00:00:00Z",
					"channel_slug":     "live-user",
				},
			},
		})

	case "/streams/search":
		return env("success", "", sampleSearchResults)

	case "/streams/avatar/live-user":
		return env("success", "", map[string]any{
			"profile_picture": "https://img.example/live.png",
		})

	case "/streams/viewers":
		return env("success", "", map[string]any{"viewer_count": float64(777)})

	case "/streams/viewers/batch":
		return env("success", "", map[string]any{"42": float64(142), "9876": float64(9976)})

	case "/api/chromecast/devices":
		return env("success", "", map[string]any{
			"devices":  sampleDevices,
			"scanning": false,
		})

	case "/api/chromecast/status":
		return env("success", "", sampleCCStatus)

	case "/api/chromecast/last-device":
		return env("success", "", map[string]any{"device": sampleLastDevice})

	case "/api/chromecast/select":
		return env("success", "Device device-1 selected.", map[string]any{})

	case "/api/chromecast/cast":
		return env("success", "Casting started.", map[string]any{})

	case "/api/chromecast/stop":
		return env("success", "Cast stopped.", map[string]any{})
	}

	panic(fmt.Sprintf("no expected response defined for %s", path))
}

func env(status, message string, data any) map[string]any {
	return map[string]any{"status": status, "message": message, "data": data}
}

func copyMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// ── parity: happy path ────────────────────────────────────────────────────

func TestParityHappyPath(t *testing.T) {
	app := newParityApp(t)

	type tc struct {
		method string
		path   string
		body   []byte
	}
	cases := []tc{
		{"GET", "/streams/play/live-user", nil},
		// offline-user is covered by TestParityOfflineChannel (needs a separate fake)
		{"GET", "/streams/vods/live-user", nil},
		{"GET", "/streams/featured-livestreams?language=en&page=2", nil},
		{"GET", "/streams/clips/live-user", nil},
		{"GET", "/streams/search?q=kick", nil},
		{"GET", "/streams/avatar/live-user", nil},
		{"GET", "/streams/viewers?id=123", nil},
		{"GET", "/streams/viewers/batch?ids=9876,42", nil},
		{"GET", "/api/chromecast/devices", nil},
		{"GET", "/api/chromecast/devices?known_hosts=192.168.1.10", nil},
		{"GET", "/api/chromecast/status", nil},
		{"GET", "/api/chromecast/last-device", nil},
		{"POST", "/api/chromecast/select", mustJSON(map[string]any{"uuid": "device-1"})},
		{"POST", "/api/chromecast/cast", mustJSON(map[string]any{"stream_url": "https://cdn.example/live-user/master.m3u8", "title": "Kick Stream"})},
		{"POST", "/api/chromecast/stop", mustJSON(map[string]any{"uuid": "device-1"})},
	}

	for _, c := range cases {
		c := c
		// Normalise path to the base path for the expected-response lookup.
		basePath := strings.SplitN(c.path, "?", 2)[0]
		t.Run(c.method+"_"+basePath, func(t *testing.T) {
			rec := doReq(app, c.method, c.path, c.body)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d; want 200\nbody: %s", rec.Code, rec.Body.String())
			}
			got := decodeJSON(t, rec.Body.Bytes())
			want := parityExpected(basePath)
			if diff := jsonDiff(want, got); diff != "" {
				t.Fatalf("response mismatch:\n%s", diff)
			}
		})
	}
}

// ── parity: redirects ─────────────────────────────────────────────────────

func TestParityRedirects(t *testing.T) {
	app := newParityApp(t)

	t.Run("go_to_live", func(t *testing.T) {
		rec := doReq(app, "GET", "/streams/go/live-user", nil)
		if rec.Code != http.StatusTemporaryRedirect {
			t.Fatalf("status = %d; want 307", rec.Code)
		}
		if loc := rec.Header().Get("Location"); loc != "/streams/m3u8/live-user.m3u8" {
			t.Fatalf("Location = %q; want /streams/m3u8/live-user.m3u8", loc)
		}
	})

	t.Run("play_vod", func(t *testing.T) {
		rec := doReq(app, "GET", "/streams/vods/live-user/42", nil)
		if rec.Code != http.StatusTemporaryRedirect {
			t.Fatalf("status = %d; want 307", rec.Code)
		}
		if loc := rec.Header().Get("Location"); loc != "https://cdn.example/vod-42.m3u8" {
			t.Fatalf("Location = %q; want https://cdn.example/vod-42.m3u8", loc)
		}
	})
}

// ── parity: m3u8 proxy ────────────────────────────────────────────────────

func TestParityM3U8Proxy(t *testing.T) {
	app := newParityApp(t)
	rec := doReq(app, "GET", "/streams/m3u8/live-user.m3u8", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; want 200\nbody: %s", rec.Code, rec.Body.String())
	}
	ct := rec.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "application/vnd.apple.mpegurl") {
		t.Fatalf("Content-Type = %q; want application/vnd.apple.mpegurl", ct)
	}
	if body := rec.Body.String(); body != "#EXTM3U\n#EXT-X-VERSION:3\n..." {
		t.Fatalf("body = %q; want M3U8 content", body)
	}
}

// ── parity: validation errors ─────────────────────────────────────────────

func TestParityValidationErrors(t *testing.T) {
	app := newParityApp(t)

	type tc struct {
		method     string
		path       string
		body       []byte
		wantStatus int
		wantMsg    string
	}
	cases := []tc{
		{"GET", "/streams/play/bad%20slug", nil, 400, "Invalid channel slug: 'bad slug'."},
		{"GET", "/streams/search?q=a", nil, 400, "Query must be at least 2 characters."},
		{"GET", "/streams/viewers?id=abc", nil, 400, "Missing or invalid livestream ID."},
		{"POST", "/api/chromecast/select", mustJSON(map[string]any{}), 400, "Device UUID is required."},
		{"POST", "/api/chromecast/cast", mustJSON(map[string]any{}), 400, "Stream URL is required."},
		{"GET", "/streams/viewers/batch?ids=abc", nil, 400, "Invalid ID list."},
		{"GET", "/streams/viewers/batch?ids=", nil, 400, "Missing livestream IDs."},
	}

	for _, c := range cases {
		c := c
		t.Run(c.method+"_"+c.path, func(t *testing.T) {
			rec := doReq(app, c.method, c.path, c.body)
			if rec.Code != c.wantStatus {
				t.Fatalf("status = %d; want %d\nbody: %s", rec.Code, c.wantStatus, rec.Body.String())
			}
			body := decodeJSON(t, rec.Body.Bytes())
			if body["status"] != "error" {
				t.Fatalf("status field = %v; want error", body["status"])
			}
			if body["message"] != c.wantMsg {
				t.Fatalf("message = %q; want %q", body["message"], c.wantMsg)
			}
		})
	}
}

// ── parity: offline-user play (separate fake) ──────────────────────────────

func TestParityOfflineChannel(t *testing.T) {
	app := newParityApp(t)
	app.kick = &fakeKick{channel: sampleOfflineChannel}

	rec := doReq(app, "GET", "/streams/play/offline-user", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; want 200", rec.Code)
	}
	body := decodeJSON(t, rec.Body.Bytes())
	data := body["data"].(map[string]any)
	if data["status"] != "offline" {
		t.Fatalf("data.status = %v; want offline", data["status"])
	}
}

// ── helpers ───────────────────────────────────────────────────────────────

// jsonDiff returns a human-readable diff by round-tripping both maps through
// JSON (normalises float types) and comparing the canonical representations.
func jsonDiff(want, got map[string]any) string {
	w, _ := json.MarshalIndent(normalise(want), "", "  ")
	g, _ := json.MarshalIndent(normalise(got), "", "  ")
	ws, gs := string(w), string(g)
	if ws == gs {
		return ""
	}
	// Simple line-by-line diff output.
	var sb strings.Builder
	wl := strings.Split(ws, "\n")
	gl := strings.Split(gs, "\n")
	maxLen := len(wl)
	if len(gl) > maxLen {
		maxLen = len(gl)
	}
	for i := 0; i < maxLen; i++ {
		wline, gline := "", ""
		if i < len(wl) {
			wline = wl[i]
		}
		if i < len(gl) {
			gline = gl[i]
		}
		if wline != gline {
			fmt.Fprintf(&sb, "want: %s\n got: %s\n", wline, gline)
		}
	}
	return sb.String()
}

// normalise round-trips a value through JSON so that typed slices/structs
// and map[string]any land in the same representation for comparison.
func normalise(v any) any {
	b, _ := json.Marshal(v)
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}
