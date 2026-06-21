import { toast } from './toast.js';
import { postChromecastCast } from './api.js';

let isCasting = false;

/**
 * Resolve a URL that may be a local redirect endpoint (e.g. /streams/vods/...)
 * to its final absolute media URL.  If the URL is already absolute, return as-is.
 */
async function _resolveMediaUrl(url) {
    if (!url || url.startsWith('http://') || url.startsWith('https://')) return url;

    // Relative path — follow the redirect and read the final URL. This MUST be
    // bounded: without a timeout a stalled backend leaves the await pending
    // forever, which leaves isCasting stuck true and silently kills the cast
    // button for the whole session. On timeout/error we fall through to the
    // original URL (the backend resolves the redirect itself when it loads it).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const resp = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
        if (resp.url && resp.url !== url && resp.url.startsWith('http')) return resp.url;
    } catch { /* fall through */ } finally {
        clearTimeout(timer);
    }

    return url;
}

export async function castStream(streamUrl, title) {
    if (isCasting) return;

    if (!streamUrl || typeof streamUrl !== 'string') {
        toast('No stream URL available to cast.', 'error');
        return;
    }

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
        // Resolve redirect URLs (e.g. /streams/vods/slug/id → actual M3U8)
        const resolvedUrl = await _resolveMediaUrl(streamUrl);
        const data = await postChromecastCast(resolvedUrl, title);
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
