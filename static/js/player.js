/**
 * Mini-player module. Manages the persistent bottom player bar.
 */

import { castStream } from './chromecast_logic.js?v=2.4.8';
import { escapeHtml } from './utils.js?v=2.4.8';

let hlsInstance = null;
let currentStream = null;

export function isPlaying() {
    return currentStream !== null;
}

export function getCurrentStream() {
    return currentStream;
}

export function startMiniPlayer({ slug, title, channel, playbackUrl, thumbnailUrl }) {
    currentStream = { slug, title, channel, playbackUrl, thumbnailUrl };
    const player = document.getElementById('mini-player');
    if (!player) return;

    // Update info
    document.getElementById('mini-player-title').textContent = title || 'Untitled Stream';
    document.getElementById('mini-player-channel').textContent = channel || slug;
    const thumbEl = document.getElementById('mini-player-thumb');
    if (thumbEl) {
        thumbEl.innerHTML = thumbnailUrl
            ? `<img src="${escapeHtml(thumbnailUrl)}" alt="" onerror="this.style.display='none'">`
            : '';
    }

    player.classList.remove('hidden');

    // Update sidebar indicator
    const indicator = document.getElementById('sidebar-now-playing');
    if (indicator) {
        indicator.classList.remove('hidden');
        const text = indicator.querySelector('.now-playing-text');
        if (text) text.textContent = `${channel || slug}`;
    }
}

export function stopMiniPlayer() {
    currentStream = null;
    destroyMiniPlayerVideo();
    const player = document.getElementById('mini-player');
    if (player) player.classList.add('hidden');
    const indicator = document.getElementById('sidebar-now-playing');
    if (indicator) indicator.classList.add('hidden');
}

function destroyMiniPlayerVideo() {
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    const video = document.getElementById('miniPlayerVideo');
    if (video) {
        video.pause();
        video.src = '';
        video.load();
        video.classList.add('hidden');
        video.classList.remove('expanded');
    }
}

export function initMiniPlayerControls() {
    const expandBtn = document.getElementById('mini-player-expand');
    const castBtn = document.getElementById('mini-player-cast');
    const closeBtn = document.getElementById('mini-player-close');

    expandBtn?.addEventListener('click', () => {
        if (currentStream?.slug) {
            // Navigate to channel instead of expanding inline
            const { navigate } = window.__routerModule || {};
            if (navigate) navigate(`/channel/${currentStream.slug}`);
        }
    });

    castBtn?.addEventListener('click', () => {
        if (currentStream?.playbackUrl) {
            castStream(currentStream.playbackUrl, currentStream.title || 'Kick Stream');
        }
    });

    closeBtn?.addEventListener('click', stopMiniPlayer);
}
