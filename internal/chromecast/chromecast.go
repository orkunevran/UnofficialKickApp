// Package chromecast ports services/chromecast_service.py to Go, backed by
// github.com/vishen/go-chromecast for mDNS discovery and Cast control, plus a
// hand-ported fallback TCP subnet scan (kept per the migration decision).
//
// pychromecast-specific reconnect bookkeeping (per-device connection-failure
// counts + connection listeners) is intentionally dropped: go-chromecast
// manages connection retries internally. The discovery and caster seams
// (s.discover / s.newCaster) let the registry/select/state logic be unit-tested
// without real devices — casting itself must be verified on a real LAN.
package chromecast

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	gccast "github.com/vishen/go-chromecast/cast"
)

const knownHostsLimit = 128

// errCastTimeout marks a Cast-protocol call that exceeded its time bound — i.e.
// the connection is hung, typically a half-open socket whose Write never returns
// because the device vanished without closing the TCP connection (go-chromecast's
// Send sets no write deadline). It is distinct from a *returned* protocol error,
// which may just be a transient standby/sleep blip worth tolerating for a poll.
var errCastTimeout = errors.New("cast operation timed out")

// defaultStatusUpdateTimeout bounds a single status poll's Update()+Status(). It
// must exceed go-chromecast's internal 5s sendAndWait response timeout so a
// merely-slow device surfaces as a normal (tolerated) error, while a true write
// hang is caught here and the connection dropped.
const defaultStatusUpdateTimeout = 8 * time.Second

// castLoadTimeout bounds a single app.Load() so a wedged Send (no write deadline)
// can't pin appMu forever; it exceeds go-chromecast's internal deadlines so a
// normally-slow receiver launch still completes before it trips.
const castLoadTimeout = 12 * time.Second

// Device is a discovered Cast device.
type Device struct {
	UUID string
	Name string
	Addr string
	Port int
}

// caster is the subset of go-chromecast's *application.Application that the
// service drives after a connection is established. The seam lets tests inject
// a fake without a real device.
type caster interface {
	Load(url string, startTime int, contentType string, transcode, detach, forceDetach bool) error
	Pause() error
	Unpause() error
	SetVolume(v float32) error
	SeekToTime(v float32) error
	Update() error
	Status() (*gccast.Application, *gccast.Media, *gccast.Volume)
	Close(stopMedia bool) error
}

// Config holds the Chromecast settings (from the app config).
type Config struct {
	ScanTimeout          time.Duration
	SelectMaxRetries     int
	SelectRetryDelay     time.Duration
	DeviceCacheTTL       time.Duration
	FallbackScanEnabled  bool
	FallbackScanSubnets  string
	FallbackScanWorkers  int
	FallbackProbeTimeout time.Duration
	FallbackInfoTimeout  time.Duration
	StatePath            string
	PeriodicScanInterval time.Duration // 0 disables the periodic background scan
	StatusUpdateTimeout  time.Duration // bound on a status poll's Update(); 0 → defaultStatusUpdateTimeout
	ConnectCooldown      time.Duration // min gap between (re)connect attempts to a device after a failure; 0 disables
}

