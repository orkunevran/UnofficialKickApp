import pychromecast
import threading
import logging
import time
import traceback
import zeroconf
from concurrent.futures import ThreadPoolExecutor
from pychromecast.discovery import CastBrowser, SimpleCastListener
from pychromecast.socket_client import ConnectionStatus

logger = logging.getLogger(__name__)


class ChromecastService:
    def __init__(self):
        self.chromecasts = []
        self.selected_cast = None
        self.media_controller = None
        self._lock = threading.Lock()
        self._connection_failure_counts = {}
        self._registered_uuids = set()
        self._browser = None
        self._zc = None  # Long-lived: created once, reused across scans
        self._cast_listener = None
        self._last_scan_time = 0
        self._disconnect_in_progress = set()  # Guard against duplicate disconnect threads

        # Separate executors: scan and select don't block each other
        self._scan_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cc-scan")
        self._select_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cc-select")
        self._scan_future = None  # Track in-flight background scan
        # _scanning and _selecting are ALWAYS read/written under self._lock to prevent
        # check-then-set races across concurrent Flask request threads.
        self._scanning = False
        self._selecting = False
        self._shutdown_event = threading.Event()  # Signals _do_scan to abort early on shutdown

        # Config defaults (overridden by configure())
        self._scan_timeout = 5
        self._select_max_retries = 2
        self._select_retry_delay = 2
        self._max_connection_failures = 3
        self._device_cache_seconds = 30
        self._stop_wait_seconds = 2.0
        self._last_device_uuid = None   # Remembered across stop/disconnect for reconnect UX
        self._last_device_name = None

    def configure(self, config):
        """Apply configuration from Flask app config."""
        self._scan_timeout = config.get('CHROMECAST_SCAN_TIMEOUT', 5)
        self._select_max_retries = config.get('CHROMECAST_SELECT_MAX_RETRIES', 2)
        self._select_retry_delay = config.get('CHROMECAST_SELECT_RETRY_DELAY', 2)
        self._max_connection_failures = config.get('CHROMECAST_MAX_CONNECTION_FAILURES', 3)
        self._device_cache_seconds = config.get('CHROMECAST_DEVICE_CACHE_SECONDS', 30)
        self._stop_wait_seconds = config.get('CHROMECAST_STOP_WAIT_SECONDS', 2.0)
        logger.info("ChromecastService configured with app settings.")

    def shutdown(self):
        """Clean up resources on app shutdown."""
        logger.info("Shutting down ChromecastService...")

        # Signal any running _do_scan to abort its sleep/work early
        self._shutdown_event.set()

        # Wait for executors to drain (scan has up to scan_timeout seconds remaining)
        self._scan_executor.shutdown(wait=True, cancel_futures=True)
        self._select_executor.shutdown(wait=False, cancel_futures=True)

        if self._browser:
            try:
                self._browser.stop_discovery()
                logger.info("Browser discovery stopped.")
            except Exception as e:
                logger.error(f"Error stopping browser discovery: {e}")
            self._browser = None
        if self._zc:
            try:
                self._zc.close()
                logger.info("Zeroconf instance closed.")
            except Exception as e:
                logger.error(f"Error closing zeroconf: {e}")
            self._zc = None

        with self._lock:
            if self.selected_cast:
                try:
                    self.selected_cast.disconnect()
                except Exception:
                    pass
                self.selected_cast = None
                self.media_controller = None
        logger.info("ChromecastService shutdown complete.")



    def _do_scan(self):
        """Internal blocking scan implementation.

        Note: self._scanning is set to True by the CALLER (scan_for_devices_async
        or scan_for_devices) before this method runs, to avoid a race where a
        select request slips through before the executor thread starts.
        """
        # Clear the shutdown event so that _shutdown_event.wait() inside this run
        # acts as a fresh interruptible sleep.  (If a previous shutdown cycle already
        # set it and the service was restarted without recreating the instance, the
        # event would remain set and the scan sleep would skip instantly.)
        self._shutdown_event.clear()
        logger.info("Scanning for Chromecast devices...")
        try:
            # Stop previous browser and zeroconf completely.
            # CastBrowser.stop_discovery() closes its zeroconf internally,
            # so we can't share a zeroconf across scan cycles.
            if self._browser:
                try:
                    self._browser.stop_discovery()
                except Exception:
                    pass
                self._browser = None
            if self._zc:
                try:
                    self._zc.close()
                except Exception:
                    pass
                self._zc = None

            # Fresh zeroconf + browser for each scan
            self._zc = zeroconf.Zeroconf(interfaces=zeroconf.InterfaceChoice.Default)

            discovered_casts = {}
            class _Listener(SimpleCastListener):
                def add_cast(self, uuid, service):
                    discovered_casts[uuid] = service
                def remove_cast(self, uuid, service, cast_info):
                    pass
                def update_cast(self, uuid, service):
                    pass

            self._cast_listener = _Listener()
            self._browser = CastBrowser(self._cast_listener, zeroconf_instance=self._zc)
            self._browser.start_discovery()
            # Use _shutdown_event.wait() instead of time.sleep() so shutdown()
            # can interrupt the scan immediately rather than waiting the full timeout.
            self._shutdown_event.wait(timeout=self._scan_timeout)
            if self._shutdown_event.is_set():
                logger.info("Scan aborted early due to shutdown signal.")
                return

            # Build fresh cast objects (bound to the new zeroconf instance)
            discovered_chromecasts = []
            for uuid, service in discovered_casts.items():
                try:
                    cast_info = self._browser.devices.get(uuid)
                    if cast_info:
                        cast = pychromecast.get_chromecast_from_cast_info(cast_info, self._zc)
                        discovered_chromecasts.append(cast)
                except Exception as e:
                    logger.warning(f"Failed to create cast for UUID {uuid}: {e}")

            self._last_scan_time = time.time()

            # Determine which casts need a new listener BEFORE acquiring the lock,
            # then register them OUTSIDE the lock.
            #
            # BUG FIX: pychromecast fires the current connection status synchronously
            # to every newly registered listener.  Our listener callback
            # (_handle_connection_status) tries to acquire self._lock, so calling
            # register_connection_listener while already holding self._lock would
            # deadlock.  Collecting the list under the lock and registering outside
            # it is the correct pattern.
            to_register = []
            with self._lock:
                self.chromecasts = discovered_chromecasts
                current_uuids = set()
                for cast in self.chromecasts:
                    device_uuid = str(cast.uuid)
                    current_uuids.add(device_uuid)
                    if device_uuid not in self._registered_uuids:
                        to_register.append(cast)
                        self._registered_uuids.add(device_uuid)
                    if device_uuid not in self._connection_failure_counts:
                        self._connection_failure_counts[device_uuid] = 0

                # Clean stale UUIDs that disappeared from scan
                stale = self._registered_uuids - current_uuids
                self._registered_uuids -= stale

            # Register connection listeners OUTSIDE the lock (see comment above)
            for cast in to_register:
                listener = ChromecastConnectionListener(self, cast)
                cast.register_connection_listener(listener)

            logger.info(f"Discovery scan finished. Found {len(self.chromecasts)} devices.")
        except pychromecast.error.NoChromecastFoundError:
            logger.info("No Chromecast devices found in this scan.")
            self._last_scan_time = time.time()
            with self._lock:
                self.chromecasts = []
        except Exception as e:
            logger.error(f"An error occurred during Chromecast discovery: {e}")
        finally:
            with self._lock:
                self._scanning = False

    def scan_for_devices_async(self, force=False):
        """Non-blocking scan: returns cached devices immediately, triggers background refresh.

        Returns True if a background scan was kicked off, False if cache is fresh.
        """
        if not force and (time.time() - self._last_scan_time) < self._device_cache_seconds:
            logger.debug("Using cached device list (within TTL).")
            return False

        # Check-and-set _scanning atomically under the lock to prevent two concurrent
        # Flask request threads from each seeing _scanning=False and both submitting scans.
        with self._lock:
            if self._scanning or (self._scan_future and not self._scan_future.done()):
                logger.debug("Background scan already in progress, skipping.")
                return False
            # Set flag before submit so select_device_with_timeout sees it immediately.
            self._scanning = True

        logger.info("Submitting background device scan...")
        self._scan_future = self._scan_executor.submit(self._do_scan)
        return True

    def is_scanning(self):
        """Returns True if a background scan is currently in progress."""
        return self._scanning

    def get_devices(self):
        devices_list = []
        with self._lock:
            for cc in self.chromecasts:
                device_info = {'name': cc.cast_info.friendly_name, 'uuid': str(cc.uuid)}
                devices_list.append(device_info)
        return devices_list

    def select_device(self, uuid, per_attempt_timeout=None):
        with self._lock:
            cast = next((cc for cc in self.chromecasts if str(cc.uuid) == uuid), None)

        if not cast:
            logger.warning(f"Chromecast with UUID {uuid} not found in the current list.")
            return False

        for attempt in range(1, self._select_max_retries + 1):
            try:
                logger.info(f"Attempt {attempt}/{self._select_max_retries}: Connecting to device {cast.cast_info.friendly_name}...")
                # Pass a per-attempt timeout so the executor thread never blocks forever.
                # Without this, future.cancel() after the outer timeout fires is a no-op on
                # a running future, leaving the single-worker _select_executor permanently
                # occupied and blocking all future select requests.
                cast.wait(timeout=per_attempt_timeout)
                with self._lock:
                    self.selected_cast = cast
                    self.media_controller = cast.media_controller
                    # Remember last connected device so the frontend can offer a one-click reconnect
                    self._last_device_uuid = str(cast.uuid)
                    self._last_device_name = cast.cast_info.friendly_name
                logger.info(f"Successfully selected Chromecast device: {cast.cast_info.friendly_name}")
                return True
            except Exception as e:
                logger.error(f"Failed to connect to device {cast.cast_info.friendly_name} on attempt {attempt}: {e}")
                if attempt < self._select_max_retries:
                    logger.info(f"Retrying in {self._select_retry_delay} seconds...")
                    time.sleep(self._select_retry_delay)
                else:
                    logger.error(f"All {self._select_max_retries} attempts failed for device {cast.cast_info.friendly_name}.")
                    with self._lock:
                        self.selected_cast = None
                        self.media_controller = None
                    return False
        return False

    def select_device_with_timeout(self, uuid, timeout=15):
        """Select a device with a hard timeout. Runs select_device in dedicated thread.

        Returns:
            (True, None) if connected
            (False, 'scanning') if a scan is in progress
            (False, 'busy') if another select is in progress
            (False, 'failed') if connection failed or timed out
        """
        # Atomically check and set _scanning / _selecting under self._lock.
        # Without the lock, two simultaneous Flask request threads can both read
        # _selecting=False and both proceed, causing duplicate connection attempts.
        with self._lock:
            if self._scanning:
                logger.warning("Cannot select device while scan is in progress.")
                return False, 'scanning'
            if self._selecting:
                logger.warning("Another device selection is already in progress, ignoring duplicate request.")
                return False, 'busy'
            self._selecting = True

        # Distribute the outer timeout across retry attempts, leaving 1s headroom
        # for overhead so the executor thread always finishes before the outer timeout.
        per_attempt_timeout = max(1.0, (timeout - 1) / max(self._select_max_retries, 1))
        try:
            future = self._select_executor.submit(self.select_device, uuid, per_attempt_timeout)
            try:
                result = future.result(timeout=timeout)
                return result, None if result else 'failed'
            except Exception as e:
                logger.error(f"select_device timed out or failed after {timeout}s: {e}")
                future.cancel()
                return False, 'failed'
        finally:
            with self._lock:
                self._selecting = False

    def cast_stream(self, stream_url, title="Kick Stream"):
        with self._lock:
            selected = self.selected_cast
            mc = self.media_controller

        if not selected or not mc:
            logger.error("No Chromecast device selected.")
            return False

        try:
            mc_status = mc.status if mc else None
            if mc_status and (mc_status.player_is_playing or mc_status.player_is_paused):
                logger.info("Stopping existing media before casting new stream...")
                mc.stop()
                # Poll for stop instead of blind sleep
                deadline = time.time() + self._stop_wait_seconds
                while time.time() < deadline:
                    time.sleep(0.25)
                    s = mc.status
                    if s and not s.player_is_playing and not s.player_is_paused:
                        break

            content_type = 'application/x-mpegurl'
            logger.info(f"Sending play_media command for '{title}' to {selected.cast_info.friendly_name}")
            mc.play_media(stream_url, content_type, title=title)
            logger.info("play_media command sent successfully.")
            return True

        except pychromecast.PyChromecastError as e:
            logger.error(f"PyChromecast error during casting: {e}")
            return False
        except Exception as e:
            logger.error(f"An unexpected error occurred during casting: {e}\n{traceback.format_exc()}")
            return False

    def stop_cast(self, uuid=None):
        """
        Stops media playback and/or disconnects a Chromecast device.
        """
        target_cast = None
        if uuid:
            with self._lock:
                target_cast = next((cc for cc in self.chromecasts if str(cc.uuid) == uuid), None)
            if not target_cast:
                logger.warning(f"Chromecast with UUID {uuid} not found for stopping/disconnecting.")
                return False
        else:
            with self._lock:
                target_cast = self.selected_cast

        if not target_cast:
            logger.info("No Chromecast device selected or specified to stop/disconnect.")
            return False

        # Snapshot state under lock
        with self._lock:
            is_selected = target_cast == self.selected_cast
            mc = self.media_controller if is_selected else None

        # Null-safe media status check
        mc_status = mc.status if mc else None
        if is_selected and mc and mc_status and mc_status.player_is_playing:
            logger.info("Stopping cast media playback...")
            # Run mc.stop() in a thread so we can cap it at 3s instead of
            # pychromecast's default 10s blocking timeout.
            _stop_done = threading.Event()
            _stop_err = [None]
            def _do_stop_media():
                try:
                    mc.stop()
                except Exception as e:
                    _stop_err[0] = e
                finally:
                    _stop_done.set()
            _t = threading.Thread(target=_do_stop_media, daemon=True)
            _t.start()
            if not _stop_done.wait(timeout=3.0):
                logger.warning(f"Stop timed out for {target_cast.cast_info.friendly_name} after 3s. Proceeding to disconnect.")
            elif _stop_err[0]:
                logger.error(f"Error stopping media on {target_cast.cast_info.friendly_name}: {_stop_err[0]}")
            else:
                logger.info("Cast media playback stopped.")
        else:
            logger.info(f"No active media cast to stop on {target_cast.cast_info.friendly_name}.")

        logger.info(f"Attempting to disconnect from Chromecast: {target_cast.cast_info.friendly_name}")
        try:
            # Guard: only disconnect if the socket client thread was actually started
            # "cannot join thread before it is started" happens when cast.wait() was never called
            sc = getattr(target_cast, 'socket_client', None)
            if sc and hasattr(sc, 'is_alive') and sc.is_alive():
                target_cast.disconnect()
                logger.info(f"Disconnected from Chromecast: {target_cast.cast_info.friendly_name}")
            else:
                logger.info(f"Skipping disconnect for {target_cast.cast_info.friendly_name} (socket thread not started).")
        except Exception as e:
            logger.error(f"Error disconnecting from Chromecast {target_cast.cast_info.friendly_name}: {e}")
        finally:
            with self._lock:
                if target_cast == self.selected_cast:
                    self.selected_cast = None
                    self.media_controller = None
                device_uuid = str(target_cast.uuid)
                if device_uuid in self._connection_failure_counts:
                    del self._connection_failure_counts[device_uuid]
                self._registered_uuids.discard(device_uuid)
                self._disconnect_in_progress.discard(device_uuid)
        return True

    def get_status(self):
        with self._lock:
            selected = self.selected_cast
            mc = self.media_controller

        if not selected:
            return {'status': 'disconnected'}

        # Null-safe status access
        mc_status = mc.status if mc else None
        return {
            'status': 'connected',
            'device_name': selected.cast_info.friendly_name,
            'is_playing': mc_status.player_is_playing if mc_status else False
        }

    def get_last_device(self):
        """Returns the last successfully selected device {uuid, name}, or None."""
        with self._lock:
            if self._last_device_uuid and self._last_device_name:
                return {'uuid': self._last_device_uuid, 'name': self._last_device_name}
        return None

    def _handle_connection_status(self, cast, status: ConnectionStatus):
        """Handles Chromecast connection status changes."""
        device_uuid = str(cast.uuid)
        logger.info(f"Connection handler for {cast.cast_info.friendly_name} ({device_uuid}): Status changed to {status.status}")

        if status.status == "DISCONNECTED" or status.status == "FAILED":
            logger.warning(f"Chromecast {cast.cast_info.friendly_name} ({device_uuid}) disconnected or connection failed.")
            with self._lock:
                self._connection_failure_counts[device_uuid] = self._connection_failure_counts.get(device_uuid, 0) + 1
                current_failures = self._connection_failure_counts[device_uuid]

            logger.warning(f"Connection failures for {cast.cast_info.friendly_name} ({device_uuid}): {current_failures}")

            if current_failures >= self._max_connection_failures:
                # Guard against duplicate disconnect threads for same device
                with self._lock:
                    if device_uuid in self._disconnect_in_progress:
                        logger.info(f"Disconnect already in progress for {device_uuid}, skipping.")
                        return
                    self._disconnect_in_progress.add(device_uuid)
                    self._connection_failure_counts[device_uuid] = 0

                logger.error(f"Chromecast {cast.cast_info.friendly_name} ({device_uuid}) failed to reconnect {self._max_connection_failures} times. Triggering disconnection.")

                def do_stop():
                    try:
                        self.stop_cast(device_uuid)
                        logger.info(f"Successfully stopped/disconnected device {device_uuid} after repeated failures.")
                    except Exception as e:
                        logger.error(f"Failed to stop device {device_uuid}: {e}")
                        with self._lock:
                            self._disconnect_in_progress.discard(device_uuid)

                thread = threading.Thread(target=do_stop, daemon=True)
                thread.start()

        elif status.status == "CONNECTED":
            logger.info(f"Chromecast {cast.cast_info.friendly_name} ({device_uuid}) reconnected successfully. Resetting failure count.")
            with self._lock:
                self._connection_failure_counts[device_uuid] = 0


class ChromecastConnectionListener:
    def __init__(self, service_instance, cast):
        self.service_instance = service_instance
        self.cast = cast

    def new_connection_status(self, status: ConnectionStatus):
        self.service_instance._handle_connection_status(self.cast, status)


# Singleton instance
chromecast_service = ChromecastService()
