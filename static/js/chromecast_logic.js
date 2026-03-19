import { showMessage } from './ui.js';

let isCasting = false;

export async function castStream(streamUrl, title) {
    if (isCasting) return;

    if (!localStorage.getItem('selectedChromecast')) {
        showMessage('Please select a Chromecast device first.', 'error');
        return;
    }

    let selectedDevice;
    try {
        selectedDevice = JSON.parse(localStorage.getItem('selectedChromecast'));
        if (!selectedDevice || !selectedDevice.name) {
            throw new Error('Invalid device data');
        }
    } catch (e) {
        console.error('Invalid saved Chromecast data:', e);
        localStorage.removeItem('selectedChromecast');
        showMessage('Saved device data is invalid. Please reconnect.', 'error');
        return;
    }

    isCasting = true;
    showMessage(`Casting to ${selectedDevice.name}...`, 'info');
    try {
        const response = await fetch('/api/chromecast/cast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stream_url: streamUrl, title: title }),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        console.log('Cast stream API response:', data);
        if (data.status === 'success') {
            showMessage('Casting started successfully.', 'success');
        } else {
            showMessage('Failed to start casting.', 'error');
        }
    } catch (error) {
        showMessage(`Error casting to ${selectedDevice.name}.`, 'error');
        console.error(`Error casting stream (device: ${selectedDevice.name}, url: ${streamUrl}):`, error);
    } finally {
        isCasting = false;
    }
}
