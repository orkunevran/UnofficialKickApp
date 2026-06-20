package chromecast

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"sync"
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
func (f *fakeCaster) Pause() error                                     { return nil }
func (f *fakeCaster) Unpause() error                                   { return nil }
func (f *fakeCaster) SetVolume(float32) error                          { return nil }
func (f *fakeCaster) SeekToTime(float32) error                         { return nil }
func (f *fakeCaster) Update() error                                    { return nil }
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
	if len(l.keys()) != 3 {
		t.Fatalf("expected 3, got %d", len(l.keys()))
	}
	l.add("d") // evicts "a"
	if len(l.keys()) != 3 {
		t.Fatalf("expected 3 after eviction, got %d", len(l.keys()))
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

// ── SelectDevice concurrency (regression guards) ──────────────────────────────

// raceCaster touches a shared field in both Update and Close, so the race
// detector flags any concurrent (unserialised) Cast I/O on the same connection.
type raceCaster struct{ ops int }

func (r *raceCaster) Load(string, int, string, bool, bool, bool) error { r.ops++; return nil }
func (r *raceCaster) Pause() error                                     { r.ops++; return nil }
func (r *raceCaster) Unpause() error                                   { r.ops++; return nil }
func (r *raceCaster) SetVolume(float32) error                          { r.ops++; return nil }
func (r *raceCaster) SeekToTime(float32) error                         { r.ops++; return nil }
func (r *raceCaster) Update() error                                    { r.ops++; return nil }
func (r *raceCaster) Status() (*gccast.Application, *gccast.Media, *gccast.Volume) {
	return nil, nil, nil
}
func (r *raceCaster) Close(bool) error { r.ops++; return nil }

// TestSelectDevice_SwitchIsRaceFree guards finding #1: switching devices closed
// the previous caster under s.mu (not appMu), racing the status poller's
// Update() on that same connection. Run under `go test -race`.
func TestSelectDevice_SwitchIsRaceFree(t *testing.T) {
	s := testService(defaultCfg())
	s.newCaster = func(addr string, port int) (caster, error) { return &raceCaster{}, nil }
	s.setDevices([]Device{
		{UUID: "a", Name: "A", Addr: "a", Port: 8009},
		{UUID: "b", Name: "B", Addr: "b", Port: 8009},
	})
	if ok, _ := s.SelectDevice("a", time.Second); !ok {
		t.Fatal("select A should succeed")
	}

	// Hammer GetStatus (Update on the active caster, under appMu) while repeatedly
	// switching devices (each switch closes the previous connection). The close
	// must be serialised with the poller, not racing it.
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				s.GetStatus()
			}
		}
	}()
	for i := 0; i < 60; i++ {
		dev := "b"
		if i%2 == 0 {
			dev = "a"
		}
		s.SelectDevice(dev, time.Second)
	}
	close(stop)
	wg.Wait()
}

// TestSelectDevice_BusyDuringInFlightConnect guards finding #2's safety half:
// while a connect is genuinely in flight (not yet timed out), a concurrent
// select gets "busy" — two selects must never race on s.app simultaneously.
func TestSelectDevice_BusyDuringInFlightConnect(t *testing.T) {
	s := testService(defaultCfg())
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	s.newCaster = func(addr string, port int) (caster, error) {
		once.Do(func() { close(started) })
		<-release
		return &raceCaster{}, nil
	}
	s.setDevices([]Device{{UUID: "a", Name: "A", Addr: "a", Port: 8009}})

	go func() { s.SelectDevice("a", 5*time.Second) }() // long timeout: stays in flight
	<-started                                          // connect attempt is in flight

	if ok, reason := s.SelectDevice("a", 50*time.Millisecond); ok || reason != "busy" {
		t.Fatalf("concurrent select during in-flight connect: ok=%v reason=%q; want false/busy", ok, reason)
	}
	close(release)                    // let the in-flight connect finish
	time.Sleep(20 * time.Millisecond) // allow it to complete before the test returns
}

