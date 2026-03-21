import { toast } from './toast.js?v=2.3.5';
import { castStream } from './chromecast_logic.js?v=2.3.5';

const FETCH_TIMEOUT_MS = 10000;

function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

let selectedDevice = null;
let statusPollInterval = null;
let isDiscovering = false;
let scanPollTimer = null;
let isScanActive = false;
let isSelecting = false;
let discoveredDevices = [];
let deviceSearchQuery = '';
let pendingCastRequest = null;
let chromecastListenersBound = false;

export function initializeChromecast() {
    if (chromecastListenersBound) return;

    const chromecastButton = document.getElementById('chromecast-button');
    const chromecastModal = document.getElementById('chromecast-modal');
    const closeButton = chromecastModal?.querySelector('.close-button');
    const rescanButton = document.getElementById('rescan-devices-btn');
    const disconnectButton = document.getElementById('disconnect-device-btn');
    const deviceSearchInput = document.getElementById('chromecast-device-search');
    const hostDiscoverButton = document.getElementById('chromecast-host-discover-btn');
    const hostInput = document.getElementById('chromecast-host-input');

    if (!chromecastButton || !chromecastModal) return;

    chromecastListenersBound = true;
    chromecastButton.addEventListener('click', openModal);
    closeButton?.addEventListener('click', closeModal);
    window.addEventListener('click', (event) => {
        if (event.target === chromecastModal) closeModal();
    });
    rescanButton?.addEventListener('click', () => discoverDevices(true));
    disconnectButton?.addEventListener('click', disconnectDevice);
    deviceSearchInput?.addEventListener('input', handleDeviceSearchInput);
    deviceSearchInput?.addEventListener('keydown', handleDeviceSearchKeydown);
    hostDiscoverButton?.addEventListener('click', handleHostDiscoveryClick);
    hostInput?.addEventListener('keydown', handleHostInputKeydown);
    document.addEventListener('chromecast:request-device', handleChromecastRequestDevice);

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || chromecastModal.style.display !== 'block') return;
        const targetTag = event.target?.tagName;
        if (targetTag === 'INPUT' || targetTag === 'TEXTAREA' || targetTag === 'SELECT' || event.target?.isContentEditable) {
            return;
        }
        closeModal();
    });

    window.addEventListener('beforeunload', stopStatusPolling);

    // Check for saved device
    const savedDevice = localStorage.getItem('selectedChromecast');
    if (savedDevice) {
        try {
            const parsed = JSON.parse(savedDevice);
            if (parsed?.uuid && parsed?.name) {
                selectedDevice = parsed;
                updateIcon('active');
                document.body.classList.add('chromecast-active');
                if (disconnectButton) disconnectButton.style.display = 'block';
                startStatusPolling();
            } else {
                localStorage.removeItem('selectedChromecast');
            }
        } catch {
            localStorage.removeItem('selectedChromecast');
        }
    }

    renderDeviceList(discoveredDevices);
}

let focusTrapHandler = null;

function openModal() {
    const modal = document.getElementById('chromecast-modal');
    if (!modal) return;
    modal.style.display = 'block';
    requestAnimationFrame(() => modal.classList.add('visible'));

    // Focus trap
    const content = modal.querySelector('.modal-content');
    if (content) {
        const firstFocusable = content.querySelector('#chromecast-device-search') || content.querySelector('button');
        if (firstFocusable) firstFocusable.focus();
        focusTrapHandler = (e) => {
            if (e.key !== 'Tab') return;
            const focusable = content.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])');
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey) {
                if (document.activeElement === first) { e.preventDefault(); last.focus(); }
            } else {
                if (document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        };
        modal.addEventListener('keydown', focusTrapHandler);
    }

    discoverDevices(false);

    const searchInput = document.getElementById('chromecast-device-search');
    if (searchInput) {
        requestAnimationFrame(() => searchInput.focus());
    }
}

function closeModal() {
    const modal = document.getElementById('chromecast-modal');
    if (!modal) return;
    if (focusTrapHandler) {
        modal.removeEventListener('keydown', focusTrapHandler);
        focusTrapHandler = null;
    }
    modal.classList.remove('visible');
    setTimeout(() => { modal.style.display = 'none'; }, 200);
    if (scanPollTimer) { clearTimeout(scanPollTimer); scanPollTimer = null; }
    pendingCastRequest = null;
    deviceSearchQuery = '';
    const searchInput = document.getElementById('chromecast-device-search');
    if (searchInput) searchInput.value = '';
    const hostInput = document.getElementById('chromecast-host-input');
    if (hostInput) hostInput.value = '';
    renderDeviceList(discoveredDevices);
}

