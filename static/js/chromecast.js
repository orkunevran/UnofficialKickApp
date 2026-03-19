import { showMessage } from './ui.js';

const chromecastButton = document.getElementById('chromecast-button');
const chromecastIcon = document.getElementById('chromecast-icon');
const chromecastModal = document.getElementById('chromecast-modal');
const closeButton = document.querySelector('.close-button');
const deviceList = document.getElementById('chromecast-device-list');
const disconnectButton = document.getElementById('disconnect-device-btn');
const modalSpinner = document.getElementById('modal-spinner');
const rescanButton = document.getElementById('rescan-devices-btn');

let selectedDevice = null;
let statusPollInterval = null;
let isDiscovering = false;
let scanPollTimer = null;
let isScanActive = false;  // True while background scan is running (disables device clicks)
let isSelecting = false;   // Prevent duplicate select clicks

const FETCH_TIMEOUT_MS = 10000;

function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export function initializeChromecast() {
    chromecastButton.addEventListener('click', openModal);
    closeButton.addEventListener('click', closeModal);
    window.addEventListener('click', (event) => {
        if (event.target === chromecastModal) {
            closeModal();
        }
    });
    rescanButton.addEventListener('click', () => discoverDevices(true));
    disconnectButton.addEventListener('click', disconnectDevice);

    // Escape key closes modal
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && chromecastModal.style.display === 'block') {
            closeModal();
        }
    });

    // Clean up polling on page unload
    window.addEventListener('beforeunload', stopStatusPolling);

    // Check for a saved device on load
    const savedDevice = localStorage.getItem('selectedChromecast');
    if (savedDevice) {
        try {
            const parsed = JSON.parse(savedDevice);
            if (parsed && parsed.uuid && parsed.name) {
                selectedDevice = parsed;
                updateIcon('active');
                document.body.classList.add('chromecast-active');
                disconnectButton.style.display = 'block';
                startStatusPolling();
            } else {
                localStorage.removeItem('selectedChromecast');
            }
        } catch (e) {
            console.error('Invalid saved Chromecast data, clearing:', e);
            localStorage.removeItem('selectedChromecast');
        }
    }
}

function openModal() {
    chromecastModal.style.display = 'block';
    requestAnimationFrame(() => chromecastModal.classList.add('visible'));
    discoverDevices(false);
}

function closeModal() {
    chromecastModal.classList.remove('visible');
    setTimeout(() => { chromecastModal.style.display = 'none'; }, 200);
    if (scanPollTimer) {
        clearTimeout(scanPollTimer);
        scanPollTimer = null;
    }
}

function setRescanState(scanning) {
    isScanActive = scanning;
    if (scanning) {
        rescanButton.disabled = true;
        rescanButton.textContent = 'Scanning...';
        modalSpinner.style.display = 'block';
        // Dim device list during scan to indicate they're not clickable
        deviceList.classList.add('scanning-disabled');
    } else {
        rescanButton.disabled = false;
        rescanButton.textContent = 'Rescan';
        modalSpinner.style.display = 'none';
        deviceList.classList.remove('scanning-disabled');
    }
}

async function discoverDevices(force = false) {
    if (isDiscovering) return;
    isDiscovering = true;
    setRescanState(true);

    if (scanPollTimer) {
        clearTimeout(scanPollTimer);
        scanPollTimer = null;
    }

    try {
        const url = force ? '/api/chromecast/devices?force=true' : '/api/chromecast/devices';
        const response = await fetchWithTimeout(url);
        const data = await response.json();
        if (data.status === 'success') {
            const devices = data.data?.devices || [];
            renderDeviceList(devices);

            // If a background scan is running, poll until it finishes
            if (data.data?.scanning) {
                isDiscovering = false;
                scanPollTimer = setTimeout(() => {
                    scanPollTimer = null;
                    discoverDevices(false);
                }, 6000);
                return;  // Keep scanning state active
            }
        } else {
            showMessage('Failed to discover devices.', 'error');
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            showMessage('Device discovery timed out.', 'error');
        } else {
            showMessage('Error discovering devices.', 'error');
        }
        console.error('Error discovering devices:', error);
    }

    setRescanState(false);
    isDiscovering = false;
}

