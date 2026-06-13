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
	"log/slog"
	"os"
	"sync"
	"time"

	gccast "github.com/vishen/go-chromecast/cast"
)

const knownHostsLimit = 128

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

	scanning  bool
	selecting bool
	lastScan  time.Time

	// Seams (real impls set in New; overridable in tests).
	discover  func(ctx context.Context) ([]Device, error)
	newCaster func(addr string, port int) (caster, error)
}

// New constructs a Service with go-chromecast-backed discovery and casting.
func New(cfg Config, log *slog.Logger) *Service {
	s := &Service{
		cfg:     cfg,
		log:     log,
		devices: make(map[string]Device),
		known:   newLRU(knownHostsLimit),
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

func (s *Service) doScan() {
	defer func() {
		s.mu.Lock()
		s.scanning = false
		s.lastScan = time.Now()
		s.mu.Unlock()
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
	s.mu.Lock()
	if s.scanning {
		s.mu.Unlock()
		return false, "scanning"
	}
	if s.selecting {
		s.mu.Unlock()
		return false, "busy"
	}
	dev, ok := s.devices[uuid]
	if !ok {
		s.mu.Unlock()
		return false, "failed"
	}
	s.selecting = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.selecting = false
		s.mu.Unlock()
	}()

	type result struct {
		ok     bool
		reason string
	}
	done := make(chan result, 1)
	go func() {
		retries := s.cfg.SelectMaxRetries
		if retries < 1 {
			retries = 1
		}
		for attempt := 1; attempt <= retries; attempt++ {
			app, err := s.newCaster(dev.Addr, dev.Port)
			if err == nil {
				s.mu.Lock()
				if s.app != nil {
					_ = s.app.Close(false)
				}
				s.app = app
				s.selected = uuid
				s.lastUUID = uuid
				s.lastName = dev.Name
				s.mu.Unlock()
				s.saveState()
				done <- result{true, ""}
				return
			}
			s.log.Error("connect attempt failed", "device", dev.Name, "attempt", attempt, "error", err)
			if attempt < retries {
				time.Sleep(s.cfg.SelectRetryDelay)
			}
		}
		done <- result{false, "failed"}
	}()

	select {
	case r := <-done:
		return r.ok, r.reason
	case <-time.After(timeout):
		s.log.Error("select timed out", "device", dev.Name, "timeout", timeout)
		return false, "failed"
	}
}

// ── casting / control ──────────────────────────────────────────────────────────

// CastStream loads an HLS stream URL on the selected device.
func (s *Service) CastStream(streamURL, title string) bool {
	s.mu.Lock()
	app := s.app
	s.mu.Unlock()
	if app == nil {
		s.log.Error("no Chromecast device selected")
		return false
	}
	// content type matches the Python 'application/x-mpegurl'.
	if err := app.Load(streamURL, 0, "application/x-mpegurl", false, false, false); err != nil {
		s.log.Warn("cast load failed", "error", err)
		return false
	}
	return true
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

	if err := app.Close(true); err != nil {
		s.log.Warn("error closing cast connection", "error", err)
	}
	s.saveState()
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
	if err := fn(app); err != nil {
		s.log.Error("chromecast control failed", "error", err)
		return false
	}
	return true
}

// GetStatus returns the current playback status (ports get_status).
func (s *Service) GetStatus() map[string]any {
	s.mu.Lock()
	app := s.app
	name := s.lastName
	s.mu.Unlock()
	if app == nil {
		return map[string]any{"status": "disconnected"}
	}
	_ = app.Update()
	_, media, volume := app.Status()

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

// Shutdown closes any open connection.
func (s *Service) Shutdown() {
	s.mu.Lock()
	app := s.app
	s.app = nil
	s.selected = ""
	s.mu.Unlock()
	if app != nil {
		_ = app.Close(true)
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
	LastDeviceUUID      string   `json:"last_device_uuid"`
	LastDeviceName      string   `json:"last_device_name"`
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
	if err := os.WriteFile(s.cfg.StatePath, data, 0o644); err != nil {
		s.log.Warn("failed to save chromecast state cache", "error", err)
	}
}
