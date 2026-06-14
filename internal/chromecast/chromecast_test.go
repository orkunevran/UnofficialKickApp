package chromecast

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"testing"
	"time"

	gccast "github.com/vishen/go-chromecast/cast"
)

// ── test doubles ─────────────────────────────────────────────────────────────

type fakeCaster struct {
	loadErr error
	closed  bool
}

func (f *fakeCaster) Load(string, int, string, bool, bool, bool) error { return f.loadErr }
func (f *fakeCaster) Pause() error                                      { return nil }
func (f *fakeCaster) Unpause() error                                    { return nil }
func (f *fakeCaster) SetVolume(float32) error                           { return nil }
func (f *fakeCaster) SeekToTime(float32) error                          { return nil }
func (f *fakeCaster) Update() error                                     { return nil }
func (f *fakeCaster) Status() (*gccast.Application, *gccast.Media, *gccast.Volume) {
	return nil, nil, nil
}
func (f *fakeCaster) Close(bool) error { f.closed = true; return nil }

func testService(cfg Config) *Service {
	s := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	s.discover = func(ctx context.Context) ([]Device, error) { return nil, nil }
	s.newCaster = func(addr string, port int) (caster, error) {
		return nil, errors.New("no real device")
	}
	return s
}

func defaultCfg() Config {
	return Config{
		ScanTimeout:      100 * time.Millisecond,
		DeviceCacheTTL:   time.Hour,
		SelectMaxRetries: 1,
		SelectRetryDelay: 0,
	}
}

// ── ScanAsync ────────────────────────────────────────────────────────────────

func TestScanAsync_FirstScan(t *testing.T) {
	s := testService(defaultCfg())
	if !s.ScanAsync(false, nil) {
		t.Fatal("first scan should start and return true")
	}
}

func TestScanAsync_CacheFresh(t *testing.T) {
	s := testService(defaultCfg())
	s.lastScan = time.Now()
	if s.ScanAsync(false, nil) {
		t.Fatal("scan within TTL should return false (cache fresh)")
	}
}

func TestScanAsync_ForceBypassesCache(t *testing.T) {
	s := testService(defaultCfg())
	s.lastScan = time.Now()
	if !s.ScanAsync(true, nil) {
		t.Fatal("force=true should start scan even when cache is fresh")
	}
}

func TestScanAsync_AlreadyInProgress(t *testing.T) {
	block := make(chan struct{})
	s := testService(defaultCfg())
	s.discover = func(ctx context.Context) ([]Device, error) { <-block; return nil, nil }

	if !s.ScanAsync(true, nil) {
		t.Fatal("first call should start scan and return true")
	}
	// scanning=true is set by ScanAsync before the goroutine starts, so the
	// second call sees it immediately without a sleep.
	if s.ScanAsync(true, nil) {
		t.Fatal("second call while scan in progress should return false")
	}
	close(block)
}

// ── GetDevices / setDevices ───────────────────────────────────────────────────

func TestGetDevices_Empty(t *testing.T) {
	s := testService(defaultCfg())
	if devs := s.GetDevices(); len(devs) != 0 {
		t.Fatalf("expected empty devices, got %v", devs)
	}
}

func TestGetDevices_AfterScan(t *testing.T) {
	s := testService(defaultCfg())
	s.discover = func(ctx context.Context) ([]Device, error) {
		return []Device{
			{UUID: "uuid-1", Name: "Living Room", Addr: "192.168.1.10", Port: 8009},
			{UUID: "uuid-2", Name: "Bedroom", Addr: "192.168.1.11", Port: 8009},
		}, nil
	}
	s.ScanAsync(true, nil)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && s.IsScanning() {
		time.Sleep(5 * time.Millisecond)
	}
	devs := s.GetDevices()
	if len(devs) != 2 {
		t.Fatalf("expected 2 devices, got %d: %v", len(devs), devs)
	}
	if devs[0]["name"] != "Living Room" || devs[1]["name"] != "Bedroom" {
		t.Fatalf("unexpected device order: %v", devs)
	}
}

