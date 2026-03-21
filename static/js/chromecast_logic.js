import { toast } from './toast.js?v=2.3.5';

let isCasting = false;

export async function castStream(streamUrl, title) {
    if (isCasting) return;

    if (!localStorage.getItem('selectedChromecast')) {
        document.dispatchEvent(new CustomEvent('chromecast:request-device', {
            detail: {
                streamUrl,
                title: title || 'Kick Stream',
            },
        }));
        return;
    }

    let selectedDevice;
    try {
        selectedDevice = JSON.parse(localStorage.getItem('selectedChromecast'));
        if (!selectedDevice?.name) throw new Error('Invalid device data');
    } catch {
        localStorage.removeItem('selectedChromecast');
        toast('Saved device data is invalid. Please reconnect.', 'error');
        return;
    }

    isCasting = true;
    toast(`Casting to ${selectedDevice.name}...`, 'info');
    try {
        const response = await fetch('/api/chromecast/cast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stream_url: streamUrl, title }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        toast(
            data.status === 'success' ? 'Casting started successfully.' : 'Failed to start casting.',
            data.status === 'success' ? 'success' : 'error'
        );
    } catch {
        toast(`Error casting to ${selectedDevice.name}.`, 'error');
    } finally {
        isCasting = false;
    }
}
