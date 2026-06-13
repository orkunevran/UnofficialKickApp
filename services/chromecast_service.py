import ipaddress
import logging
import re
import socket
import ssl
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed

import pychromecast
import zeroconf
from pychromecast.dial import get_device_info
from pychromecast.discovery import CastBrowser, SimpleCastListener
from pychromecast.models import CastInfo
from pychromecast.socket_client import ConnectionStatus

from services.log_throttle import ThrottledErrorLog

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

_scan_error_log = ThrottledErrorLog(summary_every=60)
_cast_error_log = ThrottledErrorLog(summary_every=20)

DEFAULT_FALLBACK_SCAN_SUBNETS = "192.168.0.0/24,192.168.1.0/24,192.168.2.0/24"
# Cap the known-hosts cache so it cannot grow indefinitely on a network with
# churning IPs (DHCP lease cycling, containers/VMs joining and leaving).
_KNOWN_HOSTS_LIMIT = 128
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
        # LRU-bounded ordered dict (insertion order); we periodically trim to
        # _KNOWN_HOSTS_LIMIT entries — value is unused, only the key matters.
        self._known_chromecast_hosts: "OrderedDict[str, None]" = OrderedDict()
        self._browser = None
        self._zc = None  # Long-lived: created once, reused across scans
        self._cast_listener = None
        self._cast_objects = {}  # UUID string -> pychromecast.Chromecast
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
        self._load_state()

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

    def _remember_chromecast_host(self, host: str) -> None:
        """Add ``host`` to the known-hosts LRU, evicting oldest if over limit.

        OrderedDict preserves insertion order; move_to_end refreshes recency
        when a host is rediscovered. Eviction is O(1) amortised.
        """
        save_needed = False
        with self._lock:
            if host in self._known_chromecast_hosts:
                self._known_chromecast_hosts.move_to_end(host)
            else:
                self._known_chromecast_hosts[host] = None
                save_needed = True
                while len(self._known_chromecast_hosts) > _KNOWN_HOSTS_LIMIT:
                    self._known_chromecast_hosts.popitem(last=False)
        if save_needed:
            self._save_state()

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
        if not self._fallback_scan_enabled or self._zc is None:
            return []

        networks = self._detect_local_subnet()
        if not networks:
            return []

        candidate_hosts = []
        for network in networks:
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
        probe_failures = 0
        device_info_failures = 0
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
                except Exception:
                    probe_failures += 1
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
                except Exception:
                    device_info_failures += 1
                    continue

                if not device_status or not getattr(device_status, "uuid", None):
                    continue

                try:
                    self._remember_chromecast_host(host)
                    discovered_chromecasts.append(self._build_host_chromecast(host, device_status))
                except Exception as e:
                    logger.warning("Failed to create Chromecast object for %s: %s", host, e)

        if probe_failures or device_info_failures:
            logger.debug(
                "Fallback scan: %d probe failures, %d device-info failures across %d hosts.",
                probe_failures,
                device_info_failures,
                len(candidate_hosts),
            )
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
            for uuid, cast in list(self._cast_objects.items()):
                try:
                    cast.disconnect()
                except Exception:
                    pass
            self._cast_objects.clear()
            self.chromecasts = []
            self.selected_cast = None
            self.media_controller = None
        logger.info("ChromecastService shutdown complete.")



    def _init_discovery(self):
        """Lazily initialize long-lived Zeroconf and CastBrowser for Chromecast discovery."""
        with self._lock:
            if self._zc is not None:
                return
            logger.info("Initializing long-lived Zeroconf and CastBrowser for Chromecast discovery...")
            self._zc = zeroconf.Zeroconf(interfaces=zeroconf.InterfaceChoice.Default)
            
            class ChromecastListener(SimpleCastListener):
                def __init__(self, service_instance):
                    self.service_instance = service_instance

                def add_cast(self, uuid, service):
                    logger.info("mDNS discovered Chromecast device: UUID %s", uuid)
                    self.service_instance._rebuild_chromecasts_list()

                def remove_cast(self, uuid, service, cast_info):
                    logger.info("mDNS removed Chromecast device: UUID %s", uuid)
                    self.service_instance._rebuild_chromecasts_list()

                def update_cast(self, uuid, service):
                    self.service_instance._rebuild_chromecasts_list()

            self._cast_listener = ChromecastListener(self)
            
            merged_known_hosts = list(self._known_chromecast_hosts.keys())
            self._browser = CastBrowser(
                self._cast_listener,
                zeroconf_instance=self._zc,
                known_hosts=merged_known_hosts,
            )
            self._browser.start_discovery()

    def _rebuild_chromecasts_list(self):
        """Rebuilds self.chromecasts from self._browser.devices without recreating existing cast objects."""
        if not self._browser:
            return
            
        to_register = []
        with self._lock:
            new_chromecasts = []
            mdns_devices = dict(self._browser.devices)
            
            for uuid, cast_info in mdns_devices.items():
                device_uuid = str(uuid)
                existing_cast = self._cast_objects.get(device_uuid)
                if existing_cast:
                    new_chromecasts.append(existing_cast)
                else:
                    try:
                        cast = pychromecast.get_chromecast_from_cast_info(cast_info, self._zc)
                        self._cast_objects[device_uuid] = cast
                        new_chromecasts.append(cast)
                        
                        if device_uuid not in self._registered_uuids:
                            to_register.append(cast)
                            self._registered_uuids.add(device_uuid)
                        if device_uuid not in self._connection_failure_counts:
                            self._connection_failure_counts[device_uuid] = 0
                    except Exception as e:
                        logger.warning("Failed to create cast for UUID %s: %s", uuid, e)
                        
            # Keep fallback scanned devices or currently selected device even if not in mdns_devices
            for device_uuid, cast in list(self._cast_objects.items()):
                if device_uuid not in mdns_devices:
                    sc = getattr(cast, "socket_client", None)
                    is_active = sc and hasattr(sc, "is_alive") and sc.is_alive()
                    is_selected = (self.selected_cast and str(self.selected_cast.uuid) == device_uuid)
                    if is_active or is_selected:
                        if cast not in new_chromecasts:
                            new_chromecasts.append(cast)
            
            # Clean stale registered UUIDs
            active_uuids = {str(cc.uuid) for cc in new_chromecasts}
            selected_uuid = str(self.selected_cast.uuid) if self.selected_cast else None
            
            stale = self._registered_uuids - active_uuids
            if selected_uuid:
                stale.discard(selected_uuid)
                
            for stale_uuid in stale:
                self._registered_uuids.discard(stale_uuid)
                self._connection_failure_counts.pop(stale_uuid, None)
                old_cast = self._cast_objects.pop(stale_uuid, None)
                if old_cast:
                    try:
                        sc = getattr(old_cast, "socket_client", None)
                        if sc and hasattr(sc, "_started") and sc._started.is_set():
                            old_cast.disconnect(blocking=False)
                    except Exception:
                        pass
                        
            self.chromecasts = new_chromecasts
            
        # Register connection listeners outside the lock to prevent deadlocks
        for cast in to_register:
            try:
                listener = ChromecastConnectionListener(self, cast)
                cast.register_connection_listener(listener)
            except Exception as e:
                logger.error("Failed to register connection listener on %s: %s", cast.cast_info.friendly_name, e)

    def _do_scan(self, known_hosts=None):
        """Internal blocking scan implementation using long-lived Zeroconf and CastBrowser."""
        if self._shutdown_event.is_set():
            logger.info("Scan aborted: shutdown was requested before scan started.")
            with self._lock:
                self._scanning = False
            return
            
        self._shutdown_event.clear()
        logger.debug("Scanning for Chromecast devices...")
        
        try:
            # Lazily initialize long-lived Zeroconf and browser
            just_initialized = False
            if self._zc is None:
                self._init_discovery()
                just_initialized = True
                
            # If known hosts provided, trigger discovery lookup
            if known_hosts:
                for host in known_hosts:
                    self._remember_chromecast_host(host)
                    if hasattr(self._browser, 'lookup_cast'):
                        self._browser.lookup_cast(host)
                    
            for host in list(self._known_chromecast_hosts.keys()):
                if hasattr(self._browser, 'lookup_cast'):
                    self._browser.lookup_cast(host)
                
            # Wait for mDNS queries to resolve
            wait_time = self._scan_timeout if just_initialized else 2.0
            self._shutdown_event.wait(timeout=wait_time)
            
            if self._shutdown_event.is_set():
                logger.info("Scan aborted early due to shutdown signal.")
                return
                
            # Fallback scan if no devices are found
            with self._lock:
                has_devices = len(self.chromecasts) > 0
                
            if not has_devices:
                logger.info("No chromecasts discovered via mDNS. Running fallback network scan...")
                fallback_chromecasts = self._scan_private_networks_for_chromecasts()
                if fallback_chromecasts:
                    to_register = []
                    with self._lock:
                        for fc in fallback_chromecasts:
                            device_uuid = str(fc.uuid)
                            if device_uuid not in self._cast_objects:
                                self._cast_objects[device_uuid] = fc
                                if device_uuid not in self._registered_uuids:
                                    to_register.append(fc)
                                    self._registered_uuids.add(device_uuid)
                                if device_uuid not in self._connection_failure_counts:
                                    self._connection_failure_counts[device_uuid] = 0
                            
                            if self._cast_objects[device_uuid] not in self.chromecasts:
                                self.chromecasts.append(self._cast_objects[device_uuid])
                                
                    # Register connection listeners outside the lock to prevent deadlock
                    for cast in to_register:
                        try:
                            listener = ChromecastConnectionListener(self, cast)
                            cast.register_connection_listener(listener)
                        except Exception as e:
                            logger.error("Failed to register connection listener on %s: %s", cast.cast_info.friendly_name, e)
                            
            self._last_scan_time = time.time()
            
            # Log changes in count
            current_count = len(self.chromecasts)
            if current_count != getattr(self, "_last_logged_device_count", None):
                logger.info("Discovery scan finished. Found %s devices.", current_count)
                self._last_logged_device_count = current_count
            else:
                logger.debug("Discovery scan finished. Found %s devices.", current_count)
                
        except Exception as e:
            _scan_error_log.warn(logger, "Chromecast discovery error", e)
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

        # Demoted to DEBUG: this fires every time the frontend polls
        # /api/chromecast/devices past the cache TTL. The actual scan result
        # is logged at INFO via "Discovery scan finished" when the count changes.
        logger.debug("Submitting background device scan...")
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
                    self._cast_objects[str(cast.uuid)] = new_cast
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
                self._save_state()
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
            _cast_error_log.warn(logger, "PyChromecast error during casting", e)
            return False
        except Exception as e:
            # No more raw traceback.format_exc() — a stuck cast device hitting
            # this path repeatedly would otherwise dump 2-5 KB per attempt.
            _cast_error_log.warn(logger, "Unexpected error during casting", e)
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
        if is_selected and mc and mc_status and (mc_status.player_is_playing or mc_status.player_is_paused):
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
            self._save_state()
        return True

    def get_status(self):
        with self._lock:
            selected = self.selected_cast
            mc = self.media_controller

        if not selected:
            return {'status': 'disconnected'}

        # Null-safe status access
        mc_status = mc.status if mc else None
        volume_level = selected.status.volume_level if selected.status else 1.0
        
        duration = mc_status.duration if mc_status else None
        current_time = mc_status.adjusted_current_time if mc_status else None
        
        return {
            'status': 'connected',
            'device_name': selected.cast_info.friendly_name,
            'is_playing': mc_status.player_is_playing if mc_status else False,
            'volume_level': volume_level,
            'duration': duration,
            'current_time': current_time
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

    def _load_state(self):
        import json
        import os
        cache_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".kick_chromecast_cache.json")
        try:
            if os.path.exists(cache_file):
                with open(cache_file, "r") as f:
                    state = json.load(f)
                self._last_device_uuid = state.get("last_device_uuid")
                self._last_device_name = state.get("last_device_name")
                for host in state.get("known_chromecast_hosts", []):
                    self._known_chromecast_hosts[host] = None
                logger.info("Loaded Chromecast state cache: %s", state)
        except Exception as e:
            logger.warning("Failed to load Chromecast state cache: %s", e)

    def _save_state(self):
        import json
        import os
        cache_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".kick_chromecast_cache.json")
        try:
            state = {
                "last_device_uuid": self._last_device_uuid,
                "last_device_name": self._last_device_name,
                "known_chromecast_hosts": list(self._known_chromecast_hosts.keys()),
            }
            with open(cache_file, "w") as f:
                json.dump(state, f)
            logger.debug("Saved Chromecast state cache.")
        except Exception as e:
            logger.warning("Failed to save Chromecast state cache: %s", e)

    def _detect_local_subnet(self):
        """Detect the local subnet dynamically based on the active routing interface.
        
        Returns a list of ipaddress.IPv4Network, falling back to the configured networks.
        """
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
            s.close()
            # Extract prefix (e.g. 192.168.68.53 -> 192.168.68.0/24)
            parts = local_ip.split(".")
            net_str = f"{parts[0]}.{parts[1]}.{parts[2]}.0/24"
            detected = [ipaddress.ip_network(net_str, strict=False)]
            logger.info("Dynamically detected local Chromecast scan subnet: %s", net_str)
            return detected
        except Exception as e:
            logger.debug("Failed to dynamically detect local subnet: %s, using defaults.", e)
            return self._fallback_scan_networks

    def pause_media(self) -> bool:
        with self._lock:
            mc = self.media_controller
        if mc:
            try:
                mc.pause()
                logger.info("Paused media playback.")
                return True
            except Exception as e:
                logger.error("Failed to pause media: %s", e)
        return False

    def play_media(self) -> bool:
        with self._lock:
            mc = self.media_controller
        if mc:
            try:
                mc.play()
                logger.info("Resumed media playback.")
                return True
            except Exception as e:
                logger.error("Failed to resume media: %s", e)
        return False

    def set_volume(self, level: float) -> bool:
        """Set volume level (between 0.0 and 1.0)."""
        with self._lock:
            cast = self.selected_cast
        if cast:
            try:
                clamped = max(0.0, min(1.0, float(level)))
                cast.set_volume(clamped)
                logger.info("Set volume to %s", clamped)
                return True
            except Exception as e:
                logger.error("Failed to set volume: %s", e)
        return False

    def seek_media(self, position_seconds: float) -> bool:
        """Seek media to a specific position in seconds."""
        with self._lock:
            mc = self.media_controller
        if mc:
            try:
                logger.info("Seeking media to %s seconds", position_seconds)
                mc.seek(position_seconds)
                return True
            except Exception as e:
                logger.error("Failed to seek media: %s", e)
        return False


class ChromecastConnectionListener:
    def __init__(self, service_instance, cast):
        self.service_instance = service_instance
        self.cast = cast

    def new_connection_status(self, status: ConnectionStatus):
        self.service_instance._handle_connection_status(self.cast, status)


# Singleton instance
chromecast_service = ChromecastService()