func TestSetDevices_PreservesSelected(t *testing.T) {
	s := testService(defaultCfg())
	s.devices = map[string]Device{
		"sel": {UUID: "sel", Name: "Selected TV", Addr: "10.0.0.1", Port: 8009},
	}
	s.order = []string{"sel"}
	s.selected = "sel"

	// Rescan discovers a different device; selected one is absent from new set.
	s.setDevices([]Device{{UUID: "new", Name: "New Device", Addr: "10.0.0.2", Port: 8009}})

	uuids := make(map[string]bool)
	for _, d := range s.GetDevices() {
		uuids[d["uuid"].(string)] = true
	}
	if !uuids["sel"] {
		t.Fatal("selected device must be preserved even when not rediscovered")
	}
	if !uuids["new"] {
		t.Fatal("newly discovered device must be included")
	}
}

func TestSetDevices_DedupUUID(t *testing.T) {
	s := testService(defaultCfg())
	dup := Device{UUID: "d1", Name: "TV", Addr: "10.0.0.1", Port: 8009}
	s.setDevices([]Device{dup, dup})
	if len(s.GetDevices()) != 1 {
		t.Fatal("duplicate UUIDs should be deduplicated")
	}
}

// ── SelectDevice ─────────────────────────────────────────────────────────────

func TestSelectDevice_NotFound(t *testing.T) {
	s := testService(defaultCfg())
	ok, reason := s.SelectDevice("no-such-uuid", time.Second)
	if ok || reason != "failed" {
		t.Fatalf("expected (false, failed), got (%v, %q)", ok, reason)
	}
}

func TestSelectDevice_WhileScanning(t *testing.T) {
	s := testService(defaultCfg())
	// Simulate an in-progress scan: set scanning=true and an unclosed scanDone
	// gate so waitScan blocks until the timeout fires.
	s.mu.Lock()
	s.scanning = true
	s.scanDone = make(chan struct{})
	s.mu.Unlock()

	ok, reason := s.SelectDevice("any", 20*time.Millisecond)
	if ok || reason != "scanning" {
		t.Fatalf("expected (false, scanning), got (%v, %q)", ok, reason)
	}
}

func TestSelectDevice_Success(t *testing.T) {
	s := testService(defaultCfg())
	fc := &fakeCaster{}
	s.newCaster = func(addr string, port int) (caster, error) { return fc, nil }
	s.devices = map[string]Device{
		"uuid-1": {UUID: "uuid-1", Name: "TV", Addr: "192.168.1.10", Port: 8009},
	}
	s.order = []string{"uuid-1"}

	ok, reason := s.SelectDevice("uuid-1", 2*time.Second)
	if !ok || reason != "" {
		t.Fatalf("expected success, got (%v, %q)", ok, reason)
	}
	s.mu.Lock()
	sel, name := s.selected, s.lastName
	s.mu.Unlock()
	if sel != "uuid-1" || name != "TV" {
		t.Fatalf("state not updated: selected=%q lastName=%q", sel, name)
	}
}

func TestSelectDevice_ClosesOldConnection(t *testing.T) {
	old := &fakeCaster{}
	s := testService(defaultCfg())
	s.app = old
	s.selected = "old"
	s.devices = map[string]Device{
		"new": {UUID: "new", Name: "New TV", Addr: "192.168.1.20", Port: 8009},
	}
	s.order = []string{"new"}
	s.newCaster = func(addr string, port int) (caster, error) { return &fakeCaster{}, nil }

	s.SelectDevice("new", 2*time.Second)
	if !old.closed {
		t.Fatal("old caster must be closed when a new device is selected")
	}
}

