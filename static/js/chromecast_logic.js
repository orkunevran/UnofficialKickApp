import { toast } from './toast.js?v=2.3.7';
import { postChromecastCast } from './api.js?v=2.3.7';

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
        const data = await postChromecastCast(streamUrl, title);
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