// TestSelectDevice_HungConnectReleasesSelecting guards the wedge fix: a connect
// that hangs past the timeout must NOT pin `selecting` forever (which previously
// caused a permanent 409 "busy" storm). After the timeout a later select proceeds
// normally, and the orphaned connection is closed — never stored.
func TestSelectDevice_HungConnectReleasesSelecting(t *testing.T) {
	s := testService(defaultCfg())
	release := make(chan struct{})
	orphan := &closeSignalCaster{closed: make(chan struct{})}
	good := &raceCaster{}
	var mu sync.Mutex
	var calls int
	s.newCaster = func(addr string, port int) (caster, error) {
		mu.Lock()
		calls++
		first := calls == 1
		mu.Unlock()
		if first {
			<-release // first attempt hangs until released
			return orphan, nil
		}
		return good, nil
	}
	s.setDevices([]Device{{UUID: "a", Name: "A", Addr: "a", Port: 8009}})

	// First select hangs and times out; `selecting` must be released afterwards.
	if ok, reason := s.SelectDevice("a", 50*time.Millisecond); ok || reason != "failed" {
		t.Fatalf("hung select should return (false, failed), got (%v, %q)", ok, reason)
	}
	// A later select must NOT be stuck on "busy" — it should connect normally.
	if ok, reason := s.SelectDevice("a", 2*time.Second); !ok || reason != "" {
		t.Fatalf("select after a hung attempt should succeed, got (%v, %q)", ok, reason)
	}
	s.mu.Lock()
	gotApp := s.app
	s.mu.Unlock()
	if gotApp != caster(good) {
		t.Fatal("active connection should be the new one, not the orphan")
	}

	// Release the orphaned first attempt; it must be closed, never stored.
	close(release)
	select {
	case <-orphan.closed:
	case <-time.After(time.Second):
		t.Fatal("orphaned (timed-out) connection should be closed when it finally returns")
	}
	s.mu.Lock()
	stillGood := s.app
	s.mu.Unlock()
	if stillGood != caster(good) {
		t.Fatal("orphan must not replace the active connection")
	}
}

