package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestSSEStreamWorksThroughMiddleware guards the round-2 bug where the SSE
// endpoint returned 500 "Streaming unsupported" through the real middleware
// chain: statusRecorder didn't forward Flush(), so it failed the handler's
// w.(http.Flusher) assertion. The earlier shutdown test missed this because it
// calls the handler directly with a ResponseRecorder, bypassing the middleware.
// This one drives SSE through the full Handler() (gzip + requestContext + mux).
func TestSSEStreamWorksThroughMiddleware(t *testing.T) {
	srv := httptest.NewServer(newParityApp(t).Handler())
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/chromecast/status/stream", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET status stream: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d; want 200 (SSE broke through the middleware chain)", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q; want text/event-stream", ct)
	}
	// The handler pushes an initial event immediately; we must receive it.
	buf := make([]byte, 256)
	n, _ := resp.Body.Read(buf)
	if !strings.Contains(string(buf[:n]), "data:") {
		t.Fatalf("expected an SSE 'data:' event, got %q", string(buf[:n]))
	}
}

// TestSSEStreamDrainsOnShutdown is a regression guard for the production bug
// where an open /api/chromecast/status/stream connection kept the handler alive,
// so http.Server.Shutdown blocked until its 10s deadline and the process exited
// "fatal: graceful shutdown: context deadline exceeded" on every restart.
// BeginShutdown must make the SSE handler return promptly.
func TestSSEStreamDrainsOnShutdown(t *testing.T) {
	app := newParityApp(t)

	// httptest.ResponseRecorder implements http.Flusher, and the request carries
	// a background (never-cancelled) context, so only shutdownCh can end the loop.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/chromecast/status/stream", nil)

	done := make(chan struct{})
	go func() {
		app.handleCCStatusStream(rec, req)
		close(done)
	}()

	// Let the handler do its initial push and enter the select loop.
	time.Sleep(50 * time.Millisecond)
	app.BeginShutdown()

	select {
	case <-done:
		// returned promptly — Shutdown would drain cleanly
	case <-time.After(3 * time.Second):
		t.Fatal("SSE handler did not return after BeginShutdown — Shutdown would time out")
	}
}

// TestBeginShutdownIdempotent ensures repeated/again calls don't panic on the
// already-closed channel (systemd may deliver SIGTERM more than once).
func TestBeginShutdownIdempotent(t *testing.T) {
	app := newParityApp(t)
	app.BeginShutdown()
	app.BeginShutdown() // must not panic (sync.Once guards the close)
}
