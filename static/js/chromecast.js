/**
 * Chromecast modal — device discovery, selection, and casting UI.
 */

import { toast } from './toast.js';
import { castStream } from './chromecast_logic.js';
import { escapeHtml } from './utils.js';
import { preferences, updatePreference } from './state.js';
import { fetchChromecastDevices, postChromecastSelect, postChromecastStop, fetchChromecastStatus, postChromecastPlay, postChromecastPause, postChromecastVolume, postChromecastSeek } from './api.js';

// ── SVG Icons ────────────────────────────────────────────────────────────

const ICON_TV = '<svg class="device-item-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="15" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/></svg>';
const ICON_RECONNECT = '<svg class="device-item-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>';

// ── State ────────────────────────────────────────────────────────────────

let selectedDevice = null;
let statusPollTimer = null;
let isDiscovering = false;
let scanPollTimer = null;
let isScanActive = false;
let isSelecting = false;
let selectRetryCount = 0; // consecutive auto-retries for the current select (capped + backed off)
const MAX_SELECT_RETRIES = 4;
const SELECT_RETRY_BASE_MS = 3000;
let selectRetryTimer = null;          // pending 409 auto-retry; cleared on modal close / disconnect
let statusPollFailures = 0;           // consecutive status-poll failures (caps the fallback loop)
const MAX_STATUS_POLL_FAILURES = 5;
let isSeekInFlight = false;           // guards seek POSTs so rapid taps don't stack
let discoveredDevices = [];
let pendingCastRequest = null;
let chromecastListenersBound = false;
let focusTrapHandler = null;
let modalReturnFocus = null; // element focus is restored to when the modal closes
let silentRefreshTimer = null;
let isDevicePlaying = false;
let isUserSeeking = false;
let isAdjustingVolume = false;

// ── Init ─────────────────────────────────────────────────────────────────