func TestSelectDevice_Timeout(t *testing.T) {
	s := testService(defaultCfg())
	// Caster that never returns within the given window.
	s.newCaster = func(addr string, port int) (caster, error) {
		time.Sleep(time.Second)
		return nil, errors.New("too slow")
	}
	s.devices = map[string]Device{
		"tv": {UUID: "tv", Name: "TV", Addr: "10.0.0.1", Port: 8009},
	}
	s.order = []string{"tv"}

	ok, reason := s.SelectDevice("tv", 50*time.Millisecond)
	if ok || reason != "failed" {
		t.Fatalf("timed-out select should return (false, failed), got (%v, %q)", ok, reason)
	}
}

// ── CastStream ────────────────────────────────────────────────────────────────

func TestCastStream_NoDevice(t *testing.T) {
	s := testService(defaultCfg())
	if s.CastStream("http://example.com/stream.m3u8", "Test") {
		t.Fatal("CastStream with no device should return false")
	}
}

func TestCastStream_Success(t *testing.T) {
	s := testService(defaultCfg())
	s.app = &fakeCaster{}
	if !s.CastStream("http://example.com/stream.m3u8", "Test") {
		t.Fatal("CastStream with connected device should return true")
	}
}

func TestCastStream_LoadError(t *testing.T) {
	s := testService(defaultCfg())
	s.app = &fakeCaster{loadErr: errors.New("load failed")}
	if s.CastStream("http://example.com/stream.m3u8", "Test") {
		t.Fatal("CastStream with load error should return false")
	}
}

// ── StopCast ─────────────────────────────────────────────────────────────────

func TestStopCast_ClearsState(t *testing.T) {
	fc := &fakeCaster{}
	s := testService(defaultCfg())
	s.app = fc
	s.selected = "uuid-1"

	if !s.StopCast("") {
		t.Fatal("StopCast should return true")
	}
	if !fc.closed {
		t.Fatal("caster must be closed on stop")
	}
	s.mu.Lock()
	app, sel := s.app, s.selected
	s.mu.Unlock()
	if app != nil || sel != "" {
		t.Fatalf("app and selected must be cleared: app=%v selected=%q", app, sel)
	}
}

func TestStopCast_WrongUUID(t *testing.T) {
	s := testService(defaultCfg())
	s.app = &fakeCaster{}
	s.selected = "uuid-1"
	if s.StopCast("uuid-OTHER") {
		t.Fatal("StopCast with mismatched UUID should return false")
	}
}

func TestStopCast_NoDevice(t *testing.T) {
	s := testService(defaultCfg())
	if s.StopCast("") {
		t.Fatal("StopCast with no connected device should return false")
	}
}

// ── Control methods ───────────────────────────────────────────────────────────

func TestPausePlay_NoDevice(t *testing.T) {
	s := testService(defaultCfg())
	if s.PauseMedia() {
		t.Fatal("PauseMedia with no device should return false")
	}
	if s.PlayMedia() {
		t.Fatal("PlayMedia with no device should return false")
	}
}

func TestSetVolume_Clamp(t *testing.T) {
	s := testService(defaultCfg())
	s.app = &fakeCaster{}
	if !s.SetVolume(-1.0) {
		t.Fatal("SetVolume(-1) should clamp to 0 and succeed")
	}
	if !s.SetVolume(2.0) {
		t.Fatal("SetVolume(2) should clamp to 1 and succeed")
	}
}

// ── GetStatus ─────────────────────────────────────────────────────────────────

func TestGetStatus_Disconnected(t *testing.T) {
	s := testService(defaultCfg())
	st := s.GetStatus()
	if st["status"] != "disconnected" {
		t.Fatalf("expected disconnected, got %v", st["status"])
	}
}

func TestGetStatus_Connected(t *testing.T) {
	s := testService(defaultCfg())
	s.app = &fakeCaster{}
	s.lastName = "My TV"
	st := s.GetStatus()
	if st["status"] != "connected" {
		t.Fatalf("expected connected, got %v", st["status"])
	}
	if st["device_name"] != "My TV" {
		t.Fatalf("device_name = %v; want My TV", st["device_name"])
	}
	if _, ok := st["is_playing"]; !ok {
		t.Fatal("connected status must include is_playing")
	}
}

