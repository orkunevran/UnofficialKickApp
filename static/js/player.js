/**
 * Mini-player module.
 *
 * Keeps a live HLS stream playing in a small bottom bar while the user
 * browses other pages. The HLS.js instance is *transferred* from the
 * full-size channel player rather than destroyed and recreated, so
 * playback is seamless with no rebuffering.
 */

import { castStream } from './chromecast_logic.js?v=2.4.8';
import { escapeHtml } from './utils.js?v=2.4.8';

let hlsInstance = null;   // HLS.js instance owned by the mini player
let currentStream = null; // { slug, title, channel, playbackUrl, thumbnailUrl }

// ── Public API ───────────────────────────────────────────────────────────

export function isPlaying() {
    return currentStream !== null;
}

export function getCurrentStream() {
    return currentStream;
}

/**
 * Activate the mini player with a live HLS stream.
 *
 * @param {object}  data           Stream metadata
 * @param {Hls}     [hls]          HLS.js instance to transfer (keeps playback alive)
 * @param {HTMLVideoElement} [sourceVideo] The video element HLS is currently attached to
 */
export function startMiniPlayer({ slug, title, channel, playbackUrl, thumbnailUrl }, hls, sourceVideo) {
    currentStream = { slug, title, channel, playbackUrl, thumbnailUrl };

    const player = document.getElementById('mini-player');
    if (!player) return;

    // Update text info
    document.getElementById('mini-player-title').textContent = title || channel || slug || 'Live Stream';
    document.getElementById('mini-player-channel').textContent = channel || slug;

    const miniVideo = document.getElementById('miniPlayerVideo');

    if (hls && miniVideo) {
        // Transfer the live HLS instance to the mini player video element.
        // detachMedia + attachMedia keeps buffers and avoids a re-fetch.
        hls.detachMedia();
        hls.attachMedia(miniVideo);
        miniVideo.muted = false;
        miniVideo.play().catch(() => {});
        hlsInstance = hls;
        miniVideo.classList.remove('hidden');
        _hideThumbnail();
        _updatePlayPauseIcon(false);
    } else if (sourceVideo && miniVideo && sourceVideo.src) {
        // Native HLS (Safari) — copy the src directly
        miniVideo.src = sourceVideo.src;
        miniVideo.currentTime = sourceVideo.currentTime;
        miniVideo.muted = false;
        miniVideo.play().catch(() => {});
        miniVideo.classList.remove('hidden');
        _hideThumbnail();
        _updatePlayPauseIcon(false);
    } else {
        // No transferable player — show thumbnail fallback
        _showThumbnail(thumbnailUrl);
        if (miniVideo) miniVideo.classList.add('hidden');
    }

    player.classList.remove('hidden');
    _updateSidebarIndicator(channel || slug, true);
}

/**
 * Reclaim the HLS instance from the mini player back to a full-size video.
 * Returns the HLS.js instance (or null) so the caller can attach it.
 *
 * The mini player bar stays visible during the handoff to avoid a visual gap.
 * Call {@link hideMiniPlayer} once the target video is actually rendering.
 */
export function reclaimHls() {
    const hls = hlsInstance;
    hlsInstance = null;
    currentStream = null;

    if (hls) hls.detachMedia();
    // Don't hide the mini player yet — caller hides it after the main video is ready
    return hls;
}

/** Hide the mini player bar (called after the main video is rendering). */
export function hideMiniPlayer() {
    _collapseVideoPanel();
    const miniVideo = document.getElementById('miniPlayerVideo');
    if (miniVideo) { miniVideo.pause(); miniVideo.classList.add('hidden'); }
    const player = document.getElementById('mini-player');
    if (player) player.classList.add('hidden');
    _updateSidebarIndicator('', false);
}

export function stopMiniPlayer() {
    currentStream = null;
    _collapseVideoPanel();
    _destroyVideo();
    const player = document.getElementById('mini-player');
    if (player) player.classList.add('hidden');
    _updateSidebarIndicator('', false);
}

export function initMiniPlayerControls() {
    const expandBtn  = document.getElementById('mini-player-expand');
    const playBtn    = document.getElementById('mini-player-play');
    const castBtn    = document.getElementById('mini-player-cast');
    const closeBtn   = document.getElementById('mini-player-close');

    expandBtn?.addEventListener('click', () => {
        if (currentStream?.slug) {
            _collapseVideoPanel();
            const { navigate } = window.__routerModule || {};
            if (navigate) navigate(`/channel/${currentStream.slug}`);
        }
    });

    playBtn?.addEventListener('click', _togglePlayPause);

    castBtn?.addEventListener('click', () => {
        if (currentStream?.playbackUrl) {
            castStream(currentStream.playbackUrl, currentStream.title || 'Kick Stream');
        }
    });

    closeBtn?.addEventListener('click', () => {
        _collapseVideoPanel();
        stopMiniPlayer();
    });

    // Clicking the thumbnail/video area also expands
    const thumb = document.getElementById('mini-player-thumb');
    thumb?.addEventListener('click', () => {
        if (currentStream?.slug) {
            _collapseVideoPanel();
            const { navigate } = window.__routerModule || {};
            if (navigate) navigate(`/channel/${currentStream.slug}`);
        }
    });

    _initResizeHandle();
}