function renderDeviceList(devices) {
    deviceList.innerHTML = '';

    // Show one-click reconnect when no device is selected but we have a last-known device
    const lastUUID = localStorage.getItem('lastChromecastUUID');
    const lastName = localStorage.getItem('lastChromecastName');
    if (!selectedDevice && lastUUID && lastName) {
        const reconnectEl = document.createElement('div');
        reconnectEl.classList.add('device-item', 'reconnect-item');
        reconnectEl.setAttribute('tabindex', '0');
        reconnectEl.setAttribute('role', 'button');
        reconnectEl.innerHTML = `<span class="reconnect-icon">↩</span> Reconnect <strong>${lastName}</strong>`;
        const doReconnect = () => selectDevice({ uuid: lastUUID, name: lastName });
        reconnectEl.addEventListener('click', doReconnect);
        reconnectEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doReconnect(); }
        });
        deviceList.appendChild(reconnectEl);
    }

    if (devices.length === 0) {
        if (!lastUUID) {
            // Nothing to show at all
            if (isScanActive) {
                deviceList.innerHTML = '<p class="scanning-message">Scanning for devices...</p>';
            } else {
                deviceList.innerHTML = '<p>No devices found. Try clicking Rescan.</p>';
            }
        } else if (isScanActive) {
            // Reconnect item already shown above; add scanning note below it
            const note = document.createElement('p');
            note.className = 'scanning-message';
            note.textContent = 'Scanning for devices...';
            deviceList.appendChild(note);
        }
        return;
    }
    devices.forEach(device => {
        const deviceElement = document.createElement('div');
        deviceElement.classList.add('device-item');
        if (selectedDevice && selectedDevice.uuid === device.uuid) {
            deviceElement.classList.add('selected');
        }
        deviceElement.textContent = device.name;
        deviceElement.dataset.uuid = device.uuid;
        deviceElement.setAttribute('tabindex', '0');
        deviceElement.setAttribute('role', 'button');
        deviceElement.addEventListener('click', () => selectDevice(device));
        deviceElement.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectDevice(device);
            }
        });
        deviceList.appendChild(deviceElement);
    });
}

async function selectDevice(device) {
    // Block clicks during scan or if already selecting
    if (isScanActive) {
        showMessage('Please wait for device scan to finish.', 'info');
        return;
    }
    if (isSelecting) {
        return;
    }

    isSelecting = true;
    showMessage(`Connecting to ${device.name}...`, 'info');
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
            localStorage.setItem('lastChromecastName', device.name);
            updateIcon('active');
            document.body.classList.add('chromecast-active');
            disconnectButton.style.display = 'block';
            showMessage(`Connected to ${device.name}.`, 'success');
            closeModal();
            startStatusPolling();
        } else if (response.status === 409) {
            // Scan in progress or busy — auto-retry after scan finishes
            showMessage('Scan in progress, retrying...', 'info');
            setTimeout(() => {
                isSelecting = false;
                selectDevice(device);
            }, 3000);
            return;  // Don't reset isSelecting yet
        } else {
            showMessage(`Failed to connect to ${device.name}.`, 'error');
        }
    } catch (error) {
        showMessage('Error connecting to device.', 'error');
        console.error('Error connecting to device:', error);
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
            if (data.status === 'success') {
                showMessage('Casting stopped on Chromecast device.', 'info');
            } else {
                showMessage('Failed to stop casting on Chromecast device.', 'error');
            }
        } catch (error) {
            showMessage('Error stopping cast on Chromecast device.', 'error');
            console.error('Error stopping cast:', error);
        }
    }
    selectedDevice = null;
    localStorage.removeItem('selectedChromecast');
    updateIcon('inactive');
    document.body.classList.remove('chromecast-active');
    disconnectButton.style.display = 'none';
    
    // Clear selection UI
    const selectedItems = deviceList.querySelectorAll('.device-item.selected');
    selectedItems.forEach(item => item.classList.remove('selected'));
    
    showMessage('Disconnected from Chromecast.', 'info');
    stopStatusPolling();
}

function startStatusPolling() {
    if (statusPollInterval) {
        clearInterval(statusPollInterval);
    }

    statusPollInterval = setInterval(async () => {
        try {
            const response = await fetchWithTimeout('/api/chromecast/status', {}, 8000);
            const data = await response.json();
            if (data.status === 'success' && data.data.status === 'disconnected') {
                // Removed console.log
                selectedDevice = null;
                localStorage.removeItem('selectedChromecast');
                updateIcon('inactive');
                document.body.classList.remove('chromecast-active');
                disconnectButton.style.display = 'none';
                
                // Clear selection UI
                const selectedItems = deviceList.querySelectorAll('.device-item.selected');
                selectedItems.forEach(item => item.classList.remove('selected'));
                
                showMessage('Chromecast was disconnected.', 'info');
                stopStatusPolling();
            }
        } catch (error) {
            console.error('Error polling Chromecast status:', error);
            stopStatusPolling();
        }
    }, 5000);
}

function stopStatusPolling() {
    if (statusPollInterval) {
        clearInterval(statusPollInterval);
        statusPollInterval = null;
    }
}

function updateIcon(status) {
    if (status === 'active') {
        chromecastIcon.src = '/static/icons/chromecast-active.svg';
        chromecastButton.classList.add('active');
    } else {
        chromecastIcon.src = '/static/icons/chromecast.svg';
        chromecastButton.classList.remove('active');
    }
}