// Service manages discovery, selection, and control of Cast devices.
type Service struct {
	mu  sync.Mutex
	cfg Config
	log *slog.Logger

	devices  map[string]Device // uuid → device
	order    []string          // discovery order, for stable GetDevices output
	selected string            // selected device uuid
	app      caster            // connected app for the selected device
	known    *lru
	lastUUID string
	lastName string
	// pollFailures counts consecutive status-poll Update() errors; after
	// staleDropThreshold the unreachable connection is dropped (see GetStatus).
	pollFailures int

	// castInFlight > 0 while a CastStream is loading media. The status poller
	// skips its Update()/drop during this window so it can't yank the connection
	// out from under a cast (which slow Android-TV receivers need several seconds
	// + retries to accept) and leave it "no device selected".
	castInFlight int

	// connectCooldownUntil rate-limits (re)connect attempts per device uuid. A
	// flaky box accepts TCP but won't complete the Cast handshake, so a connect
	// can take ~15s and fail; without a cooldown the UI's retries hammer the box
	// with a new TLS+handshake every few seconds, which wedges its Cast receiver.
	// After a failed/dropped connect the device is benched until this time; a
	// select during the window fails fast ("cooldown") without touching the box.
	connectCooldownUntil map[string]time.Time

	scanning  bool
	selecting bool
	lastScan  time.Time
	// scanDone is closed when the in-progress scan finishes. Always non-nil:
	// initialised to a pre-closed channel so waitScan returns immediately when
	// no scan is running.
	scanDone chan struct{}

	// appMu serialises ALL Cast-protocol method calls on the active caster
	// (Load, Update, Pause, Close, …). It is separate from mu so that state
	// reads/writes never block behind network I/O, and Cast I/O never races
	// between the status poller goroutine and HTTP-handler goroutines.
	// go-chromecast's Send sets NO write deadline, so a vanished device (half-open
	// socket) can wedge a call indefinitely and pin appMu. The status poller bounds
	// its Update() via runUpdate and, on timeout, drops + closes the connection
	// off-lock (closeHungApp) to free appMu — so a dead device self-heals instead
	// of deadlocking every control op and the status endpoint.
	appMu sync.Mutex

	// saveMu serialises state-cache writes (saveState) so concurrent savers
	// can't interleave; the write itself is atomic (temp file + rename).
	saveMu sync.Mutex

	// Pub-sub for status pushes: SSE handlers subscribe; control operations and
	// the background poller broadcast. One poller goroutine drives app.Update()
	// so N concurrent SSE connections don't each poll the device.
	subsMu  sync.Mutex
	subs    map[chan map[string]any]struct{}
	pollNow chan struct{} // capacity-1: control ops request an immediate poll

	// infoClient is a single reusable client for the fallback scan's eureka_info
	// probes (one-shot, keep-alives disabled) — avoids a per-probe Transport.
	infoClient *http.Client

	// Seams (real impls set in New; overridable in tests).
	discover  func(ctx context.Context) ([]Device, error)
	newCaster func(addr string, port int) (caster, error)
}

// New constructs a Service with go-chromecast-backed discovery and casting.
func New(cfg Config, log *slog.Logger) *Service {
	closed := make(chan struct{})
	close(closed) // pre-closed: waitScan returns immediately when idle
	s := &Service{
		cfg:                  cfg,
		log:                  log,
		devices:              make(map[string]Device),
		known:                newLRU(knownHostsLimit),
		scanDone:             closed,
		subs:                 make(map[chan map[string]any]struct{}),
		pollNow:              make(chan struct{}, 1),
		infoClient:           newInfoClient(cfg.FallbackInfoTimeout),
		connectCooldownUntil: make(map[string]time.Time),
	}
	if s.cfg.StatusUpdateTimeout <= 0 {
		s.cfg.StatusUpdateTimeout = defaultStatusUpdateTimeout
	}
	s.discover = s.mdnsDiscover
	s.newCaster = newRealCaster
	s.loadState()
	return s
}

// ── discovery ────────────────────────────────────────────────────────────────

// ScanAsync triggers a background scan unless one is in flight or the cached
// device list is still fresh. Returns true if a scan was started.
func (s *Service) ScanAsync(force bool, knownHosts []string) bool {
	s.mu.Lock()
	if !force && len(knownHosts) == 0 && time.Since(s.lastScan) < s.cfg.DeviceCacheTTL {
		s.mu.Unlock()
		return false
	}
	if s.scanning {
		s.mu.Unlock()
		return false
	}
	s.scanning = true
	s.scanDone = make(chan struct{}) // gate for this scan; closed by doScan
	s.mu.Unlock()

	for _, h := range knownHosts {
		s.rememberHost(h)
	}
	go s.doScan()
	return true
}

// IsScanning reports whether a background scan is in progress.
func (s *Service) IsScanning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.scanning
}

