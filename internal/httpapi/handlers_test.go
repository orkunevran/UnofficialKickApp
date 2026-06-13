package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"kickapi/internal/config"
)

// newTestApp builds an App backed by the real repo static/ and templates/
// (two levels up from this package), with a discard logger.
func newTestApp(t *testing.T) *App {
	t.Helper()
	cfg := config.Load()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	app, err := New(cfg, log, os.DirFS("../.."))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return app
}

func doGet(t *testing.T, app *App, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, req)
	return rec
}

func TestLanguagesEndpoint(t *testing.T) {
	rec := doGet(t, newTestApp(t), "/config/languages")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; want 200", rec.Code)
	}
	var body struct {
		Languages       []config.Language `json:"languages"`
		DefaultLanguage string            `json:"default_language"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.DefaultLanguage != "tr" {
		t.Fatalf("default_language = %q; want tr", body.DefaultLanguage)
	}
	if len(body.Languages) != 6 {
		t.Fatalf("languages count = %d; want 6", len(body.Languages))
	}
}

func TestHealthEndpoint(t *testing.T) {
	rec := doGet(t, newTestApp(t), "/health")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; want 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["status"] != "healthy" {
		t.Fatalf("status = %v; want healthy", body["status"])
	}
	if _, ok := body["components"]; !ok {
		t.Fatal("missing components")
	}
}

func TestLivenessEndpoint(t *testing.T) {
	rec := doGet(t, newTestApp(t), "/health/live")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok"`) {
		t.Fatalf("liveness = %d %s", rec.Code, rec.Body.String())
	}
}

func TestMetricsEndpoint(t *testing.T) {
	rec := doGet(t, newTestApp(t), "/metrics")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; want 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, key := range []string{"cache", "upstream", "inflight", "uptime_seconds"} {
		if _, ok := body[key]; !ok {
			t.Fatalf("metrics missing %q", key)
		}
	}
	upstream := body["upstream"].(map[string]any)
	if upstream["call_count"].(float64) != 0 {
		t.Fatalf("call_count = %v; want 0", upstream["call_count"])
	}
}

func TestIndexRendersJinja(t *testing.T) {
	rec := doGet(t, newTestApp(t), "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("content-type = %q", ct)
	}
	body := rec.Body.String()
	if strings.Contains(body, "url_for") || strings.Contains(body, "{% for") {
		t.Fatal("index still contains unrendered Jinja constructs")
	}
	if !strings.Contains(body, "/static/style.css?h=") {
		t.Fatal("index missing hash-busted style.css URL")
	}
}

func TestUnknownPath404(t *testing.T) {
	rec := doGet(t, newTestApp(t), "/no-such-route")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown path status = %d; want 404", rec.Code)
	}
}

func TestRequestIDHeader(t *testing.T) {
	rec := doGet(t, newTestApp(t), "/health/live")
	if rec.Header().Get("X-Request-ID") == "" {
		t.Fatal("missing X-Request-ID header")
	}
}

func TestSecurityHeaders(t *testing.T) {
	rec := doGet(t, newTestApp(t), "/health/live")
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("missing security header X-Content-Type-Options")
	}
}
