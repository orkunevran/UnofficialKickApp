package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"kickapi/internal/config"
	"kickapi/internal/kick"
)

// fakeKick is a configurable kickClient for offline route tests.
type fakeKick struct {
	channel     map[string]any
	channelErr  error
	calls       int
	clips       any
	videos      any
	featured    any
	search      []map[string]any
	viewers     int
	batch       map[int]int
	playlist    []byte
	playlistErr error
}

func (f *fakeKick) GetChannelData(slug string) (map[string]any, error) {
	f.calls++
	if f.channelErr != nil {
		return nil, f.channelErr
	}
	return f.channel, nil
}
func (f *fakeKick) GetChannelVideos(string) (any, error)                  { return f.videos, nil }
func (f *fakeKick) GetChannelClips(string) (any, error)                   { return f.clips, nil }
func (f *fakeKick) GetFeaturedLivestreams(string, int) (any, error)       { return f.featured, nil }
func (f *fakeKick) GetAllLivestreams(string, int, string, string, string, string, bool) (any, error) {
	return f.featured, nil
}
func (f *fakeKick) FetchPlaylist(string) ([]byte, error)             { return f.playlist, f.playlistErr }
func (f *fakeKick) GetViewerCount(int) (int, error)                  { return f.viewers, nil }
func (f *fakeKick) GetViewerCountsBatch([]int) (map[int]int, error)  { return f.batch, nil }
func (f *fakeKick) SearchChannelsTypesense(string) ([]map[string]any, error) { return f.search, nil }

func appWithKick(t *testing.T, fake *fakeKick) *App {
	t.Helper()
	app, err := New(config.Load(), slog.New(slog.NewTextHandler(io.Discard, nil)), os.DirFS("../.."))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	app.kick = fake
	return app
}

func getJSON(t *testing.T, app *App, path string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, req)
	var body map[string]any
	if rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
	}
	return rec.Code, body
}

func TestPlayStreamLive(t *testing.T) {
	fake := &fakeKick{channel: map[string]any{
		"user":         map[string]any{"username": "Alice", "profile_pic": "pic.jpg"},
		"playback_url": "https://ivs/playlist.m3u8",
		"livestream": map[string]any{
			"id": float64(42), "session_title": "Hi", "viewer_count": float64(99),
			"categories": []any{map[string]any{"name": "IRL"}},
		},
	}}
	app := appWithKick(t, fake)

	code, body := getJSON(t, app, "/streams/play/alice")
	if code != 200 {
		t.Fatalf("status = %d; want 200", code)
	}
	data := body["data"].(map[string]any)
	if data["status"] != "live" || data["playback_url"] != "/streams/m3u8/alice.m3u8" {
		t.Fatalf("unexpected live payload: %v", data)
	}
	if data["livestream_category"] != "IRL" || data["livestream_viewer_count"] != float64(99) {
		t.Fatalf("livestream fields wrong: %v", data)
	}

	// Second request must be served from cache (no extra upstream call).
	getJSON(t, app, "/streams/play/alice")
	if fake.calls != 1 {
		t.Fatalf("expected 1 upstream call (cache hit on 2nd), got %d", fake.calls)
	}
}

func TestPlayStreamOffline(t *testing.T) {
	fake := &fakeKick{channel: map[string]any{
		"user": map[string]any{"username": "Bob"},
		// no "livestream" key → offline
	}}
	code, body := getJSON(t, appWithKick(t, fake), "/streams/play/bob")
	if code != 200 {
		t.Fatalf("status = %d; want 200", code)
	}
	if body["data"].(map[string]any)["status"] != "offline" {
		t.Fatalf("expected offline, got %v", body["data"])
	}
}

func TestPlayStream404Mapping(t *testing.T) {
	fake := &fakeKick{channelErr: &kick.HTTPError{Status: 404}}
	code, body := getJSON(t, appWithKick(t, fake), "/streams/play/ghost")
	if code != 404 {
		t.Fatalf("status = %d; want 404", code)
	}
	if body["status"] != "error" || body["message"] != "Kick channel 'ghost' not found." {
		t.Fatalf("unexpected error envelope: %v", body)
	}
}

func TestInvalidSlug(t *testing.T) {
	code, _ := getJSON(t, appWithKick(t, &fakeKick{}), "/streams/play/bad!slug")
	if code != 400 {
		t.Fatalf("status = %d; want 400", code)
	}
}

func TestSearchValidation(t *testing.T) {
	app := appWithKick(t, &fakeKick{})
	if code, _ := getJSON(t, app, "/streams/search?q=a"); code != 400 {
		t.Fatalf("1-char query should be 400, got %d", code)
	}
}

func TestCircuitBreakerRejection(t *testing.T) {
	app := appWithKick(t, &fakeKick{channel: map[string]any{}})
	// Trip the critical breaker (threshold = CircuitBreakerCriticalFailureThreshold).
	for i := 0; i < app.cfg.CircuitBreakerCriticalFailureThreshold; i++ {
		app.cbCritical.RecordFailure()
	}
	code, body := getJSON(t, app, "/streams/play/alice")
	if code != 503 {
		t.Fatalf("open breaker should yield 503, got %d", code)
	}
	if body["message"] == "" {
		t.Fatal("expected error message on 503")
	}
}

func TestViewersBatch(t *testing.T) {
	fake := &fakeKick{batch: map[int]int{101: 5, 202: 9}}
	code, body := getJSON(t, appWithKick(t, fake), "/streams/viewers/batch?ids=202,101")
	if code != 200 {
		t.Fatalf("status = %d; want 200", code)
	}
	data := body["data"].(map[string]any)
	if data["101"] != float64(5) || data["202"] != float64(9) {
		t.Fatalf("unexpected batch data: %v", data)
	}
}