// waitScan blocks until no scan is in progress or the timeout elapses.
// Returns false if the timeout fired before the scan finished.
func (s *Service) waitScan(timeout time.Duration) bool {
	s.mu.Lock()
	if !s.scanning {
		s.mu.Unlock()
		return true
	}
	done := s.scanDone
	s.mu.Unlock()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (s *Service) doScan() {
	// Capture the gate channel under lock so we close the right one.
	s.mu.Lock()
	scanDone := s.scanDone
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.scanning = false
		s.lastScan = time.Now()
		s.mu.Unlock()
		close(scanDone)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.ScanTimeout)
	defer cancel()

	devs, err := s.discover(ctx)
	if err != nil {
		s.log.Warn("mDNS discovery error", "error", err)
	}
	if len(devs) == 0 && s.cfg.FallbackScanEnabled {
		s.log.Info("no devices via mDNS; running fallback subnet scan")
		devs = s.fallbackScan()
	}
	for _, d := range devs {
		if d.Addr != "" {
			s.rememberHost(d.Addr)
		}
	}
	s.setDevices(devs)
}

// setDevices replaces the registry with the freshly discovered set, preserving
// the currently selected device even if it wasn't rediscovered this round.
func (s *Service) setDevices(devs []Device) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := make(map[string]Device, len(devs))
	order := make([]string, 0, len(devs))
	for _, d := range devs {
		if _, dup := next[d.UUID]; dup {
			continue
		}
		next[d.UUID] = d
		order = append(order, d.UUID)
	}
	if s.selected != "" {
		if _, ok := next[s.selected]; !ok {
			if sel, ok := s.devices[s.selected]; ok {
				next[sel.UUID] = sel
				order = append(order, sel.UUID)
			}
		}
	}
	s.devices = next
	s.order = order
}

// ── registry queries ─────────────────────────────────────────────────────────

// GetDevices returns [{name, uuid}] for discovered devices, in discovery order.
func (s *Service) GetDevices() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]map[string]any, 0, len(s.order))
	for _, uuid := range s.order {
		if d, ok := s.devices[uuid]; ok {
			out = append(out, map[string]any{"name": d.Name, "uuid": d.UUID})
		}
	}
	return out
}

// GetLastDevice returns the last successfully selected {uuid, name}, or nil.
func (s *Service) GetLastDevice() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastUUID != "" && s.lastName != "" {
		return map[string]any{"uuid": s.lastUUID, "name": s.lastName}
	}
	return nil
}

// ── selection ────────────────────────────────────────────────────────────────

// SelectDevice connects to the device with the given uuid, bounded by timeout.
// Reasons: "" (ok), "scanning", "busy", "failed".
func (s *Service) SelectDevice(uuid string, timeout time.Duration) (bool, string) {
	// Wait for any in-progress scan via channel instead of a 200ms polling loop.
	// The select timeout is comfortably larger than the scan timeout, so this
	// only blocks for a few seconds on the very first click.
	if !s.waitScan(timeout) {
		return false, "scanning"
	}

	s.mu.Lock()
	if s.selecting {
		s.mu.Unlock()
		return false, "busy"
	}
	dev, ok := s.devices[uuid]
	if !ok {
		s.mu.Unlock()
		return false, "failed"
	}
	if s.cfg.ConnectCooldown > 0 {
		if until, cooling := s.connectCooldownUntil[uuid]; cooling && time.Now().Before(until) {
			s.mu.Unlock()
			return false, "cooldown"
		}
	}
	s.selecting = true
	s.mu.Unlock()

	// `selecting` is held only for the bounded duration of THIS call and released
	// on every return path (incl. timeout) by this defer. That is what stops a
	// hung connect from pinning `selecting` forever and 409-storming every later
	// select. Race-safety against a late-returning connect mutating s.app is
	// preserved not by holding `selecting` but by abandoning the orphan below
	// (closing it, never storing it). A concurrent select while this attempt is
	// still in flight (not yet timed out) still correctly gets "busy".
	defer func() {
		s.mu.Lock()
		s.selecting = false
		s.mu.Unlock()
	}()

	type result struct {
		app caster
		err error
	}
	done := make(chan result, 1)
	go func() {
		retries := s.cfg.SelectMaxRetries
		if retries < 1 {
			retries = 1
		}
		var app caster
		var err error
		for attempt := 1; attempt <= retries; attempt++ {
			if app, err = s.newCaster(dev.Addr, dev.Port); err == nil {
				break
			}
			s.log.Error("connect attempt failed", "device", dev.Name, "attempt", attempt, "error", err)
			if attempt < retries {
				time.Sleep(s.cfg.SelectRetryDelay)
			}
		}
		done <- result{app, err}
	}()

	select {
	case r := <-done:
		if r.err != nil || r.app == nil {
			s.noteConnectCooldown(uuid)
			return false, "failed"
		}
		s.mu.Lock()
		old := s.app
		s.app = r.app
		s.selected = uuid
		s.lastUUID = uuid
		s.lastName = dev.Name
		delete(s.connectCooldownUntil, uuid) // recovered — clear any bench
		s.mu.Unlock()
		// Close the previous connection OUTSIDE s.mu and UNDER appMu, so it cannot
		// race the status poller's Update() on that same caster.
		s.closeApp(old, false)
		s.saveState()
		s.triggerPoll()
		return true, ""
	case <-time.After(timeout):
		// The connect is hung. Abandon it: `selecting` is released by the defer so
		// later selects can proceed, and when the orphaned attempt eventually
		// returns we close any connection it produced so it can neither leak nor
		// mutate s.app behind a newer selection. Bench the device so the UI's
		// retries don't immediately re-hammer it.
		s.noteConnectCooldown(uuid)
		go func() {
			if r := <-done; r.app != nil {
				s.closeApp(r.app, false)
			}
		}()
		s.log.Error("select timed out", "device", dev.Name, "timeout", timeout)
		return false, "failed"
	}
}

