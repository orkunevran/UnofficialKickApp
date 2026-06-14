package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

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
