import threading
import time
from types import SimpleNamespace

from services.chromecast_service import ChromecastService


class FakeCast:
    def __init__(self, uuid="device-1", friendly_name="Living Room TV", release_event=None):
        self.uuid = uuid
        self.cast_info = SimpleNamespace(friendly_name=friendly_name)
        self.media_controller = SimpleNamespace()
        self._release_event = release_event or threading.Event()

    def wait(self, timeout=None):
        if not self._release_event.wait(timeout=timeout):
            raise TimeoutError("Timed out waiting for fake cast")


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