// TestGetStatus_HungUpdateDropsAndFreesLock guards the core wedge fix: when
// Update() hangs (a vanished device's half-open socket), GetStatus must not block
// forever — it times out, drops the connection, and breaks it off-lock so appMu
// is freed and subsequent calls return immediately.
func TestGetStatus_HungUpdateDropsAndFreesLock(t *testing.T) {
	s := testService(defaultCfg())
	s.cfg.StatusUpdateTimeout = 80 * time.Millisecond
	hc := newHangingCaster()
	s.mu.Lock()
	s.app = hc
	s.selected = "x"
	s.lastName = "TV"
	s.mu.Unlock()

	statusDone := make(chan map[string]any, 1)
	go func() { statusDone <- s.GetStatus() }()
	select {
	case st := <-statusDone:
		if st["status"] != "disconnected" {
			t.Fatalf("hung Update should yield disconnected, got %v", st["status"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("GetStatus blocked on a hung Update — timeout/appMu fix not working")
	}

	s.mu.Lock()
	app := s.app
	s.mu.Unlock()
	if app != nil {
		t.Fatal("hung connection should be dropped (s.app == nil)")
	}

	// The hung Update must have been broken via Close (which frees appMu).
	select {
	case <-hc.closed:
	case <-time.After(time.Second):
		t.Fatal("hung connection was not closed to free appMu")
	}
	if st := s.GetStatus(); st["status"] != "disconnected" {
		t.Fatalf("after drop GetStatus should be disconnected, got %v", st["status"])
	}
}

// TestSelectDevice_CooldownAfterFailure guards the anti-hammer fix: after a
// connect fails, the device is benched for ConnectCooldown, so the UI's retries
// fail fast ("cooldown") WITHOUT opening another connection to the (flaky) box.
func TestSelectDevice_CooldownAfterFailure(t *testing.T) {
	cfg := defaultCfg()
	cfg.ConnectCooldown = time.Minute
	s := testService(cfg)
	var mu sync.Mutex
	var calls int
	s.newCaster = func(addr string, port int) (caster, error) {
		mu.Lock()
		calls++
		mu.Unlock()
		return nil, errors.New("unreachable")
	}
	s.setDevices([]Device{{UUID: "a", Name: "A", Addr: "a", Port: 8009}})

	// First select fails and benches the device.
	if ok, reason := s.SelectDevice("a", time.Second); ok || reason != "failed" {
		t.Fatalf("first select: got (%v,%q), want (false,failed)", ok, reason)
	}
	// A select within the cooldown fails fast without touching the device again.
	if ok, reason := s.SelectDevice("a", time.Second); ok || reason != "cooldown" {
		t.Fatalf("second select: got (%v,%q), want (false,cooldown)", ok, reason)
	}
	mu.Lock()
	n := calls
	mu.Unlock()
	if n != 1 {
		t.Fatalf("newCaster called %d times; cooldown should have blocked the 2nd connect", n)
	}
}

// TestSelectDevice_CooldownClearedOnSuccess: a successful connect un-benches the
// device so a later legitimate re-select isn't blocked.
func TestSelectDevice_CooldownClearedOnSuccess(t *testing.T) {
	cfg := defaultCfg()
	cfg.ConnectCooldown = time.Minute
	s := testService(cfg)
	fail := true
	var mu sync.Mutex
	s.newCaster = func(addr string, port int) (caster, error) {
		mu.Lock()
		f := fail
		mu.Unlock()
		if f {
			return nil, errors.New("unreachable")
		}
		return &raceCaster{}, nil
	}
	s.setDevices([]Device{{UUID: "a", Name: "A", Addr: "a", Port: 8009}})

	s.SelectDevice("a", time.Second) // fails -> benched
	mu.Lock()
	fail = false
	mu.Unlock()
	// Still benched -> cooldown, even though the device would now connect.
	if ok, reason := s.SelectDevice("a", time.Second); ok || reason != "cooldown" {
		t.Fatalf("benched select: got (%v,%q), want (false,cooldown)", ok, reason)
	}
	// Clear the bench (as a recovered device or expiry would) and reconnect.
	s.mu.Lock()
	delete(s.connectCooldownUntil, "a")
	s.mu.Unlock()
	if ok, reason := s.SelectDevice("a", time.Second); !ok || reason != "" {
		t.Fatalf("post-cooldown select: got (%v,%q), want success", ok, reason)
	}
	s.mu.Lock()
	_, stillBenched := s.connectCooldownUntil["a"]
	s.mu.Unlock()
	if stillBenched {
		t.Fatal("a successful connect must clear the cooldown bench")
	}
}

// closeSignalCaster signals via a channel when Close is called, so tests can wait
// for an async close without racing on a bool.
type closeSignalCaster struct {
	closed chan struct{}
	once   sync.Once
}

func (c *closeSignalCaster) Load(string, int, string, bool, bool, bool) error { return nil }
func (c *closeSignalCaster) Pause() error                                     { return nil }
func (c *closeSignalCaster) Unpause() error                                   { return nil }
func (c *closeSignalCaster) SetVolume(float32) error                          { return nil }
func (c *closeSignalCaster) SeekToTime(float32) error                         { return nil }
func (c *closeSignalCaster) Update() error                                    { return nil }
func (c *closeSignalCaster) Status() (*gccast.Application, *gccast.Media, *gccast.Volume) {
	return nil, nil, nil
}
func (c *closeSignalCaster) Close(bool) error { c.once.Do(func() { close(c.closed) }); return nil }

// hangingCaster blocks in Update() until Close() is called — modelling a vanished
// device whose wedged call only unblocks when the socket is closed.
type hangingCaster struct {
	unblock chan struct{}
	closed  chan struct{}
	once    sync.Once
}

func newHangingCaster() *hangingCaster {
	return &hangingCaster{unblock: make(chan struct{}), closed: make(chan struct{})}
}

func (c *hangingCaster) Load(string, int, string, bool, bool, bool) error { return nil }
func (c *hangingCaster) Pause() error                                     { return nil }
func (c *hangingCaster) Unpause() error                                   { return nil }
func (c *hangingCaster) SetVolume(float32) error                          { return nil }
func (c *hangingCaster) SeekToTime(float32) error                         { return nil }
func (c *hangingCaster) Update() error                                    { <-c.unblock; return errors.New("connection closed") }
func (c *hangingCaster) Status() (*gccast.Application, *gccast.Media, *gccast.Volume) {
	return nil, nil, nil
}
func (c *hangingCaster) Close(bool) error {
	c.once.Do(func() { close(c.unblock); close(c.closed) })
	return nil
}