export function initializeChromecast() {
    if (chromecastListenersBound) return;

    const chromecastButton = document.getElementById('chromecast-button');
    const chromecastModal = document.getElementById('chromecast-modal');
    if (!chromecastButton || !chromecastModal) return;

    chromecastListenersBound = true;

    chromecastButton.addEventListener('click', openModal);
    chromecastModal.querySelector('.close-button')?.addEventListener('click', closeModal);
    window.addEventListener('click', (e) => { if (e.target === chromecastModal) closeModal(); });

    document.getElementById('rescan-devices-btn')?.addEventListener('click', () => discoverDevices(true));
    document.getElementById('disconnect-device-btn')?.addEventListener('click', disconnectDevice);
    document.getElementById('chromecast-host-discover-btn')?.addEventListener('click', handleHostDiscovery);
    document.getElementById('chromecast-host-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); handleHostDiscovery(); }
    });

    // Quick disconnect from header
    document.getElementById('chromecast-disconnect-quick')?.addEventListener('click', disconnectDevice);

    // Remote control event handlers
    const playPauseBtn = document.getElementById('cc-play-pause-btn');
    const volumeSlider = document.getElementById('cc-volume-slider');

    playPauseBtn?.addEventListener('click', handlePlayPauseToggle);

    let volumeTimeout = null;
    let volumeReleaseTimeout = null;
    volumeSlider?.addEventListener('input', (e) => {
        // Block status pushes from snapping the slider back mid-drag. On iOS a
        // range input isn't reliably document.activeElement during a touch drag,
        // so the activeElement guard in handleStatusUpdate isn't enough — this
        // flag is (mirrors isUserSeeking for the progress slider).
        isAdjustingVolume = true;
        if (volumeReleaseTimeout) { clearTimeout(volumeReleaseTimeout); volumeReleaseTimeout = null; }
        const value = parseInt(e.target.value, 10);
        const percentEl = document.getElementById('cc-volume-percent');
        if (percentEl) percentEl.textContent = `${value}%`;

        if (volumeTimeout) clearTimeout(volumeTimeout);
        // 300ms debounce: a slider drag fires `input` continuously; at 100ms a slow
        // drag pushed 10-20 POSTs to a rate-limited backend. 300ms still feels live.
        volumeTimeout = setTimeout(async () => {
            try {
                await postChromecastVolume(value / 100.0);
            } catch {
                toast('Failed to update volume', 'error');
            }
        }, 300);
    });
    // Resume accepting device-reported volume a short grace period after release,
    // so an in-flight status push (still carrying the pre-change level) can't
    // immediately snap the slider back.
    volumeSlider?.addEventListener('change', () => {
        if (volumeReleaseTimeout) clearTimeout(volumeReleaseTimeout);
        volumeReleaseTimeout = setTimeout(() => { isAdjustingVolume = false; }, 600);
    });

    const progressSlider = document.getElementById('cc-progress-slider');
    const rewindBtn = document.getElementById('cc-rewind-btn');
    const forwardBtn = document.getElementById('cc-forward-btn');

    progressSlider?.addEventListener('input', (e) => {
        isUserSeeking = true;
        const value = parseFloat(e.target.value);
        const currentEl = document.getElementById('cc-current-time');
        if (currentEl) currentEl.textContent = formatTime(value);
    });

    // Guarded seek: rapid taps on rewind/forward (or scrubbing) must not stack
    // concurrent POSTs against the rate-limited backend. The slider updates locally
    // for instant feedback; only one seek is in flight at a time.
    const sendSeek = async (pos, errMsg) => {
        if (isSeekInFlight) return;
        isSeekInFlight = true;
        try {
            await postChromecastSeek(pos);
        } catch {
            toast(errMsg, 'error');
        } finally {
            isSeekInFlight = false;
        }
    };

    progressSlider?.addEventListener('change', async (e) => {
        await sendSeek(parseFloat(e.target.value), 'Failed to seek');
        isUserSeeking = false;
    });

    rewindBtn?.addEventListener('click', async () => {
        const slider = document.getElementById('cc-progress-slider');
        if (!slider) return;
        const newPos = Math.max(0, parseFloat(slider.value) - 10);
        slider.value = newPos;
        const currentEl = document.getElementById('cc-current-time');
        if (currentEl) currentEl.textContent = formatTime(newPos);
        await sendSeek(newPos, 'Failed to rewind');
    });

    forwardBtn?.addEventListener('click', async () => {
        const slider = document.getElementById('cc-progress-slider');
        if (!slider) return;
        const maxTime = parseFloat(slider.max) || 0;
        const newPos = Math.min(maxTime, parseFloat(slider.value) + 30);
        slider.value = newPos;
        const currentEl = document.getElementById('cc-current-time');
        if (currentEl) currentEl.textContent = formatTime(newPos);
        await sendSeek(newPos, 'Failed to fast forward');
    });

    // Device list click delegation
    document.getElementById('chromecast-device-list')?.addEventListener('click', handleDeviceListClick);
    document.getElementById('chromecast-device-list')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            const item = e.target.closest('.device-item');
            if (item) { e.preventDefault(); item.click(); }
        }
    });

    document.addEventListener('chromecast:request-device', (event) => {
        const detail = event?.detail || {};
        if (detail.streamUrl) {
            pendingCastRequest = { streamUrl: detail.streamUrl, title: detail.title || 'Kick Stream' };
        }
        openModal();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || chromecastModal.style.display !== 'block') return;
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        closeModal();
    });

    window.addEventListener('beforeunload', () => {
        stopStatusPolling();
        stopSilentDeviceRefresh();
    });

    // Restore saved device
    const saved = localStorage.getItem('selectedChromecast');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            if (parsed?.uuid && parsed?.name) {
                selectedDevice = parsed;
                updateIcon('active');
                document.body.classList.add('chromecast-active');
                document.body.classList.remove('no-cast');
                showQuickDisconnect(true);
                const dcBtn = document.getElementById('disconnect-device-btn');
                if (dcBtn) dcBtn.style.display = 'block';
                updateRemoteControlVisibility();
                startStatusPolling();
            } else {
                localStorage.removeItem('selectedChromecast');
            }
        } catch {
            localStorage.removeItem('selectedChromecast');
        }
    }

    // Pre-fetch devices once; periodic refresh starts lazily on first modal open
    silentFetchDevices();

    renderDeviceList(discoveredDevices);
}

