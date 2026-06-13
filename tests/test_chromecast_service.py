import ipaddress
import threading
import time
from types import SimpleNamespace
from uuid import UUID

import services.chromecast_service as chromecast_module
from services.chromecast_service import ChromecastService


class FakeCast:
    def __init__(self, uuid="device-1", friendly_name="Living Room TV", release_event=None):
        self.uuid = uuid
        self.cast_info = SimpleNamespace(friendly_name=friendly_name, host="192.168.1.2")
        self.media_controller = SimpleNamespace()
        self._release_event = release_event or threading.Event()
        self.listener = None

    def wait(self, timeout=None):
        if not self._release_event.wait(timeout=timeout):
            raise TimeoutError("Timed out waiting for fake cast")

    def register_connection_listener(self, listener):
        self.listener = listener

    def disconnect(self):
        return None


def test_scan_for_devices_async_allows_only_one_inflight_scan():
    service = ChromecastService()
    release_event = threading.Event()
    started_event = threading.Event()

    def fake_do_scan():
        started_event.set()
        try:
            release_event.wait(timeout=5)
        finally:
            with service._lock:
                service._scanning = False

    service._do_scan = fake_do_scan

    try:
        assert service.scan_for_devices_async(force=True) is True
        assert service.scan_for_devices_async(force=True) is False
        assert started_event.wait(timeout=1)

        release_event.set()
        service._scan_future.result(timeout=2)
    finally:
        service.shutdown()


def test_scan_for_devices_async_forwards_known_hosts():
    service = ChromecastService()
    started_event = threading.Event()
    seen = {}

    def fake_do_scan(known_hosts=None):
        seen["known_hosts"] = known_hosts
        started_event.set()
        with service._lock:
            service._scanning = False

    service._do_scan = fake_do_scan

    try:
        assert service.scan_for_devices_async(force=True, known_hosts=["192.168.1.10"]) is True
        assert started_event.wait(timeout=1)
        service._scan_future.result(timeout=2)
        assert seen["known_hosts"] == ["192.168.1.10"]
    finally:
        service.shutdown()


def test_private_network_scan_discovers_host_based_cast(monkeypatch):
    service = ChromecastService()
    service._zc = SimpleNamespace()  # Provide a non-None zeroconf stub
    service._fallback_scan_networks = [ipaddress.ip_network("192.168.1.2/32")]
    service._fallback_scan_workers = 1
    service._fallback_scan_probe_timeout = 0.01
    service._fallback_device_info_timeout = 0.01

    build_calls = []
    device_status = SimpleNamespace(
        friendly_name="Xiaomi TV Kutusu",
        model_name="MiTV-AFKR0",
        manufacturer="Xiaomi",
        uuid=UUID("fdf7fa41-9621-6e9d-6f91-1b8f2525cd46"),
        cast_type="cast",
    )

    monkeypatch.setattr(service, "_detect_local_subnet", lambda: service._fallback_scan_networks)
    monkeypatch.setattr(service, "_probe_host_for_chromecast", lambda host: host == "192.168.1.2")
    monkeypatch.setattr(chromecast_module, "get_device_info", lambda host, timeout=3.0, context=None: device_status if host == "192.168.1.2" else None)

    def fake_builder(cast_info, zconf, tries=None, retry_wait=None, timeout=None):
        build_calls.append((cast_info.host, cast_info.friendly_name, cast_info.uuid))
        return FakeCast(uuid=str(cast_info.uuid), friendly_name=cast_info.friendly_name)

    monkeypatch.setattr(chromecast_module.pychromecast, "get_chromecast_from_cast_info", fake_builder)

    try:
        discovered = service._scan_private_networks_for_chromecasts()
        assert len(discovered) == 1
        assert discovered[0].cast_info.friendly_name == "Xiaomi TV Kutusu"
        assert build_calls == [("192.168.1.2", "Xiaomi TV Kutusu", device_status.uuid)]
    finally:
        service.shutdown()