function handleChromecastRequestDevice(event) {
    const detail = event?.detail || {};
    if (detail.streamUrl) {
        pendingCastRequest = {
            streamUrl: detail.streamUrl,
            title: detail.title || 'Kick Stream',
        };
    }
    openModal();
}

function handleDeviceSearchInput(event) {
    deviceSearchQuery = event.target?.value?.trim() || '';
    renderDeviceList(discoveredDevices);
}

function handleDeviceSearchKeydown(event) {
    if (event.key !== 'Enter') return;
    const deviceList = document.getElementById('chromecast-device-list');
    const firstSelectable = deviceList?.querySelector('.device-item[role="button"]');
    if (!firstSelectable) return;
    event.preventDefault();
    firstSelectable.click();
}

function handleHostDiscoveryClick() {
    const hostInput = document.getElementById('chromecast-host-input');
    const host = hostInput?.value.trim() || '';
    if (!host) {
        toast('Enter a Chromecast IP or hostname first.', 'info');
        return;
    }
    if (isDiscovering) {
        toast('Wait for the current scan to finish, then try the host again.', 'info');
        return;
    }
    void discoverDevices(true, host);
}

function handleHostInputKeydown(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    handleHostDiscoveryClick();
}

function getFilteredDevices(devices) {
    const query = deviceSearchQuery.toLowerCase();
    if (!query) return devices || [];
    return (devices || []).filter((device) => {
        const name = String(device?.name || '').toLowerCase();
        const uuid = String(device?.uuid || '').toLowerCase();
        return name.includes(query) || uuid.includes(query);
    });
}

function shouldShowReconnectItem(filteredDevices) {
    const lastUUID = localStorage.getItem('lastChromecastUUID');
    const lastName = localStorage.getItem('lastChromecastName');
    if (selectedDevice || !lastUUID || !lastName) return false;
    if ((filteredDevices || []).some(device => device?.uuid === lastUUID)) return false;
    return getFilteredDevices([{ name: lastName, uuid: lastUUID }]).length > 0;
}

function updateDeviceSummary(visibleCount, hasReconnect) {
    const summary = document.getElementById('chromecast-device-summary');
    if (!summary) return;

    if (isScanActive) {
        summary.textContent = 'Scanning for Chromecast devices...';
        return;
    }

    const query = deviceSearchQuery.trim();
    if (query) {
        summary.textContent = visibleCount === 0
            ? `No devices match "${query}".`
            : `${visibleCount} device${visibleCount === 1 ? '' : 's'} match "${query}".`;
        return;
    }

    if (selectedDevice?.name) {
        summary.textContent = visibleCount === 0
            ? `Connected to ${selectedDevice.name} • no other devices discovered`
            : `Connected to ${selectedDevice.name} • ${visibleCount} device${visibleCount === 1 ? '' : 's'} available`;
        return;
    }

    if (visibleCount === 0) {
        summary.textContent = hasReconnect
            ? 'No devices currently visible. Reconnect your last device or click Rescan.'
            : 'No devices discovered yet. If you know the IP or hostname, use the field above.';
        return;
    }

    summary.textContent = hasReconnect
        ? `${visibleCount} device${visibleCount === 1 ? '' : 's'} available • last device can be reconnected`
        : `${visibleCount} device${visibleCount === 1 ? '' : 's'} available`;
}

function createDeviceItem(device, { selected = false, reconnect = false } = {}) {
    const deviceName = String(device?.name || 'Unknown device');
    const deviceUuid = String(device?.uuid || '');
    const el = document.createElement('div');
    el.classList.add('device-item');
    if (reconnect) el.classList.add('reconnect-item');
    if (selected) el.classList.add('selected');
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.dataset.uuid = deviceUuid;

    const main = document.createElement('div');
    main.className = 'device-item-main';

    const name = document.createElement('span');
    name.className = 'device-item-name';
    name.textContent = reconnect ? `Reconnect ${deviceName}` : deviceName;

    const uuid = document.createElement('span');
    uuid.className = 'device-item-uuid';
    uuid.textContent = deviceUuid;

    main.appendChild(name);
    main.appendChild(uuid);
    el.appendChild(main);

    if (selected) {
        const badge = document.createElement('span');
        badge.className = 'device-item-selected-badge';
        badge.textContent = 'Selected';
        el.appendChild(badge);
    }

    const doSelect = () => selectDevice(device);
    el.addEventListener('click', doSelect);
    el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            doSelect();
        }
    });

    return el;
}