// ── Silent background fetch ─────────────────────────────────────────────

async function silentFetchDevices() {
    try {
        const data = await fetchChromecastDevices(false);
        if (data.status === 'success' && Array.isArray(data.data?.devices)) {
            discoveredDevices = data.data.devices;
            _updateCastVisibility();
        }
    } catch {
        // Silent — don't toast on background fetch failures
    }
}

function stopSilentDeviceRefresh() {
    if (silentRefreshTimer) {
        clearInterval(silentRefreshTimer);
        silentRefreshTimer = null;
    }
}

/** Track "no devices selected/discovered" state for auxiliary Chromecast UI. */
function _updateCastVisibility() {
    document.body.classList.toggle('no-cast', discoveredDevices.length === 0 && !selectedDevice);
}

// ── Modal lifecycle ──────────────────────────────────────────────────────

function openModal() {
    const modal = document.getElementById('chromecast-modal');
    if (!modal) return;
    // Remember what to return focus to, then move focus into the dialog. #app
    // goes inert while the modal is visible, so without this focus would be
    // stranded on the now-inert trigger and the dialog wouldn't be announced.
    modalReturnFocus = (document.activeElement instanceof HTMLElement) ? document.activeElement : null;
    modal.style.display = 'block';
    requestAnimationFrame(() => {
        modal.classList.add('visible');
        const focusTarget = modal.querySelector('.close-button') || modal.querySelector('.modal-content');
        try { focusTarget?.focus(); } catch { /* no-op */ }
    });

    // Focus trap
    const content = modal.querySelector('.modal-content');
    if (content) {
        if (focusTrapHandler) modal.removeEventListener('keydown', focusTrapHandler);
        focusTrapHandler = (e) => {
            if (e.key !== 'Tab') return;
            const els = content.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])');
            if (!els.length) return;
            const first = els[0], last = els[els.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        };
        modal.addEventListener('keydown', focusTrapHandler);
    }

    // Start periodic background refresh on first modal open (lazy — saves CPU/battery)
    if (!silentRefreshTimer) {
        silentRefreshTimer = setInterval(silentFetchDevices, 60000);
    }

    // Render cached devices immediately; fetch latest in background (no spinner if we have devices)
    renderDeviceList(discoveredDevices);
    if (discoveredDevices.length > 0) {
        // Silently refresh in background — no scanning state shown
        silentFetchDevices().then(() => renderDeviceList(discoveredDevices));
    } else {
        discoverDevices(false);
    }
}

function closeModal() {
    const modal = document.getElementById('chromecast-modal');
    if (!modal) return;
    if (focusTrapHandler) { modal.removeEventListener('keydown', focusTrapHandler); focusTrapHandler = null; }
    modal.classList.remove('visible');
    setTimeout(() => { modal.style.display = 'none'; }, 200);
    if (scanPollTimer) { clearTimeout(scanPollTimer); scanPollTimer = null; }
    // Cancel any pending 409 auto-retry so it doesn't keep hitting /select after
    // the user has closed the modal (abandoned the selection).
    if (selectRetryTimer) { clearTimeout(selectRetryTimer); selectRetryTimer = null; isSelecting = false; }
    stopSilentDeviceRefresh();
    isDiscovering = false;
    setRescanState(false);
    pendingCastRequest = null;
    const hostInput = document.getElementById('chromecast-host-input');
    if (hostInput) hostInput.value = '';
    // Restore focus to the element that opened the modal, so keyboard/SR users
    // don't lose their place. Deferred a frame: the #app `inert` attribute is
    // cleared by a MutationObserver (async) when `.visible` is removed above, and
    // focus() is a no-op while the target's ancestor is still inert.
    const returnTo = modalReturnFocus;
    modalReturnFocus = null;
    if (returnTo && document.contains(returnTo)) {
        requestAnimationFrame(() => { try { returnTo.focus(); } catch { /* no-op */ } });
    }
}

