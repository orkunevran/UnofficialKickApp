package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"time"
)

// chromecastService is the subset of chromecast.Service the routes use; the
// seam lets tests inject a fake.
type chromecastService interface {
	ScanAsync(force bool, knownHosts []string) bool
	IsScanning() bool
	GetDevices() []map[string]any
	SelectDevice(uuid string, timeout time.Duration) (bool, string)
	CastStream(streamURL, title string) bool
	StopCast(uuid string) bool
	GetLastDevice() map[string]any
	GetStatus() map[string]any
	Subscribe() (<-chan map[string]any, func())
	PauseMedia() bool
	PlayMedia() bool
	SetVolume(level float64) bool
	SeekMedia(position float64) bool
}

const selectTimeout = 15 * time.Second

var hostRe = regexp.MustCompile(`^[a-zA-Z0-9._:-]{1,255}$`)

// parseKnownHosts validates and splits a comma/space-separated host list.
func parseKnownHosts(raw string) []string {
	if raw == "" {
		return nil
	}
	var hosts []string
	for _, part := range subnetSepHTTP.Split(raw, -1) {
		if part == "" {
			continue
		}
		if hostRe.MatchString(part) {
			hosts = append(hosts, part)
		}
	}
	return hosts
}

var subnetSepHTTP = regexp.MustCompile(`[,\s]+`)

func decodeBody(r *http.Request, v any) error {
	defer r.Body.Close()
	err := json.NewDecoder(r.Body).Decode(v)
	if errors.Is(err, io.EOF) {
		return nil // empty body is allowed for optional payloads
	}
	return err
}

// GET /api/chromecast/devices
func (a *App) handleCCDevices(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	force := q.Get("force") == "true"
	hosts := parseKnownHosts(q.Get("known_hosts"))
	scanning := a.chromecast.ScanAsync(force || len(hosts) > 0, hosts)
	successJSON(w, map[string]any{
		"devices":  a.chromecast.GetDevices(),
		"scanning": scanning || a.chromecast.IsScanning(),
	}, "", 200)
}

// POST /api/chromecast/select
func (a *App) handleCCSelect(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UUID string `json:"uuid"`
	}
	if err := decodeBody(r, &body); err != nil || body.UUID == "" {
		errorJSON(w, "Device UUID is required.", 400)
		return
	}
	ok, reason := a.chromecast.SelectDevice(body.UUID, selectTimeout)
	switch {
	case ok:
		successJSON(w, nil, "Device "+body.UUID+" selected.", 200)
	case reason == "scanning":
		errorJSON(w, "Device scan in progress. Please wait and try again.", 409)
	case reason == "busy":
		errorJSON(w, "Another device selection is in progress.", 409)
	case reason == "cooldown":
		// Recently failed to connect — benched briefly so we don't hammer a flaky
		// device. 503 (not 409) so the client backs off instead of fast-retrying.
		errorJSON(w, "Device is temporarily unavailable after a failed connection. Please wait a few seconds and retry.", 503)
	default:
		errorJSON(w, "Device "+body.UUID+" not found or connection failed.", 404)
	}
}

// POST /api/chromecast/cast
func (a *App) handleCCCast(w http.ResponseWriter, r *http.Request) {
	var body struct {
		StreamURL string `json:"stream_url"`
		Title     string `json:"title"`
	}
	if err := decodeBody(r, &body); err != nil || body.StreamURL == "" {
		errorJSON(w, "Stream URL is required.", 400)
		return
	}
	title := body.Title
	if title == "" {
		title = "Kick Stream"
	}
	if a.chromecast.CastStream(body.StreamURL, title) {
		successJSON(w, nil, "Casting started.", 200)
		return
	}
	errorJSON(w, "Failed to start casting.", 500)
}

// POST /api/chromecast/stop
func (a *App) handleCCStop(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UUID string `json:"uuid"`
	}
	if err := decodeBody(r, &body); err != nil {
		errorJSON(w, "Invalid request body.", 400)
		return
	}
	if a.chromecast.StopCast(body.UUID) {
		successJSON(w, nil, "Cast stopped.", 200)
		return
	}
	errorJSON(w, "Failed to stop cast. No device was selected or the specified UUID was not found.", 404)
}

// GET /api/chromecast/last-device
func (a *App) handleCCLastDevice(w http.ResponseWriter, r *http.Request) {
	successJSON(w, map[string]any{"device": a.chromecast.GetLastDevice()}, "", 200)
}

// GET /api/chromecast/status
func (a *App) handleCCStatus(w http.ResponseWriter, r *http.Request) {
	successJSON(w, a.chromecast.GetStatus(), "", 200)
}

// GET /api/chromecast/status/stream — Server-Sent Events status pushes.
// Events are driven by the shared RunStatusPoller goroutine, so N concurrent
// SSE connections do not each call app.Update() on the Cast device.
func (a *App) handleCCStatusStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		errorJSON(w, "Streaming unsupported.", 500)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")

	ch, unsub := a.chromecast.Subscribe()
	defer unsub()

	ctx := r.Context()
	rc := http.NewResponseController(w)
	// write returns an error if the client is gone or slow. A per-write deadline
	// is essential: without it a stalled/dead client blocks w.Write indefinitely
	// (no server WriteTimeout, by design for SSE), which both leaks this handler
	// and blocks graceful shutdown past its deadline → "fatal: graceful shutdown".
	write := func(status map[string]any) error {
		payload := envelopeMap("success", "", status)
		b, _ := json.Marshal(payload)
		_ = rc.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if _, err := w.Write([]byte("data: " + string(b) + "\n\n")); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}
	if write(a.chromecast.GetStatus()) != nil { // initial push before first poller tick
		return
	}
	for {
		select {
		case <-ctx.Done(): // client disconnected
			return
		case <-a.shutdownCh: // server shutting down — return so Shutdown can drain
			return
		case status := <-ch:
			if write(status) != nil { // client gone/slow — drop it (browser will reconnect)
				return
			}
		}
	}
}

// POST /api/chromecast/pause
func (a *App) handleCCPause(w http.ResponseWriter, r *http.Request) {
	if a.chromecast.PauseMedia() {
		successJSON(w, nil, "Playback paused.", 200)
		return
	}
	errorJSON(w, "Failed to pause playback. No active device or media controller.", 400)
}

// POST /api/chromecast/play
func (a *App) handleCCPlay(w http.ResponseWriter, r *http.Request) {
	if a.chromecast.PlayMedia() {
		successJSON(w, nil, "Playback resumed.", 200)
		return
	}
	errorJSON(w, "Failed to resume playback. No active device or media controller.", 400)
}

// POST /api/chromecast/volume
func (a *App) handleCCVolume(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Level *float64 `json:"level"`
	}
	if err := decodeBody(r, &body); err != nil || body.Level == nil || *body.Level < 0 || *body.Level > 1 {
		errorJSON(w, "Invalid volume level (must be between 0.0 and 1.0).", 400)
		return
	}
	if a.chromecast.SetVolume(*body.Level) {
		successJSON(w, nil, "Volume set.", 200)
		return
	}
	errorJSON(w, "Failed to set volume. No active device.", 400)
}

// POST /api/chromecast/seek
func (a *App) handleCCSeek(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Position *float64 `json:"position"`
	}
	if err := decodeBody(r, &body); err != nil || body.Position == nil || *body.Position < 0 {
		errorJSON(w, "Invalid seek position.", 400)
		return
	}
	if a.chromecast.SeekMedia(*body.Position) {
		successJSON(w, nil, "Media seeked.", 200)
		return
	}
	errorJSON(w, "Failed to seek media. No active device or media controller.", 400)
}