function setRescanState(scanning) {
    isScanActive = scanning;
    const rescanButton = document.getElementById('rescan-devices-btn');
    const hostButton = document.getElementById('chromecast-host-discover-btn');
    const hostInput = document.getElementById('chromecast-host-input');
    const modalSpinner = document.getElementById('modal-spinner');
    const deviceList = document.getElementById('chromecast-device-list');

    if (scanning) {
        if (rescanButton) { rescanButton.disabled = true; rescanButton.textContent = 'Scanning...'; }
        if (hostButton) hostButton.disabled = true;
        if (hostInput) hostInput.disabled = true;
        if (modalSpinner) modalSpinner.style.display = 'block';
        deviceList?.classList.add('scanning-disabled');
    } else {
        if (rescanButton) { rescanButton.disabled = false; rescanButton.textContent = 'Rescan'; }
        if (hostButton) hostButton.disabled = false;
        if (hostInput) hostInput.disabled = false;
        if (modalSpinner) modalSpinner.style.display = 'none';
        deviceList?.classList.remove('scanning-disabled');
    }

    const filteredDevices = getFilteredDevices(discoveredDevices);
    const reconnectVisible = shouldShowReconnectItem(filteredDevices);
    updateDeviceSummary(filteredDevices.length + (reconnectVisible ? 1 : 0), reconnectVisible);
}

async function discoverDevices(force = false, knownHosts = null) {
    if (isDiscovering) return;
    isDiscovering = true;
    setRescanState(true);

    if (scanPollTimer) { clearTimeout(scanPollTimer); scanPollTimer = null; }

    try {
        const url = new URL('/api/chromecast/devices', window.location.origin);
        if (force) url.searchParams.set('force', 'true');
        if (knownHosts) url.searchParams.set('known_hosts', knownHosts);
        const response = await fetchWithTimeout(url);
        const data = await response.json();
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
        toast(error.name === 'AbortError' ? 'Device discovery timed out.' : 'Error discovering devices.', 'error');
        console.error('Error discovering devices:', error);
    }

    setRescanState(false);
    isDiscovering = false;
}

function renderDeviceList(devices) {
    const deviceList = document.getElementById('chromecast-device-list');
    if (!deviceList) return;
    discoveredDevices = Array.isArray(devices) ? devices : [];
    const filteredDevices = getFilteredDevices(discoveredDevices);
    deviceList.innerHTML = '';

    const lastUUID = localStorage.getItem('lastChromecastUUID');
    const lastName = localStorage.getItem('lastChromecastName');
    const showReconnect = shouldShowReconnectItem(filteredDevices);

    if (showReconnect) {
        const reconnectEl = document.createElement('div');
        reconnectEl.classList.add('device-item', 'reconnect-item');
        reconnectEl.setAttribute('tabindex', '0');
        reconnectEl.setAttribute('role', 'button');
        reconnectEl.dataset.uuid = lastUUID;

        const main = document.createElement('div');
        main.className = 'device-item-main';

        const name = document.createElement('span');
        name.className = 'device-item-name';
        name.textContent = `Reconnect ${lastName}`;

        const uuid = document.createElement('span');
        uuid.className = 'device-item-uuid';
        uuid.textContent = lastUUID;

        main.appendChild(name);
        main.appendChild(uuid);
        reconnectEl.appendChild(main);

        const doReconnect = () => selectDevice({ uuid: lastUUID, name: lastName });
        reconnectEl.addEventListener('click', doReconnect);
        reconnectEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                doReconnect();
            }
        });
        deviceList.appendChild(reconnectEl);
    }

    if (filteredDevices.length > 0) {
        filteredDevices.forEach(device => {
            const el = createDeviceItem(device, { selected: selectedDevice?.uuid === device.uuid });
            deviceList.appendChild(el);
        });
    }

    if (filteredDevices.length === 0 && !showReconnect) {
        if (deviceSearchQuery.trim()) {
            const note = document.createElement('p');
            note.className = 'scanning-message';
            note.textContent = `No devices match "${deviceSearchQuery.trim()}".`;
            deviceList.appendChild(note);
        } else if (isScanActive) {
            const note = document.createElement('p');
            note.className = 'scanning-message';
            note.textContent = 'Scanning for devices...';
            deviceList.appendChild(note);
        } else {
            const note = document.createElement('p');
            note.className = 'scanning-message';
            note.textContent = lastUUID
                ? 'No devices currently visible. Click Rescan to refresh the list.'
                : 'No devices found. If discovery fails in Docker, try entering a Chromecast IP or hostname above.';
            deviceList.appendChild(note);
        }
    }

    updateDeviceSummary(filteredDevices.length + (showReconnect ? 1 : 0), showReconnect);
}

