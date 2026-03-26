import ipaddress
import logging
import re
import socket
import ssl
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed

import pychromecast
import zeroconf
from pychromecast.dial import get_device_info
from pychromecast.discovery import CastBrowser, SimpleCastListener
from pychromecast.models import CastInfo
from pychromecast.socket_client import ConnectionStatus

# pychromecast API changed across versions:
#   Python 3.11+ / newer pychromecast: HostServiceInfo(host, port) dataclass in models
#   Python 3.9  / older pychromecast:  ServiceInfo("host", (host, port)) namedtuple in models
try:
    from pychromecast.models import HostServiceInfo as _HostServiceInfo
    _HOST_SERVICE_NEW_API = True
except ImportError:
    from pychromecast.models import ServiceInfo as _HostServiceInfo
    _HOST_SERVICE_NEW_API = False

logger = logging.getLogger(__name__)

DEFAULT_FALLBACK_SCAN_SUBNETS = "192.168.0.0/24,192.168.1.0/24,192.168.2.0/24"
DEFAULT_FALLBACK_SCAN_WORKERS = 32
DEFAULT_FALLBACK_SCAN_PROBE_TIMEOUT = 0.5
DEFAULT_FALLBACK_DEVICE_INFO_TIMEOUT = 3.0


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
        # check-then-set races across concurrent request threads.
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
        self._fallback_scan_enabled = True
        self._fallback_scan_networks = self._parse_fallback_scan_networks(DEFAULT_FALLBACK_SCAN_SUBNETS)
        self._fallback_scan_workers = DEFAULT_FALLBACK_SCAN_WORKERS
        self._fallback_scan_probe_timeout = DEFAULT_FALLBACK_SCAN_PROBE_TIMEOUT
        self._fallback_device_info_timeout = DEFAULT_FALLBACK_DEVICE_INFO_TIMEOUT
        self._last_device_uuid = None   # Remembered across stop/disconnect for reconnect UX
        self._last_device_name = None

    def configure(self, config):
        """Apply configuration from a mapping of application settings."""
        self._scan_timeout = config.get('CHROMECAST_SCAN_TIMEOUT', 5)
        self._select_max_retries = config.get('CHROMECAST_SELECT_MAX_RETRIES', 2)
        self._select_retry_delay = config.get('CHROMECAST_SELECT_RETRY_DELAY', 2)
        self._max_connection_failures = config.get('CHROMECAST_MAX_CONNECTION_FAILURES', 3)
        self._device_cache_seconds = config.get('CHROMECAST_DEVICE_CACHE_SECONDS', 30)
        self._stop_wait_seconds = config.get('CHROMECAST_STOP_WAIT_SECONDS', 2.0)
        self._fallback_scan_enabled = config.get('CHROMECAST_FALLBACK_SCAN_ENABLED', True)
        self._fallback_scan_networks = self._parse_fallback_scan_networks(
            config.get('CHROMECAST_FALLBACK_SCAN_SUBNETS', DEFAULT_FALLBACK_SCAN_SUBNETS)
        )
        self._fallback_scan_workers = config.get('CHROMECAST_FALLBACK_SCAN_WORKERS', DEFAULT_FALLBACK_SCAN_WORKERS)
        self._fallback_scan_probe_timeout = config.get(
            'CHROMECAST_FALLBACK_SCAN_PROBE_TIMEOUT',
            DEFAULT_FALLBACK_SCAN_PROBE_TIMEOUT,
        )
        self._fallback_device_info_timeout = config.get(
            'CHROMECAST_FALLBACK_DEVICE_INFO_TIMEOUT',
            DEFAULT_FALLBACK_DEVICE_INFO_TIMEOUT,
        )
        logger.info("ChromecastService configured with app settings.")

    @staticmethod
    def _parse_fallback_scan_networks(raw_value):
        if not raw_value:
            return []
        if isinstance(raw_value, (list, tuple, set)):
            entries = raw_value
        else:
            entries = re.split(r"[,\s]+", str(raw_value))

        networks = []
        for entry in entries:
            value = str(entry).strip()
            if not value:
                continue
            try:
                networks.append(ipaddress.ip_network(value, strict=False))
            except ValueError:
                logger.warning("Ignoring invalid Chromecast fallback subnet: %s", value)
        return networks

    def _probe_host_for_chromecast(self, host):
        if self._shutdown_event.is_set():
            return False
        try:
            with socket.create_connection((host, 8009), timeout=self._fallback_scan_probe_timeout):
                return True
        except OSError:
            return False

    @staticmethod
    def _make_host_service_info(host):
        if _HOST_SERVICE_NEW_API:
            return _HostServiceInfo(host, 8009)
        return _HostServiceInfo("host", (host, 8009))

    def _build_host_chromecast(self, host, device_status):
        service_info = self._make_host_service_info(host)
        cast_info = CastInfo(
            {service_info},
            device_status.uuid,
            device_status.model_name,
            device_status.friendly_name,
            host,
            8009,
            device_status.cast_type,
            device_status.manufacturer,
        )
        return pychromecast.get_chromecast_from_cast_info(cast_info, self._zc)

    def _scan_private_networks_for_chromecasts(self):
        if not self._fallback_scan_enabled or not self._fallback_scan_networks or self._zc is None:
            return []

        candidate_hosts = []
        for network in self._fallback_scan_networks:
            candidate_hosts.extend(str(host) for host in network.hosts())

        if not candidate_hosts:
            return []

        logger.info(
            "mDNS discovery returned no Chromecast devices; probing %d host(s) across %d subnet(s) for port 8009.",
            len(candidate_hosts),
            len(self._fallback_scan_networks),
        )

        discovered_chromecasts = []
        seen_hosts = set()
        with ThreadPoolExecutor(max_workers=self._fallback_scan_workers, thread_name_prefix="cc-netscan") as executor:
            futures = {executor.submit(self._probe_host_for_chromecast, host): host for host in candidate_hosts}
            for future in as_completed(futures):
                if self._shutdown_event.is_set():
                    logger.info("Chromecast subnet probe aborted early due to shutdown signal.")
                    break

                host = futures[future]
                try:
                    if not future.result():
                        continue
                except Exception as e:
                    logger.debug("Chromecast probe failed for %s: %s", host, e)
                    continue

                if host in seen_hosts:
                    continue
                seen_hosts.add(host)

                try:
                    ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                    ssl_ctx.check_hostname = False
                    ssl_ctx.verify_mode = ssl.CERT_NONE
                    device_status = get_device_info(
                        host, timeout=self._fallback_device_info_timeout, context=ssl_ctx,
                    )
                except Exception as e:
                    logger.debug("Unable to fetch Chromecast status from %s: %s", host, e)
                    continue

                if not device_status or not getattr(device_status, "uuid", None):
                    continue

                try:
                    discovered_chromecasts.append(self._build_host_chromecast(host, device_status))
                except Exception as e:
                    logger.warning("Failed to create Chromecast object for %s: %s", host, e)

        return discovered_chromecasts

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
                logger.error("Error stopping browser discovery: %s", e)
            self._browser = None
        if self._zc:
            try:
                self._zc.close()
                logger.info("Zeroconf instance closed.")
            except Exception as e:
                logger.error("Error closing zeroconf: %s", e)
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



    def _do_scan(self, known_hosts=None):
        """Internal blocking scan implementation.

        Note: self._scanning is set to True by the CALLER (scan_for_devices_async
        or scan_for_devices) before this method runs, to avoid a race where a
        select request slips through before the executor thread starts.
        """
        # Clear the shutdown event so that _shutdown_event.wait() inside this run
        # acts as a fresh interruptible sleep.  (If a previous shutdown cycle already
        # set it and the service was restarted without recreating the instance, the
        # event would remain set and the scan sleep would skip instantly.)
        # Guard against a shutdown signal that arrived between executor.submit()
        # and this thread actually starting — clear only if shutdown hasn't been requested.
        if self._shutdown_event.is_set():
            logger.info("Scan aborted: shutdown was requested before scan started.")
            with self._lock:
                self._scanning = False
            return
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
            self._browser = CastBrowser(
                self._cast_listener,
                zeroconf_instance=self._zc,
                known_hosts=known_hosts,
            )
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
                    logger.warning("Failed to create cast for UUID %s: %s", uuid, e)

            if not discovered_chromecasts and known_hosts is None:
                fallback_chromecasts = self._scan_private_networks_for_chromecasts()
                if fallback_chromecasts:
                    discovered_chromecasts = fallback_chromecasts

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

            logger.info("Discovery scan finished. Found %s devices.", len(self.chromecasts))
        except pychromecast.error.NoChromecastFoundError:
            logger.info("No Chromecast devices found in this scan.")
            self._last_scan_time = time.time()
            with self._lock:
                self.chromecasts = []
        except Exception as e:
            logger.error("An error occurred during Chromecast discovery: %s", e)
        finally:
            with self._lock:
                self._scanning = False

    def scan_for_devices_async(self, force=False, known_hosts=None):
        """Non-blocking scan: returns cached devices immediately, triggers background refresh.

        Returns True if a background scan was kicked off, False if cache is fresh.
        """
        if not force and not known_hosts and (time.time() - self._last_scan_time) < self._device_cache_seconds:
            logger.debug("Using cached device list (within TTL).")
            return False

        # Check-and-set _scanning atomically under the lock to prevent two concurrent
        # request threads from each seeing _scanning=False and both submitting scans.
        with self._lock:
            if self._scanning or (self._scan_future and not self._scan_future.done()):
                logger.debug("Background scan already in progress, skipping.")
                return False
            # Set flag before submit so select_device_with_timeout sees it immediately.
            self._scanning = True

        logger.info("Submitting background device scan...")
        if known_hosts is None:
            self._scan_future = self._scan_executor.submit(self._do_scan)
        else:
            self._scan_future = self._scan_executor.submit(self._do_scan, known_hosts)
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
            logger.warning("Chromecast with UUID %s not found in the current list.", uuid)
            return False

        # If the cast's socket_client thread was already started and is now dead
        # (e.g. after a disconnect), we must create a fresh pychromecast object
        # because Python threads cannot be restarted.
        sc = getattr(cast, 'socket_client', None)
        if sc and hasattr(sc, '_started') and sc._started.is_set() and not sc.is_alive():
            logger.info("Replacing stale cast object for %s (dead socket thread).", cast.cast_info.friendly_name)
            try:
                new_cast = pychromecast.get_chromecast_from_cast_info(cast.cast_info, self._zc)
                with self._lock:
                    try:
                        idx = self.chromecasts.index(cast)
                        self.chromecasts[idx] = new_cast
                    except ValueError:
                        self.chromecasts.append(new_cast)
                cast = new_cast
            except Exception as e:
                logger.error("Failed to recreate cast object for %s: %s", cast.cast_info.friendly_name, e)
                return False

        for attempt in range(1, self._select_max_retries + 1):
            try:
                logger.info("Attempt %s/%s: Connecting to device %s...", attempt, self._select_max_retries, cast.cast_info.friendly_name)
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
                logger.info("Successfully selected Chromecast device: %s", cast.cast_info.friendly_name)
                return True
            except Exception as e:
                logger.error("Failed to connect to device %s on attempt %s: %s", cast.cast_info.friendly_name, attempt, e)
                if attempt < self._select_max_retries:
                    logger.info("Retrying in %s seconds...", self._select_retry_delay)
                    time.sleep(self._select_retry_delay)
                else:
                    logger.error("All %s attempts failed for device %s.", self._select_max_retries, cast.cast_info.friendly_name)
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
        # Without the lock, two simultaneous request threads can both read
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
                logger.error("select_device timed out or failed after %ss: %s", timeout, e)
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
            logger.info("Sending play_media command for '%s' to %s", title, selected.cast_info.friendly_name)
            mc.play_media(stream_url, content_type, title=title)
            logger.info("play_media command sent successfully.")
            return True

        except pychromecast.PyChromecastError as e:
            logger.error("PyChromecast error during casting: %s", e)
            return False
        except Exception as e:
            logger.error("An unexpected error occurred during casting: %s\n%s", e, traceback.format_exc())
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
                logger.warning("Chromecast with UUID %s not found for stopping/disconnecting.", uuid)
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
                logger.warning("Stop timed out for %s after 3s. Proceeding to disconnect.", target_cast.cast_info.friendly_name)
            elif _stop_err[0]:
                logger.error("Error stopping media on %s: %s", target_cast.cast_info.friendly_name, _stop_err[0])
            else:
                logger.info("Cast media playback stopped.")
        else:
            logger.info("No active media cast to stop on %s.", target_cast.cast_info.friendly_name)

        logger.info("Attempting to disconnect from Chromecast: %s", target_cast.cast_info.friendly_name)
        try:
            # Guard: only disconnect if the socket client thread was actually started
            # "cannot join thread before it is started" happens when cast.wait() was never called
            sc = getattr(target_cast, 'socket_client', None)
            if sc and hasattr(sc, 'is_alive') and sc.is_alive():
                target_cast.disconnect()
                logger.info("Disconnected from Chromecast: %s", target_cast.cast_info.friendly_name)
            else:
                logger.info("Skipping disconnect for %s (socket thread not started).", target_cast.cast_info.friendly_name)
        except Exception as e:
            logger.error("Error disconnecting from Chromecast %s: %s", target_cast.cast_info.friendly_name, e)
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
        logger.info("Connection handler for %s (%s): Status changed to %s", cast.cast_info.friendly_name, device_uuid, status.status)

        if status.status == "DISCONNECTED" or status.status == "FAILED":
            logger.warning("Chromecast %s (%s) disconnected or connection failed.", cast.cast_info.friendly_name, device_uuid)
            with self._lock:
                self._connection_failure_counts[device_uuid] = self._connection_failure_counts.get(device_uuid, 0) + 1
                current_failures = self._connection_failure_counts[device_uuid]

            logger.warning("Connection failures for %s (%s): %s", cast.cast_info.friendly_name, device_uuid, current_failures)

            if current_failures >= self._max_connection_failures:
                # Guard against duplicate disconnect threads for same device
                with self._lock:
                    if device_uuid in self._disconnect_in_progress:
                        logger.info("Disconnect already in progress for %s, skipping.", device_uuid)
                        return
                    self._disconnect_in_progress.add(device_uuid)
                    self._connection_failure_counts[device_uuid] = 0

                logger.error("Chromecast %s (%s) failed to reconnect %s times. Triggering disconnection.", cast.cast_info.friendly_name, device_uuid, self._max_connection_failures)

                def do_stop():
                    try:
                        self.stop_cast(device_uuid)
                        logger.info("Successfully stopped/disconnected device %s after repeated failures.", device_uuid)
                    except Exception as e:
                        logger.error("Failed to stop device %s: %s", device_uuid, e)
                        with self._lock:
                            self._disconnect_in_progress.discard(device_uuid)

                thread = threading.Thread(target=do_stop, daemon=True)
                thread.start()

        elif status.status == "CONNECTED":
            logger.info("Chromecast %s (%s) reconnected successfully. Resetting failure count.", cast.cast_info.friendly_name, device_uuid)
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