def test_do_scan_uses_network_fallback_when_mdns_returns_no_devices(monkeypatch):
    service = ChromecastService()
    service._scan_timeout = 0
    fallback_cast = FakeCast(uuid="fallback-1", friendly_name="Fallback TV")

    class DummyZeroconf:
        def close(self):
            return None

    class DummyBrowser:
        def __init__(self, *args, **kwargs):
            self.devices = {}

        def start_discovery(self):
            return None

        def stop_discovery(self):
            return None

    monkeypatch.setattr(chromecast_module.zeroconf, "Zeroconf", lambda interfaces=None: DummyZeroconf())
    monkeypatch.setattr(chromecast_module, "CastBrowser", DummyBrowser)
    monkeypatch.setattr(service, "_scan_private_networks_for_chromecasts", lambda: [fallback_cast])

    try:
        service._do_scan()
        assert service.chromecasts == [fallback_cast]
        assert fallback_cast.listener is not None
        assert service.get_devices() == [{"name": "Fallback TV", "uuid": "fallback-1"}]
    finally:
        service.shutdown()


def test_select_device_with_timeout_rejects_duplicate_requests():
    service = ChromecastService()
    release_event = threading.Event()
    fake_cast = FakeCast(release_event=release_event)
    service.chromecasts = [fake_cast]
    service._select_max_retries = 1

    results = []

    def select_device():
        results.append(service.select_device_with_timeout("device-1", timeout=5))

    worker = threading.Thread(target=select_device)
    worker.start()

    deadline = time.time() + 1
    while not service._selecting and time.time() < deadline:
        time.sleep(0.01)

    assert service._selecting is True
    assert service.select_device_with_timeout("device-1", timeout=1) == (False, "busy")

    release_event.set()
    worker.join(timeout=2)

    assert results == [(True, None)]
    assert service.selected_cast is fake_cast

    service.shutdown()


def test_shutdown_drains_background_scan():
    service = ChromecastService()
    finished_event = threading.Event()

    def fake_do_scan():
        try:
            service._shutdown_event.wait(timeout=5)
        finally:
            finished_event.set()
            with service._lock:
                service._scanning = False

    service._do_scan = fake_do_scan

    assert service.scan_for_devices_async(force=True) is True

    start = time.monotonic()
    service.shutdown()
    elapsed = time.monotonic() - start

    assert finished_event.is_set()
    assert elapsed < 2.0


def test_chromecast_playback_controls():
    service = ChromecastService()
    fake_cast = FakeCast()
    fake_cast.status = SimpleNamespace(volume_level=0.5)
    
    def fake_set_volume(level):
        fake_cast.status.volume_level = level
    fake_cast.set_volume = fake_set_volume

    play_called = False
    pause_called = False

    def fake_play():
        nonlocal play_called
        play_called = True

    def fake_pause():
        nonlocal pause_called
        pause_called = True

    fake_cast.media_controller.play = fake_play
    fake_cast.media_controller.pause = fake_pause

    service.selected_cast = fake_cast
    service.media_controller = fake_cast.media_controller

    assert service.play_media() is True
    assert play_called is True

    assert service.pause_media() is True
    assert pause_called is True

    # Test volume
    assert service.set_volume(0.8) is True
    assert fake_cast.status.volume_level == 0.8

    # Test clamping
    assert service.set_volume(1.5) is True
    assert fake_cast.status.volume_level == 1.0

    assert service.set_volume(-0.5) is True
    assert fake_cast.status.volume_level == 0.0

    # Test seek
    seek_pos = -1
    def fake_seek(pos):
        nonlocal seek_pos
        seek_pos = pos
    fake_cast.media_controller.seek = fake_seek

    assert service.seek_media(45.5) is True
    assert seek_pos == 45.5

    # Test status payload duration/current_time updates
    fake_cast.media_controller.status = SimpleNamespace(
        player_is_playing=True,
        duration=120.0,
        adjusted_current_time=34.2
    )
    status = service.get_status()
    assert status['duration'] == 120.0
    assert status['current_time'] == 34.2

    service.shutdown()