async function selectDevice(device) {
    if (isScanActive) { toast('Please wait for device scan to finish.', 'info'); return; }
    if (isSelecting) return;

    isSelecting = true;
    const deviceName = String(device?.name || 'Chromecast');
    toast(`Connecting to ${deviceName}...`, 'info');
    try {
        const response = await fetchWithTimeout('/api/chromecast/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uuid: device.uuid }),
        }, 20000);
        const data = await response.json();
        if (data.status === 'success') {
            selectedDevice = device;
            localStorage.setItem('selectedChromecast', JSON.stringify(device));
            localStorage.setItem('lastChromecastUUID', device.uuid);
            localStorage.setItem('lastChromecastName', deviceName);
            updateIcon('active');
            document.body.classList.add('chromecast-active');
            const dcBtn = document.getElementById('disconnect-device-btn');
            if (dcBtn) dcBtn.style.display = 'block';
            toast(`Connected to ${deviceName}`, 'success');
            const pendingCast = pendingCastRequest;
            pendingCastRequest = null;
            closeModal();
            startStatusPolling();
            if (pendingCast?.streamUrl) {
                setTimeout(() => {
                    castStream(pendingCast.streamUrl, pendingCast.title || 'Kick Stream');
                }, 0);
            }
        } else if (response.status === 409) {
            toast('Scan in progress, retrying...', 'info');
            setTimeout(() => { isSelecting = false; selectDevice(device); }, 3000);
            return;
        } else {
            toast(`Failed to connect to ${deviceName}.`, 'error');
        }
    } catch {
        toast(`Error connecting to ${deviceName}.`, 'error');
    }
    isSelecting = false;
}

async function disconnectDevice() {
    if (selectedDevice) {
        try {
            const response = await fetchWithTimeout('/api/chromecast/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uuid: selectedDevice.uuid }),
            });
            const data = await response.json();
            toast(data.status === 'success' ? 'Casting stopped.' : 'Failed to stop casting.', data.status === 'success' ? 'info' : 'error');
        } catch {
            toast('Error stopping cast.', 'error');
        }
    }
    selectedDevice = null;
    pendingCastRequest = null;
    localStorage.removeItem('selectedChromecast');
    updateIcon('inactive');
    document.body.classList.remove('chromecast-active');
    const dcBtn = document.getElementById('disconnect-device-btn');
    if (dcBtn) dcBtn.style.display = 'none';
    renderDeviceList(discoveredDevices);
    toast('Disconnected from Chromecast.', 'info');
    stopStatusPolling();
}

function startStatusPolling() {
    if (statusPollInterval) clearInterval(statusPollInterval);
    statusPollInterval = setInterval(async () => {
        try {
            const response = await fetchWithTimeout('/api/chromecast/status', {}, 8000);
            const data = await response.json();
            if (data.status === 'success' && data.data.status === 'disconnected') {
                selectedDevice = null;
                localStorage.removeItem('selectedChromecast');
                updateIcon('inactive');
                document.body.classList.remove('chromecast-active');
                const dcBtn = document.getElementById('disconnect-device-btn');
                if (dcBtn) dcBtn.style.display = 'none';
                renderDeviceList(discoveredDevices);
                toast('Chromecast was disconnected.', 'info');
                stopStatusPolling();
            }
        } catch {
            stopStatusPolling();
        }
    }, 5000);
}

function stopStatusPolling() {
    if (statusPollInterval) { clearInterval(statusPollInterval); statusPollInterval = null; }
}

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