// noteConnectCooldown benches a device after a failed/dropped connect so the UI's
// retries don't hammer it with a fresh TLS+handshake every few seconds (which can
// wedge a flaky Cast receiver). No-op when cooldown is disabled.
func (s *Service) noteConnectCooldown(uuid string) {
	if s.cfg.ConnectCooldown <= 0 || uuid == "" {
		return
	}
	s.mu.Lock()
	s.connectCooldownUntil[uuid] = time.Now().Add(s.cfg.ConnectCooldown)
	s.mu.Unlock()
}

// closeApp disconnects a caster under appMu (never under s.mu) so it cannot race
// the status poller's Update() on the same connection. nil-safe.
func (s *Service) closeApp(app caster, stopMedia bool) {
	if app == nil {
		return
	}
	s.appMu.Lock()
	defer s.appMu.Unlock()
	if err := app.Close(stopMedia); err != nil {
		s.log.Warn("error closing cast connection", "error", err)
	}
}

// ── casting / control ──────────────────────────────────────────────────────────

// reconnectSelected re-establishes the connection to the currently selected
// device on a fresh socket, to recover from a stale connection (TV slept /
// dropped / changed IP) before retrying a cast. No-op if nothing is selected.
func (s *Service) reconnectSelected() bool {
	s.mu.Lock()
	uuid := s.selected
	dev, ok := s.devices[uuid]
	old := s.app
	s.mu.Unlock()
	if uuid == "" || !ok {
		return false
	}
	app, err := s.newCaster(dev.Addr, dev.Port)
	if err != nil {
		s.log.Warn("cast reconnect failed", "device", dev.Name, "error", err)
		return false
	}
	s.mu.Lock()
	s.app = app
	s.pollFailures = 0
	s.mu.Unlock()
	s.closeApp(old, false)
	return true
}

// CastStream loads an HLS stream URL on the selected device.
//
// Android-TV style receivers (e.g. Xiaomi TV) are slow to cold-launch the
// Default Media Receiver, and a cached socket can be stale after the TV sleeps
// — both surface as "context deadline exceeded / unable to change to appID
// CC1AD845". So we retry with a short backoff and reconnect on a fresh socket
// between attempts (which also re-issues the receiver launch). content type
// matches the Python 'application/x-mpegurl'.
func (s *Service) CastStream(streamURL, title string) bool {
	// Mark a cast in flight so the status poller leaves the connection alone while
	// we (re)load — otherwise its Update() timeout would drop the connection mid-
	// cast and the next attempt would see "no device selected".
	s.mu.Lock()
	s.castInFlight++
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.castInFlight--
		s.mu.Unlock()
	}()

	const maxAttempts = 3
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		s.mu.Lock()
		app := s.app
		s.mu.Unlock()
		if app == nil {
			s.log.Error("no Chromecast device selected")
			return false
		}

		err := s.loadWithTimeout(app, streamURL, castLoadTimeout)
		if err == nil {
			s.triggerPoll()
			return true
		}

		if attempt == maxAttempts {
			s.log.Warn("cast load failed", "attempts", maxAttempts, "error", err)
			return false
		}
		s.log.Info("cast load attempt failed, reconnecting then retrying", "attempt", attempt, "error", err)
		s.reconnectSelected()
		time.Sleep(time.Second)
	}
	return false
}