// ── Host discovery (advanced) ────────────────────────────────────────────

function handleHostDiscovery() {
    const host = document.getElementById('chromecast-host-input')?.value.trim() || '';
    if (!host) { toast('Enter a Chromecast IP or hostname.', 'info'); return; }
    if (isDiscovering) { toast('Scan in progress, please wait.', 'info'); return; }
    discoverDevices(true, host);
}

// ── Device discovery ─────────────────────────────────────────────────────

function setRescanState(scanning) {
    isScanActive = scanning;
    const btn = document.getElementById('rescan-devices-btn');
    const icon = btn?.querySelector('.rescan-icon');
    const label = btn?.querySelector('.rescan-label');
    const hostBtn = document.getElementById('chromecast-host-discover-btn');
    const hostInput = document.getElementById('chromecast-host-input');

    if (scanning) {
        if (btn) btn.disabled = true;
        if (label) label.textContent = 'Scanning...';
        if (icon) icon.classList.add('spinning');
        if (hostBtn) hostBtn.disabled = true;
        if (hostInput) hostInput.disabled = true;
    } else {
        if (btn) btn.disabled = false;
        if (label) label.textContent = 'Rescan';
        if (icon) icon.classList.remove('spinning');
        if (hostBtn) hostBtn.disabled = false;
        if (hostInput) hostInput.disabled = false;
    }
}

async function discoverDevices(force = false, knownHosts = null) {
    if (isDiscovering) return;
    isDiscovering = true;
    setRescanState(true);
    renderDeviceList(discoveredDevices); // update empty state to show scanning
    if (scanPollTimer) { clearTimeout(scanPollTimer); scanPollTimer = null; }

    try {
        const data = await fetchChromecastDevices(force, knownHosts);
        if (data.status === 'success') {
            renderDeviceList(data.data?.devices || []);
            if (knownHosts && (!data.data?.devices || data.data.devices.length === 0)) {
                toast(`No Chromecast found at ${knownHosts}.`, 'warning');
            }
            if (data.data?.scanning) {
                isDiscovering = false;
                scanPollTimer = setTimeout(() => { scanPollTimer = null; discoverDevices(false); }, 6000);
                return;
            }
        } else {
            toast('Failed to discover devices.', 'error');
        }
    } catch (error) {
        toast(error.name === 'AbortError' ? 'Discovery timed out.' : 'Error discovering devices.', 'error');
    }

    setRescanState(false);
    isDiscovering = false;
}

// ── Rendering ────────────────────────────────────────────────────────────

function getLastDevice() {
    const cc = preferences.chromecast || {};
    return {
        uuid: cc.lastDeviceUUID || localStorage.getItem('lastChromecastUUID') || null,
        name: cc.lastDeviceName || localStorage.getItem('lastChromecastName') || null,
    };
}

function shouldShowReconnect() {
    const last = getLastDevice();
    if (selectedDevice || !last.uuid || !last.name) return false;
    return !discoveredDevices.some(d => d?.uuid === last.uuid);
}

function renderDeviceItem(device, { selected = false, reconnect = false } = {}) {
    const name = escapeHtml(device?.name || 'Unknown device');
    const uuid = escapeHtml(device?.uuid || '');
    const classes = ['device-item', selected ? 'selected' : '', reconnect ? 'reconnect-item' : ''].filter(Boolean).join(' ');
    const icon = reconnect ? ICON_RECONNECT : ICON_TV;
    const badge = selected ? '<span class="device-item-badge">Connected</span>' : '';
    const label = reconnect ? `Reconnect ${name}` : name;

    return `<div class="${classes}" tabindex="0" role="button" data-uuid="${uuid}" title="${uuid}">
        ${icon}
        <span class="device-item-name">${label}</span>
        <span class="device-item-status"></span>
        ${badge}
    </div>`;
}

