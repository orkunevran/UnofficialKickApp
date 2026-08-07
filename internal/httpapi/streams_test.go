package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"kickapi/internal/config"
	"kickapi/internal/kick"
)

// fakeKick is a configurable kickClient for offline route tests.
type fakeKick struct {
	channel      map[string]any
	channelErr   error
	calls        atomic.Int64
	videoCalls   atomic.Int64
	chatCalls    atomic.Int64
	chatHistory  any
	chatErr      error
	chatAskedFor string
	clips        any
	videos       any
	featured     any
	search       []map[string]any
	viewers      int
	batch        map[int]int
	playlist     []byte
	playlistErr  error
	// playlists serves per-URL playlist bodies (the DVR proxy fetches several
	// distinct playlists); falls back to playlist when a URL isn't listed.
	playlists map[string][]byte
	// Recorded fetches. Guarded: the DVR proxy refreshes playlists from
	// background goroutines.
	playlistMu   sync.Mutex
	playlistURLs []string
}

func (f *fakeKick) GetChannelData(slug string) (map[string]any, error) {
	f.calls.Add(1)
	if f.channelErr != nil {
		return nil, f.channelErr
	}
	return f.channel, nil
}
func (f *fakeKick) GetChannelVideos(string) (any, error) {
	f.videoCalls.Add(1)
	return f.videos, nil
}

func (f *fakeKick) GetChannelClips(string) (any, error)             { return f.clips, nil }
func (f *fakeKick) GetFeaturedLivestreams(string, int) (any, error) { return f.featured, nil }
func (f *fakeKick) GetAllLivestreams(string, int, string, string, string, string, bool) (any, error) {
	return f.featured, nil
}
func (f *fakeKick) FetchPlaylist(playlistURL string) ([]byte, error) {
	f.playlistMu.Lock()
	f.playlistURLs = append(f.playlistURLs, playlistURL)
	f.playlistMu.Unlock()
	if body, ok := f.playlists[playlistURL]; ok {
		return body, nil
	}
	return f.playlist, f.playlistErr
}

// playlistFetches is how many times the upstream playlist endpoint was hit.
func (f *fakeKick) playlistFetches() int {
	f.playlistMu.Lock()
	defer f.playlistMu.Unlock()
	return len(f.playlistURLs)
}
func (f *fakeKick) GetViewerCount(int) (int, error)                          { return f.viewers, nil }
func (f *fakeKick) GetViewerCountsBatch([]int) (map[int]int, error)          { return f.batch, nil }
func (f *fakeKick) SearchChannelsTypesense(string) ([]map[string]any, error) { return f.search, nil }
func (f *fakeKick) GetChatHistory(channelID int, startTime string) (any, error) {
	f.chatCalls.Add(1)
	f.chatAskedFor = startTime
	return f.chatHistory, f.chatErr
}

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
	if fake.calls.Load() != 1 {
		t.Fatalf("expected 1 upstream call (cache hit on 2nd), got %d", fake.calls.Load())
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

func TestPlayClipProxiesAbsolutePlaylist(t *testing.T) {
	fake := &fakeKick{
		clips: map[string]any{
			"clips": map[string]any{
				"data": []any{
					map[string]any{
						"id":       "clip_abc",
						"clip_url": "https://clips.example/media/clip.m3u8?token=secret",
					},
				},
			},
		},
		playlist: []byte("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXT-X-BYTERANGE:1024@0\n#EXTINF:4,\n0.ts\n"),
	}
	app := appWithKick(t, fake)
	req := httptest.NewRequest(http.MethodGet, "/streams/clip/alice/clip_abc", nil)
	rec := httptest.NewRecorder()

	app.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/vnd.apple.mpegurl" {
		t.Fatalf("content type = %q", got)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `URI="https://clips.example/media/key.bin"`) {
		t.Fatalf("key URI was not made absolute: %s", body)
	}
	if !strings.Contains(body, "https://clips.example/media/0.ts") {
		t.Fatalf("segment URI was not made absolute: %s", body)
	}
	if !strings.Contains(body, "#EXTINF:4,\n#EXT-X-BYTERANGE:1024@0\n") {
		t.Fatalf("byterange tag was not normalised after EXTINF: %s", body)
	}
}

func TestPlayClipNotFound(t *testing.T) {
	fake := &fakeKick{clips: map[string]any{"clips": []any{}}}
	code, body := getJSON(t, appWithKick(t, fake), "/streams/clip/alice/missing")
	if code != http.StatusNotFound {
		t.Fatalf("status = %d; want 404", code)
	}
	if body["status"] != "error" || body["message"] != "Clip not found." {
		t.Fatalf("unexpected error envelope: %v", body)
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

func TestNegativeCache404Replays(t *testing.T) {
	fake := &fakeKick{channelErr: &kick.HTTPError{Status: 404}}
	app := appWithKick(t, fake)

	// First request fetches and 404s.
	if code, _ := getJSON(t, app, "/streams/play/ghost"); code != 404 {
		t.Fatalf("first call status = %d; want 404", code)
	}
	// Second request must be served from the negative cache (no extra fetch).
	code, body := getJSON(t, app, "/streams/play/ghost")
	if code != 404 {
		t.Fatalf("second call status = %d; want 404 (from negative cache)", code)
	}
	if body["status"] != "error" {
		t.Fatalf("negative-cached body should be an error envelope: %v", body)
	}
	if fake.calls.Load() != 1 {
		t.Fatalf("expected 1 upstream call (404 negative-cached), got %d", fake.calls.Load())
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