// ── GetLastDevice ─────────────────────────────────────────────────────────────

func TestGetLastDevice_NoHistory(t *testing.T) {
	s := testService(defaultCfg())
	if s.GetLastDevice() != nil {
		t.Fatal("GetLastDevice with no history should return nil")
	}
}

func TestGetLastDevice_AfterSelect(t *testing.T) {
	s := testService(defaultCfg())
	s.lastUUID = "uuid-1"
	s.lastName = "My TV"
	d := s.GetLastDevice()
	if d == nil || d["uuid"] != "uuid-1" || d["name"] != "My TV" {
		t.Fatalf("unexpected last device: %v", d)
	}
}

// ── Fallback scan helpers (pure logic) ───────────────────────────────────────

func TestCandidateHosts_SmallSubnet(t *testing.T) {
	_, net24, _ := net.ParseCIDR("192.168.1.0/24")
	hosts := candidateHosts([]*net.IPNet{net24})
	// /24 has 254 usable hosts (network + broadcast excluded)
	if len(hosts) != 254 {
		t.Fatalf("expected 254 hosts for /24, got %d", len(hosts))
	}
	if hosts[0] != "192.168.1.1" {
		t.Fatalf("first host should be .1, got %s", hosts[0])
	}
	if hosts[253] != "192.168.1.254" {
		t.Fatalf("last host should be .254, got %s", hosts[253])
	}
}

func TestCandidateHosts_LargeSubnetSkipped(t *testing.T) {
	// /19 has >8000 hosts — exceeds the bits-ones>12 guard.
	_, big, _ := net.ParseCIDR("10.0.0.0/19")
	if len(candidateHosts([]*net.IPNet{big})) != 0 {
		t.Fatal("subnets larger than /20 should be skipped")
	}
}

func TestParseSubnets_Valid(t *testing.T) {
	nets := parseSubnets("192.168.0.0/24, 10.0.0.0/24")
	if len(nets) != 2 {
		t.Fatalf("expected 2 subnets, got %d", len(nets))
	}
}

func TestParseSubnets_InvalidSkipped(t *testing.T) {
	nets := parseSubnets("not-a-cidr, 192.168.0.0/24")
	if len(nets) != 1 {
		t.Fatalf("invalid CIDR should be skipped, got %d subnets", len(nets))
	}
}

// ── LRU ──────────────────────────────────────────────────────────────────────

func TestLRU_AddAndEvict(t *testing.T) {
	l := newLRU(3)
	l.add("a")
	l.add("b")
	l.add("c")
	if l.len() != 3 {
		t.Fatalf("expected 3, got %d", l.len())
	}
	l.add("d") // evicts "a"
	if l.len() != 3 {
		t.Fatalf("expected 3 after eviction, got %d", l.len())
	}
	for _, k := range l.keys() {
		if k == "a" {
			t.Fatal("evicted key 'a' should not be present")
		}
	}
}

func TestLRU_ReAddRefreshesOrder(t *testing.T) {
	l := newLRU(3)
	l.add("a")
	l.add("b")
	l.add("c")
	l.add("a") // re-add moves a to end; "b" should be the oldest
	l.add("d") // evicts "b", not "a"
	for _, k := range l.keys() {
		if k == "b" {
			t.Fatal("re-adding 'a' should have moved it to most-recent; 'b' should be evicted")
		}
	}
}

func TestLRU_AddReturnsFalseOnDuplicate(t *testing.T) {
	l := newLRU(3)
	if !l.add("x") {
		t.Fatal("first add should return true")
	}
	if l.add("x") {
		t.Fatal("re-add of existing key should return false")
	}
}
