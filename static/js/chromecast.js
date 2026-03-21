/**
 * Chromecast modal — device discovery, selection, and casting UI.
 */

import { toast } from './toast.js?v=2.3.7';
import { castStream } from './chromecast_logic.js?v=2.3.7';
import { escapeHtml } from './utils.js?v=2.3.7';
import { preferences, updatePreference } from './state.js?v=2.3.7';
import { fetchChromecastDevices, postChromecastSelect, postChromecastStop, fetchChromecastStatus } from './api.js?v=2.3.7';

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
let discoveredDevices = [];
let pendingCastRequest = null;
let chromecastListenersBound = false;
let focusTrapHandler = null;
let silentRefreshTimer = null;

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

    window.addEventListener('beforeunload', stopStatusPolling);

    // Restore saved device
    const saved = localStorage.getItem('selectedChromecast');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            if (parsed?.uuid && parsed?.name) {
                selectedDevice = parsed;
                updateIcon('active');
                document.body.classList.add('chromecast-active');
                showQuickDisconnect(true);
                const dcBtn = document.getElementById('disconnect-device-btn');
                if (dcBtn) dcBtn.style.display = 'block';
                startStatusPolling();
            } else {
                localStorage.removeItem('selectedChromecast');
            }
        } catch {
            localStorage.removeItem('selectedChromecast');
        }
    }

    // Pre-fetch devices silently so the modal always has devices ready
    silentFetchDevices();
    silentRefreshTimer = setInterval(silentFetchDevices, 60000);

    renderDeviceList(discoveredDevices);
}

// ── Silent background fetch ─────────────────────────────────────────────

async function silentFetchDevices() {
    try {
        const data = await fetchChromecastDevices(false);
        if (data.status === 'success' && Array.isArray(data.data?.devices)) {
            discoveredDevices = data.data.devices;
        }
    } catch {
        // Silent — don't toast on background fetch failures
    }
}

// ── Modal lifecycle ──────────────────────────────────────────────────────

function openModal() {
    const modal = document.getElementById('chromecast-modal');
    if (!modal) return;
    modal.style.display = 'block';
    requestAnimationFrame(() => modal.classList.add('visible'));

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
    pendingCastRequest = null;
    const hostInput = document.getElementById('chromecast-host-input');
    if (hostInput) hostInput.value = '';
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
        statusEl.innerHTML = `<span style="color:var(--kick-color)">${escapeHtml(text)}</span>`;
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

async function selectDevice(device) {
    if (isScanActive) { toast('Please wait for scan to finish.', 'info'); return; }
    if (isSelecting) return;

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
            showQuickDisconnect(true);
            const dcBtn = document.getElementById('disconnect-device-btn');
            if (dcBtn) dcBtn.style.display = 'block';

            // Show inline success briefly, then close
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
            updateDeviceStatus(deviceEl, 'Waiting...', 'connecting');
            toast('Scan in progress, retrying...', 'info');
            setTimeout(() => {
                setDeviceListDisabled(false);
                isSelecting = false;
                selectDevice(device);
            }, 3000);
            return;
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
    showQuickDisconnect(false);
    const dcBtn = document.getElementById('disconnect-device-btn');
    if (dcBtn) dcBtn.style.display = 'none';
    renderDeviceList(discoveredDevices);
    toast('Disconnected.', 'info');
    stopStatusPolling();
}

// ── Quick disconnect (header button) ─────────────────────────────────────

function showQuickDisconnect(visible) {
    const btn = document.getElementById('chromecast-disconnect-quick');
    if (btn) btn.style.display = visible ? '' : 'none';
}

// ── Adaptive status polling ──────────────────────────────────────────────

function startStatusPolling() {
    stopStatusPolling();
    scheduleStatusPoll(10000); // initial: 10s
}

function scheduleStatusPoll(delay) {
    statusPollTimer = setTimeout(async () => {
        try {
            const data = await fetchChromecastStatus();
            if (data?.status === 'success') {
                const castStatus = data.data?.status;
                if (castStatus === 'disconnected') {
                    selectedDevice = null;
                    localStorage.removeItem('selectedChromecast');
                    updateIcon('inactive');
                    document.body.classList.remove('chromecast-active');
                    showQuickDisconnect(false);
                    const dcBtn = document.getElementById('disconnect-device-btn');
                    if (dcBtn) dcBtn.style.display = 'none';
                    renderDeviceList(discoveredDevices);
                    toast('Chromecast was disconnected.', 'info');
                    return; // stop polling
                }
                // Adaptive interval: playing → 10s, idle → 30s
                const nextDelay = castStatus === 'playing' ? 10000 : 30000;
                scheduleStatusPoll(nextDelay);
            } else {
                scheduleStatusPoll(15000); // error → retry after 15s
            }
        } catch {
            scheduleStatusPoll(15000);
        }
    }, delay);
}

function stopStatusPolling() {
    if (statusPollTimer) { clearTimeout(statusPollTimer); statusPollTimer = null; }
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