function renderDeviceList(devices) {
    const list = document.getElementById('chromecast-device-list');
    if (!list) return;
    discoveredDevices = Array.isArray(devices) ? devices : [];
    _updateCastVisibility();
    const showReconnect = shouldShowReconnect();

    let html = '';

    if (showReconnect) {
        html += renderDeviceItem(getLastDevice(), { reconnect: true });
    }

    discoveredDevices.forEach(device => {
        html += renderDeviceItem(device, { selected: selectedDevice?.uuid === device.uuid });
    });

    if (discoveredDevices.length === 0 && !showReconnect) {
        if (isScanActive) {
            html = '<div class="cc-empty-state">Scanning for devices...</div>';
        } else {
            html = '<div class="cc-empty-state">No devices found.<br>Try Rescan or check Troubleshooting below.</div>';
        }
    }

    list.innerHTML = html;
}

// ── Device list click delegation ─────────────────────────────────────────

function handleDeviceListClick(event) {
    const item = event.target.closest('.device-item');
    if (!item) return;
    const uuid = item.dataset.uuid;
    if (!uuid) return;

    const device = discoveredDevices.find(d => d.uuid === uuid) || { uuid, name: item.querySelector('.device-item-name')?.textContent?.replace(/^Reconnect\s+/, '') || 'Chromecast' };
    selectDevice(device);
}

// ── Inline connection feedback helpers ───────────────────────────────────

function updateDeviceStatus(el, text, type) {
    if (!el) return;
    const statusEl = el.querySelector('.device-item-status');
    if (!statusEl) return;

    el.classList.remove('connecting', 'connect-failed');
    statusEl.innerHTML = '';

    if (type === 'connecting') {
        el.classList.add('connecting');
        statusEl.innerHTML = `<span class="mini-spinner"></span> ${escapeHtml(text)}`;
    } else if (type === 'success') {
        statusEl.innerHTML = `<span style="color:var(--primary-color)">${escapeHtml(text)}</span>`;
    } else if (type === 'failed') {
        el.classList.add('connect-failed');
        statusEl.innerHTML = `<span style="color:var(--error-color)">${escapeHtml(text)}</span>`;
    }
}

function setDeviceListDisabled(disabled, exceptEl) {
    const items = document.querySelectorAll('#chromecast-device-list .device-item');
    items.forEach(item => {
        if (item === exceptEl) return;
        item.style.pointerEvents = disabled ? 'none' : '';
        item.style.opacity = disabled ? '0.4' : '';
    });
}

// ── Device selection ─────────────────────────────────────────────────────