// loadWithTimeout runs app.Load under appMu, bounded by timeout. On timeout the
// connection is hung (Send sets no write deadline) — break it off-lock with
// closeHungApp so it can't pin appMu, and report failure so CastStream reconnects.
//
// detach=true is essential: go-chromecast's play() otherwise calls MediaWait(),
// which blocks until the media "finishes" (an IDLE/FINISHED or app-change event).
// For a live/long stream that never fires, and when SWITCHING streams on an
// already-running receiver the finish-signal never comes at all — so Load() would
// hang (only the first cast, which triggers an app-launch transition, returns).
// Detaching makes Load fire the LOAD command and return immediately, so a second
// stream can replace the first. The stream is always an external http(s) URL, so
// detach is honoured (see go-chromecast play()).
func (s *Service) loadWithTimeout(app caster, streamURL string, timeout time.Duration) error {
	done := make(chan error, 1)
	go func() {
		s.appMu.Lock()
		e := app.Load(streamURL, 0, "application/x-mpegurl", false, true, false)
		s.appMu.Unlock()
		done <- e
	}()
	select {
	case e := <-done:
		return e
	case <-time.After(timeout):
		s.closeHungApp(app)
		return errCastTimeout
	}
}

// StopCast stops playback and disconnects the selected (or specified) device.
func (s *Service) StopCast(uuid string) bool {
	s.mu.Lock()
	if uuid != "" && uuid != s.selected {
		s.mu.Unlock()
		return false
	}
	app := s.app
	if app == nil {
		s.mu.Unlock()
		return false
	}
	s.app = nil
	s.selected = ""
	s.mu.Unlock()

	s.closeApp(app, true)
	s.saveState()
	s.triggerPoll()
	return true
}

func (s *Service) PauseMedia() bool { return s.withApp(func(a caster) error { return a.Pause() }) }
func (s *Service) PlayMedia() bool  { return s.withApp(func(a caster) error { return a.Unpause() }) }

// SetVolume clamps level to [0,1] and applies it.
func (s *Service) SetVolume(level float64) bool {
	if level < 0 {
		level = 0
	}
	if level > 1 {
		level = 1
	}
	return s.withApp(func(a caster) error { return a.SetVolume(float32(level)) })
}

// SeekMedia seeks to an absolute position in seconds.
func (s *Service) SeekMedia(positionSeconds float64) bool {
	return s.withApp(func(a caster) error { return a.SeekToTime(float32(positionSeconds)) })
}

func (s *Service) withApp(fn func(caster) error) bool {
	s.mu.Lock()
	app := s.app
	s.mu.Unlock()
	if app == nil {
		return false
	}
	s.appMu.Lock()
	err := fn(app)
	s.appMu.Unlock()
	if err != nil {
		s.log.Error("chromecast control failed", "error", err)
		return false
	}
	s.triggerPoll()
	return true
}

// staleDropThreshold is the number of consecutive status-poll failures after
// which an unreachable device's connection is dropped, so controls (which share
// appMu) stop stalling on it and AutoReconnect / a re-select can recover.
const staleDropThreshold = 3

// runUpdate runs app.Update()+Status() under appMu, bounded by timeout. A
// returned error means the device answered with an error (or the call completed
// with one); errCastTimeout means the call is HUNG — the spawned goroutine is
// still blocked holding appMu, so the caller MUST drop the connection and break
// it via closeHungApp (closeApp would deadlock waiting for the same appMu).
func (s *Service) runUpdate(app caster, timeout time.Duration) (media *gccast.Media, volume *gccast.Volume, err error) {
	type res struct {
		media  *gccast.Media
		volume *gccast.Volume
		err    error
	}
	done := make(chan res, 1) // buffered so the goroutine never blocks on send after a timeout
	go func() {
		s.appMu.Lock()
		e := app.Update()
		_, m, v := app.Status()
		s.appMu.Unlock()
		done <- res{m, v, e}
	}()
	select {
	case r := <-done:
		return r.media, r.volume, r.err
	case <-time.After(timeout):
		return nil, nil, errCastTimeout
	}
}