// ── Resize / Expand Panel ────────────────────────────────────────────────

const _MIN_PANEL_H = 0;
const _DEFAULT_PANEL_H = 300;
const _SNAP_THRESHOLD = 80;
const _DRAG_DEAD_ZONE = 4; // px moved before drag activates

let _panelHeight = 0;
let _dragging = false;

function _initResizeHandle() {
    const handle = document.getElementById('mini-player-resize');
    if (!handle) return;

    let startY = 0;
    let startH = 0;
    let activated = false; // true once pointer moves past dead zone

    const onPointerDown = (e) => {
        if (window.innerWidth < 768) return;
        e.preventDefault();
        startY = e.clientY;
        startH = _panelHeight;
        activated = false;
        _dragging = true;
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
    };

    const onPointerMove = (e) => {
        if (!_dragging) return;
        const delta = startY - e.clientY;
        // Don't commit to a drag until past the dead zone
        if (!activated) {
            if (Math.abs(delta) < _DRAG_DEAD_ZONE) return;
            activated = true;
            // Disable transition for smooth dragging
            const panel = document.getElementById('mini-player-expanded-video');
            if (panel) panel.style.transition = 'none';
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
        }
        const maxH = Math.round(window.innerHeight * 0.6);
        _setPanelHeight(Math.max(_MIN_PANEL_H, Math.min(maxH, startH + delta)));
    };

    const onPointerUp = () => {
        _dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        // Re-enable transition
        const panel = document.getElementById('mini-player-expanded-video');
        if (panel) panel.style.transition = '';
        if (activated && _panelHeight < _SNAP_THRESHOLD) {
            _collapseVideoPanel();
        }
    };

    handle.addEventListener('pointerdown', onPointerDown);

    // Double-click toggles collapsed ↔ expanded
    handle.addEventListener('dblclick', () => {
        if (window.innerWidth < 768) return;
        _panelHeight > 0 ? _collapseVideoPanel() : _expandVideoPanel(_DEFAULT_PANEL_H);
    });
}

function _setPanelHeight(h) {
    const panel = document.getElementById('mini-player-expanded-video');
    const player = document.getElementById('mini-player');
    if (!panel) return;

    _panelHeight = h;
    panel.style.height = h > 0 ? `${h}px` : '0';

    if (h > 0) {
        _moveVideoToPanel();
        player?.classList.add('expanded');
    } else {
        _moveVideoToThumb();
        player?.classList.remove('expanded');
    }
}

function _expandVideoPanel(h) {
    const maxH = Math.round(window.innerHeight * 0.6);
    _setPanelHeight(Math.min(h, maxH));
}

function _collapseVideoPanel() {
    _setPanelHeight(0);
}

function _moveVideoToPanel() {
    const video = document.getElementById('miniPlayerVideo');
    const panel = document.getElementById('mini-player-expanded-video');
    if (video && panel && video.parentElement !== panel) {
        panel.appendChild(video);
        video.classList.remove('hidden');
    }
}

function _moveVideoToThumb() {
    const video = document.getElementById('miniPlayerVideo');
    const thumb = document.getElementById('mini-player-thumb');
    if (video && thumb && video.parentElement !== thumb) {
        thumb.prepend(video);
        video.classList.remove('hidden');
    }
}

// ── Private helpers ──────────────────────────────────────────────────────

function _destroyVideo() {
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    const video = document.getElementById('miniPlayerVideo');
    if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.classList.add('hidden');
    }
}

function _togglePlayPause() {
    const video = document.getElementById('miniPlayerVideo');
    if (!video || video.classList.contains('hidden')) return;

    if (video.paused) {
        video.play().catch(() => {});
        _updatePlayPauseIcon(false);
    } else {
        video.pause();
        _updatePlayPauseIcon(true);
    }
}

function _updatePlayPauseIcon(paused) {
    const btn = document.getElementById('mini-player-play');
    if (!btn) return;
    btn.innerHTML = paused
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    btn.title = paused ? 'Play' : 'Pause';
}

function _showThumbnail(url) {
    const poster = document.getElementById('mini-player-poster');
    if (!poster) return;
    if (url) {
        poster.src = url;
        poster.classList.remove('hidden');
    } else {
        poster.classList.add('hidden');
    }
}

function _hideThumbnail() {
    const poster = document.getElementById('mini-player-poster');
    if (poster) poster.classList.add('hidden');
}

function _updateSidebarIndicator(channel, show) {
    const indicator = document.getElementById('sidebar-now-playing');
    if (!indicator) return;
    indicator.classList.toggle('hidden', !show);
    if (show) {
        const text = indicator.querySelector('.now-playing-text');
        if (text) text.textContent = channel;
    }
}