async function selectDevice(device, isRetry = false) {
    if (isScanActive) { toast('Please wait for scan to finish.', 'info'); return; }
    if (isSelecting) return;

    if (!isRetry) selectRetryCount = 0; // fresh, user-initiated attempt
    isSelecting = true;
    const deviceName = String(device?.name || 'Chromecast');

    // Find the clicked device element for inline feedback
    const deviceEl = document.querySelector(`#chromecast-device-list .device-item[data-uuid="${CSS.escape(device.uuid)}"]`);

    // Show inline connecting state
    updateDeviceStatus(deviceEl, 'Connecting...', 'connecting');
    setDeviceListDisabled(true, deviceEl);

    try {
        const { data, status } = await postChromecastSelect(device.uuid);
        if (data.status === 'success') {
            selectedDevice = device;
            localStorage.setItem('selectedChromecast', JSON.stringify(device));
            updatePreference('chromecast', { lastDeviceUUID: device.uuid, lastDeviceName: deviceName });
            localStorage.removeItem('lastChromecastUUID');
            localStorage.removeItem('lastChromecastName');

            updateIcon('active');
            document.body.classList.add('chromecast-active');
            document.body.classList.remove('no-cast');
            showQuickDisconnect(true);
            const dcBtn = document.getElementById('disconnect-device-btn');
            if (dcBtn) dcBtn.style.display = 'block';
            updateRemoteControlVisibility();

            // Show inline success briefly, then close
            selectRetryCount = 0;
            updateDeviceStatus(deviceEl, 'Connected', 'success');
            toast(`Connected to ${deviceName}`, 'success');
            const pending = pendingCastRequest;
            pendingCastRequest = null;

            setTimeout(() => {
                closeModal();
                startStatusPolling();
                if (pending?.streamUrl) {
                    castStream(pending.streamUrl, pending.title || 'Kick Stream');
                }
            }, 600);
        } else if (status === 409) {
            // Scan or another selection in progress — transient. Retry with capped
            // exponential backoff; never retry forever (that hammers a flaky Cast
            // device into wedging). After the cap, stop and offer a manual retry.
            if (selectRetryCount < MAX_SELECT_RETRIES) {
                const delay = SELECT_RETRY_BASE_MS * Math.pow(2, selectRetryCount); // 3s,6s,12s,24s
                selectRetryCount++;
                updateDeviceStatus(deviceEl, 'Waiting...', 'connecting');
                selectRetryTimer = setTimeout(() => {
                    selectRetryTimer = null;
                    setDeviceListDisabled(false);
                    isSelecting = false;
                    selectDevice(device, true);
                }, delay);
                return;
            }
            updateDeviceStatus(deviceEl, 'Busy', 'failed');
            setDeviceListDisabled(false);
            toast(`${deviceName} is busy. Try again in a moment.`, 'error', {
                action: { label: 'Retry', onClick: () => selectDevice(device) },
            });
        } else if (status === 503) {
            // Device benched after a failed connection (server cooldown). Don't
            // auto-retry — let it recover; offer a manual retry.
            updateDeviceStatus(deviceEl, 'Unavailable', 'failed');
            setDeviceListDisabled(false);
            toast(`${deviceName} isn't responding. Make sure it's on, then retry.`, 'error', {
                action: { label: 'Retry', onClick: () => selectDevice(device) },
            });
        } else {
            updateDeviceStatus(deviceEl, 'Failed', 'failed');
            setDeviceListDisabled(false);
            toast(`Failed to connect to ${deviceName}.`, 'error', {
                action: { label: 'Retry', onClick: () => selectDevice(device) },
            });
        }
    } catch {
        updateDeviceStatus(deviceEl, 'Failed', 'failed');
        setDeviceListDisabled(false);
        toast(`Failed to connect to ${deviceName}.`, 'error', {
            action: { label: 'Retry', onClick: () => selectDevice(device) },
        });
    }
    isSelecting = false;
}

// ── Disconnect ───────────────────────────────────────────────────────────

async function disconnectDevice() {
    // Cancel any pending auto-retry first so it can't re-select after we disconnect.
    if (selectRetryTimer) { clearTimeout(selectRetryTimer); selectRetryTimer = null; isSelecting = false; }
    if (selectedDevice) {
        try {
            const data = await postChromecastStop(selectedDevice.uuid);
            if (data.status !== 'success') toast('Failed to stop casting.', 'error');
        } catch {
            toast('Error stopping cast.', 'error');
        }
    }
    selectedDevice = null;
    pendingCastRequest = null;
    localStorage.removeItem('selectedChromecast');
    updateIcon('inactive');
    document.body.classList.remove('chromecast-active');
    _updateCastVisibility();
    showQuickDisconnect(false);
    const dcBtn = document.getElementById('disconnect-device-btn');
    if (dcBtn) dcBtn.style.display = 'none';
    updateRemoteControlVisibility();
    renderDeviceList(discoveredDevices);
    toast('Disconnected.', 'info');
    stopStatusPolling();
}