// closeHungApp breaks a connection whose Update() is wedged (and thus still
// holding appMu) by closing the underlying socket directly, WITHOUT appMu —
// which unblocks the stuck call so it can release appMu. Detached because the
// close itself can briefly block. Safe because the caller has already cleared
// s.app, so no other goroutine will start a new call on this caster.
func (s *Service) closeHungApp(app caster) {
	go func() {
		if err := app.Close(false); err != nil {
			s.log.Warn("error closing hung cast connection", "error", err)
		}
	}()
}

// GetStatus returns the current playback status (ports get_status).
func (s *Service) GetStatus() map[string]any {
	s.mu.Lock()
	app := s.app
	name := s.lastName
	casting := s.castInFlight > 0
	s.mu.Unlock()
	if app == nil {
		return map[string]any{"status": "disconnected"}
	}
	if casting {
		// A cast is loading and owns the connection; don't poll/drop it. Report
		// connected and let CastStream finish — the next poll gets full status.
		return map[string]any{"status": "connected", "device_name": name}
	}
	media, volume, updateErr := s.runUpdate(app, s.cfg.StatusUpdateTimeout)

	if updateErr != nil {
		// The device didn't answer. A *returned* error during standby/sleep is
		// often transient, so keep reporting the last-known status for a few polls.
		// But a *timeout* means Update() is hung and pinning appMu — every control
		// op (volume/play/seek) and the status endpoint would stall behind it — so
		// drop immediately rather than tolerating it.
		timedOut := errors.Is(updateErr, errCastTimeout)
		s.mu.Lock()
		s.pollFailures++
		n := s.pollFailures
		drop := (timedOut || n >= staleDropThreshold) && s.app == app
		droppedUUID := s.selected
		if drop {
			s.app = nil
			s.selected = ""
			s.pollFailures = 0
		}
		s.mu.Unlock()
		if drop {
			s.log.Warn("dropping unreachable cast connection", "device", name, "failures", n, "timedOut", timedOut, "error", updateErr)
			if timedOut {
				s.closeHungApp(app) // Update() still holds appMu; break it off-lock
			} else {
				s.closeApp(app, false)
			}
			s.noteConnectCooldown(droppedUUID) // bench so the UI's reconnect doesn't re-hammer
			s.saveState()
			return map[string]any{"status": "disconnected"}
		}
	} else {
		s.mu.Lock()
		s.pollFailures = 0
		s.mu.Unlock()
	}

	isPlaying := media != nil && media.PlayerState == "PLAYING"
	var volumeLevel any = 1.0
	if volume != nil {
		volumeLevel = volume.Level
	}
	var duration, currentTime any
	if media != nil {
		duration = media.Media.Duration
		currentTime = media.CurrentTime
	}
	return map[string]any{
		"status":       "connected",
		"device_name":  name,
		"is_playing":   isPlaying,
		"volume_level": volumeLevel,
		"duration":     duration,
		"current_time": currentTime,
	}
}

// (No Shutdown method by design: a server restart must NOT disconnect/stop an
// active cast — the device keeps playing and AutoReconnect re-attaches. The OS
// reclaims the control socket on process exit.)

// ── pub-sub (status push) ─────────────────────────────────────────────────────

// Subscribe returns a receive channel that is sent status maps whenever the
// device state changes, and an unsubscribe function. The channel is buffered;
// slow readers receive the most-recent event that fit and miss earlier ones.
func (s *Service) Subscribe() (<-chan map[string]any, func()) {
	ch := make(chan map[string]any, 4)
	s.subsMu.Lock()
	s.subs[ch] = struct{}{}
	s.subsMu.Unlock()
	return ch, func() {
		s.subsMu.Lock()
		delete(s.subs, ch)
		s.subsMu.Unlock()
	}
}

func (s *Service) broadcast(status map[string]any) {
	s.subsMu.Lock()
	defer s.subsMu.Unlock()
	for ch := range s.subs {
		select {
		case ch <- status:
		default: // slow subscriber: drop rather than block
		}
	}
}