// ── Quick disconnect (header button) ─────────────────────────────────────

function showQuickDisconnect(visible) {
    const btn = document.getElementById('chromecast-disconnect-quick');
    if (btn) btn.style.display = visible ? '' : 'none';
}

// ── SSE-based status streaming (with polling fallback) ──────────────────

let statusEventSource = null;

function startStatusPolling() {
    stopStatusPolling();
    statusPollFailures = 0;

    // Try SSE first — single persistent connection instead of polling
    if (typeof EventSource !== 'undefined') {
        try {
            statusEventSource = new EventSource('/api/chromecast/status/stream');
            statusEventSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    handleStatusUpdate(data);
                } catch { /* ignore malformed SSE data */ }
            };
            statusEventSource.onerror = () => {
                // EventSource fires onerror on every transient blip and the browser
                // AUTO-RECONNECTS while readyState === CONNECTING. Falling back to
                // polling then would stack a poll loop on top of the native retry —
                // a client-side reconnect storm against an already-struggling backend.
                // Only fall back once the connection is permanently CLOSED, and only
                // if a device is still selected.
                const es = statusEventSource;
                if (!es || es.readyState === EventSource.CONNECTING) return; // browser retrying
                if (es.readyState === EventSource.CLOSED && selectedDevice) {
                    stopStatusPolling();
                    scheduleStatusPoll(10000);
                }
            };
            return; // SSE connected, no need for polling
        } catch {
            // EventSource constructor failed — fall back to polling
        }
    }

    scheduleStatusPoll(10000); // fallback: poll every 10s
}

function handleStatusUpdate(data) {
    if (data?.status !== 'success') return;
    const castStatus = data.data?.status;
    if (castStatus === 'disconnected') {
        if (!selectedDevice) return; // already torn down — avoid duplicate toast/teardown
        selectedDevice = null;
        localStorage.removeItem('selectedChromecast');
        updateIcon('inactive');
        document.body.classList.remove('chromecast-active');
        showQuickDisconnect(false);
        const dcBtn = document.getElementById('disconnect-device-btn');
        if (dcBtn) dcBtn.style.display = 'none';
        updateRemoteControlVisibility();
        renderDeviceList(discoveredDevices);
        toast('Chromecast was disconnected.', 'info');
        stopStatusPolling();
    } else if (castStatus === 'connected') {
        const isPlaying = !!data.data?.is_playing;
        isDevicePlaying = isPlaying;
        updatePlayPauseUI(isPlaying);

        const volumeSlider = document.getElementById('cc-volume-slider');
        if (volumeSlider && !isAdjustingVolume && document.activeElement !== volumeSlider) {
            const volLevel = data.data?.volume_level;
            if (typeof volLevel === 'number') {
                const volPct = Math.round(volLevel * 100);
                volumeSlider.value = volPct;
                const pctEl = document.getElementById('cc-volume-percent');
                if (pctEl) pctEl.textContent = `${volPct}%`;
            }
        }

        // VOD Progress Update
        const duration = data.data?.duration;
        const currentTime = data.data?.current_time;
        const progressRow = document.getElementById('cc-progress-row');
        const rewindBtn = document.getElementById('cc-rewind-btn');
        const forwardBtn = document.getElementById('cc-forward-btn');

        if (typeof duration === 'number' && duration > 0) {
            if (progressRow) progressRow.style.display = 'flex';
            if (rewindBtn) rewindBtn.style.display = 'inline-flex';
            if (forwardBtn) forwardBtn.style.display = 'inline-flex';

            const progressSlider = document.getElementById('cc-progress-slider');
            if (progressSlider && !isUserSeeking) {
                progressSlider.max = duration;
                progressSlider.value = currentTime || 0;
                
                const currentEl = document.getElementById('cc-current-time');
                if (currentEl) currentEl.textContent = formatTime(currentTime || 0);
                
                const totalEl = document.getElementById('cc-total-time');
                if (totalEl) totalEl.textContent = formatTime(duration);
            }
        } else {
            if (progressRow) progressRow.style.display = 'none';
            if (rewindBtn) rewindBtn.style.display = 'none';
            if (forwardBtn) forwardBtn.style.display = 'none';
        }

        updateRemoteControlVisibility();
    }
}

function scheduleStatusPoll(delay) {
    statusPollTimer = setTimeout(async () => {
        try {
            const data = await fetchChromecastStatus();
            handleStatusUpdate(data);
            if (data?.status === 'success') {
                statusPollFailures = 0;
                const castStatus = data.data?.status;
                if (castStatus === 'disconnected') return; // stop polling
                const nextDelay = castStatus === 'playing' ? 10000 : 30000;
                scheduleStatusPoll(nextDelay);
            } else if (++statusPollFailures < MAX_STATUS_POLL_FAILURES) {
                scheduleStatusPoll(15000);
            } else {
                // Backend persistently unreachable/erroring — stop polling rather
                // than hammering a wedged /status forever with no user feedback.
                stopStatusPolling();
                toast('Lost connection to the cast device.', 'info');
            }
        } catch {
            if (++statusPollFailures < MAX_STATUS_POLL_FAILURES) {
                scheduleStatusPoll(15000);
            } else {
                stopStatusPolling();
            }
        }
    }, delay);
}

function stopStatusPolling() {
    if (statusPollTimer) { clearTimeout(statusPollTimer); statusPollTimer = null; }
    if (statusEventSource) { statusEventSource.close(); statusEventSource = null; }
}

// ── Icon ─────────────────────────────────────────────────────────────────

function updateIcon(status) {
    const icon = document.getElementById('chromecast-icon');
    const button = document.getElementById('chromecast-button');
    if (!icon || !button) return;
    if (status === 'active') {
        icon.src = '/static/icons/chromecast-active.svg';
        button.classList.add('active');
    } else {
        icon.src = '/static/icons/chromecast.svg';
        button.classList.remove('active');
    }
}

// ── Remote Controls Helpers ──────────────────────────────────────────────

async function handlePlayPauseToggle() {
    try {
        if (isDevicePlaying) {
            const res = await postChromecastPause();
            if (res.status === 'success') {
                isDevicePlaying = false;
                updatePlayPauseUI(false);
            } else {
                toast(res.message || 'Failed to pause playback', 'error');
            }
        } else {
            const res = await postChromecastPlay();
            if (res.status === 'success') {
                isDevicePlaying = true;
                updatePlayPauseUI(true);
            } else {
                toast(res.message || 'Failed to resume playback', 'error');
            }
        }
    } catch {
        toast('Error toggling playback', 'error');
    }
}

function updatePlayPauseUI(playing) {
    const btn = document.getElementById('cc-play-pause-btn');
    if (!btn) return;
    const playIcon = btn.querySelector('.play-icon');
    const pauseIcon = btn.querySelector('.pause-icon');
    if (playing) {
        if (playIcon) playIcon.style.display = 'none';
        if (pauseIcon) pauseIcon.style.display = 'block';
    } else {
        if (playIcon) playIcon.style.display = 'block';
        if (pauseIcon) pauseIcon.style.display = 'none';
    }
}

function updateRemoteControlVisibility() {
    const rc = document.getElementById('chromecast-remote-controls');
    if (!rc) return;
    if (selectedDevice) {
        rc.style.display = 'flex';
        const nameEl = document.getElementById('cc-status-device');
        if (nameEl) nameEl.textContent = selectedDevice.name;
    } else {
        rc.style.display = 'none';
    }
}

function formatTime(seconds) {
    if (isNaN(seconds) || seconds === null) return '00:00:00';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