// triggerPoll asks the status poller to wake up immediately rather than waiting
// for the next scheduled tick. Non-blocking: if the channel is already full a
// poll is already queued.
func (s *Service) triggerPoll() {
	select {
	case s.pollNow <- struct{}{}:
	default:
	}
}

// ── background tasks ──────────────────────────────────────────────────────────

// RunStatusPoller drives periodic status updates. A single goroutine calls
// app.Update() and broadcasts to all subscribers, so N concurrent SSE
// connections do not each poll the Cast device. Control operations send on
// pollNow to request an out-of-cycle push. Exits when ctx is cancelled.
func (s *Service) RunStatusPoller(ctx context.Context) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.broadcast(s.GetStatus())
		case <-s.pollNow:
			s.broadcast(s.GetStatus())
		}
	}
}

// RunPeriodicScan triggers a device re-scan at the configured interval so the
// device list stays fresh without requiring an explicit /devices?force=true
// request. Exits when ctx is cancelled or interval is zero (feature disabled).
func (s *Service) RunPeriodicScan(ctx context.Context) {
	if s.cfg.PeriodicScanInterval <= 0 {
		return
	}
	ticker := time.NewTicker(s.cfg.PeriodicScanInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.ScanAsync(true, nil)
		}
	}
}

// AutoReconnect tries to reconnect to the last known device on startup, so the
// Chromecast works immediately after a server restart without the user having
// to re-select. It triggers a scan, waits for it, then selects the device.
func (s *Service) AutoReconnect(ctx context.Context) {
	s.mu.Lock()
	uuid := s.lastUUID
	name := s.lastName
	known := s.known.keys()
	s.mu.Unlock()
	if uuid == "" {
		return
	}

	s.ScanAsync(true, known)
	if !s.waitScan(s.cfg.ScanTimeout + 5*time.Second) {
		s.log.Warn("auto-reconnect: scan timed out", "device", name)
		return
	}
	select {
	case <-ctx.Done():
		return
	default:
	}

	s.mu.Lock()
	_, found := s.devices[uuid]
	s.mu.Unlock()
	if !found {
		s.log.Info("auto-reconnect: last device not found after scan", "device", name, "uuid", uuid)
		return
	}

	if ok, _ := s.SelectDevice(uuid, 10*time.Second); ok {
		s.log.Info("auto-reconnected to last Chromecast", "device", name)
	}
}

// ── known-hosts LRU + state persistence ────────────────────────────────────────

func (s *Service) rememberHost(host string) {
	s.mu.Lock()
	added := s.known.add(host)
	s.mu.Unlock()
	if added {
		s.saveState()
	}
}

type persistedState struct {
	LastDeviceUUID       string   `json:"last_device_uuid"`
	LastDeviceName       string   `json:"last_device_name"`
	KnownChromecastHosts []string `json:"known_chromecast_hosts"`
}

func (s *Service) loadState() {
	if s.cfg.StatePath == "" {
		return
	}
	data, err := os.ReadFile(s.cfg.StatePath)
	if err != nil {
		return
	}
	var st persistedState
	if err := json.Unmarshal(data, &st); err != nil {
		s.log.Warn("failed to parse chromecast state cache", "error", err)
		return
	}
	s.lastUUID = st.LastDeviceUUID
	s.lastName = st.LastDeviceName
	for _, h := range st.KnownChromecastHosts {
		s.known.add(h)
	}
}

func (s *Service) saveState() {
	if s.cfg.StatePath == "" {
		return
	}
	s.mu.Lock()
	st := persistedState{
		LastDeviceUUID:       s.lastUUID,
		LastDeviceName:       s.lastName,
		KnownChromecastHosts: s.known.keys(),
	}
	s.mu.Unlock()
	data, err := json.Marshal(st)
	if err != nil {
		return
	}
	// Serialise concurrent savers and write atomically (temp + rename) so a
	// save from doScan / SelectDevice / StopCast can't interleave or truncate.
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	tmp := s.cfg.StatePath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		s.log.Warn("failed to save chromecast state cache", "error", err)
		return
	}
	if err := os.Rename(tmp, s.cfg.StatePath); err != nil {
		s.log.Warn("failed to save chromecast state cache", "error", err)
	}
}
