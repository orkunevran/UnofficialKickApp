/**
 * Unified player module.
 *
 * A single shared <video> element (#sharedVideo) stays alive for the whole
 * session. The element is moved between a hidden parking layer, the mini-player
 * containers, and the channel page slot so playback survives route changes
 * without recreating the media element.
 *
 * Modes:
 *   hidden — parked off-screen while stream state stays alive
 *   mini   — rendered in the mini-player thumb or expanded panel
 *   full   — rendered in the channel page .video-slot
 */

import { castStream } from './chromecast_logic.js';

// ── State ────────────────────────────────────────────────────────────────

let _mode = 'hidden';         // 'hidden' | 'mini' | 'full'
let _hlsInstance = null;
let _currentStream = null;    // { slug, title, channel, playbackUrl, thumbnailUrl }
let _cachedChannelData = null;
let _fullSlot = null;
let _panelHeight = 0;
let _videoEventsBound = false;

const _MIN_PANEL_H = 0;
const _DEFAULT_PANEL_H = 300;
const _SNAP_VALUE = 10;  // slider values below this snap to 0

// ── DOM refs ─────────────────────────────────────────────────────────────

const _layer = () => document.getElementById('video-layer');
const _video = () => document.getElementById('sharedVideo');
const _thumb = () => document.getElementById('mini-player-thumb');
const _miniPlayer = () => document.getElementById('mini-player');
const _expandedPanel = () => document.getElementById('mini-player-expanded-video');

function _isSafari() {
    return document.documentElement.classList.contains('safari');
}

function _supportsExpandedMini() {
    // Slider-driven resize is supported on every viewport. The mini-player
    // expanded panel grows above the bar regardless of width — mobile users
    // can drag the slider to resize the video without leaving the mini state.
    return true;
}

function _moveVideoTo(container) {
    const video = _video();
    if (!video || !container) return;
    if (video.parentElement !== container) container.appendChild(video);
}

function _styleVideoForMode(mode) {
    const video = _video();
    if (!video) return;

    video.style.cssText = '';
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.display = 'block';
    video.style.background = '#000';
    video.style.objectPosition = 'center center';

    if (mode === 'full') {
        video.style.objectFit = 'contain';
        video.style.pointerEvents = 'auto';
        return;
    }

    if (mode === 'mini-expanded') {
        video.style.objectFit = 'contain';
        video.style.pointerEvents = 'none';
        return;
    }

    if (mode === 'mini') {
        video.style.objectFit = 'cover';
        video.style.pointerEvents = 'none';
        return;
    }

    video.style.objectFit = 'contain';
    video.style.pointerEvents = 'none';
}

function _bindVideoStateEvents() {
    const video = _video();
    if (!video || _videoEventsBound) return;

    const syncPaused = () => _updatePlayPauseIcon(video.paused);
    video.addEventListener('play', () => _updatePlayPauseIcon(false));
    video.addEventListener('pause', syncPaused);
    video.addEventListener('ended', syncPaused);
    video.addEventListener('emptied', syncPaused);
    _videoEventsBound = true;
}

function _clearFullSlot() {
    if (_fullSlot) {
        _fullSlot.classList.remove('video-active');
        _fullSlot = null;
    }
}

function _syncPanelChrome() {
    const panel = _expandedPanel();
    const player = _miniPlayer();
    const expanded = _supportsExpandedMini() && _panelHeight > 0;

    if (panel) panel.style.height = expanded ? `${_panelHeight}px` : '0';
    player?.classList.toggle('expanded', expanded);

    // Keep slider thumb in sync when panel changes programmatically
    const slider = document.getElementById('mini-player-slider');
    if (slider) {
        const maxH = Math.round(window.innerHeight * 0.6);
        slider.value = maxH > 0 ? Math.round((_panelHeight / maxH) * 100) : 0;
    }
}

function _renderMiniVideo() {
    const thumb = _thumb();
    const panel = _expandedPanel();
    if (!thumb) return;

    const useExpanded = _supportsExpandedMini() && _panelHeight > 0 && panel;
    _syncPanelChrome();

    _moveVideoTo(useExpanded ? panel : thumb);
    _styleVideoForMode(useExpanded ? 'mini-expanded' : 'mini');
    thumb.classList.toggle('has-video', !useExpanded);
    // Show poster in thumb only when video has moved to the expanded panel;
    // when video is directly in the thumb, hide the poster so live video shows.
    if (useExpanded) {
        _showMiniPoster();
    } else {
        _hideMiniPoster();
    }
}

function _setPanelHeight(h, { syncMiniVideo = true } = {}) {
    if (!_supportsExpandedMini()) {
        _panelHeight = 0;
        _syncPanelChrome();
        return;
    }

    const maxH = Math.round(window.innerHeight * 0.6);
    _panelHeight = Math.max(_MIN_PANEL_H, Math.min(maxH, h));
    _syncPanelChrome();

    if (syncMiniVideo && _mode === 'mini') {
        _renderMiniVideo();
    }
}

function _expandVideoPanel(h) {
    if (!_supportsExpandedMini()) return;
    _setPanelHeight(h);
}

function _collapseVideoPanel(opts = {}) {
    _setPanelHeight(0, opts);
}

function _showMiniBar(skipAnimation) {
    const player = _miniPlayer();
    if (!player) return;

    if (skipAnimation) player.classList.add('no-animate');
    player.classList.remove('hidden');
    if (skipAnimation) requestAnimationFrame(() => player.classList.remove('no-animate'));

    if (_currentStream) {
        const title = _currentStream.title || _currentStream.channel || _currentStream.slug || 'Live Stream';
        document.getElementById('mini-player-title').textContent = title;
        document.getElementById('mini-player-channel').textContent = _currentStream.channel || _currentStream.slug;
    }

    _updateSidebarIndicator(_currentStream?.channel || _currentStream?.slug, true);
    _updatePlayPauseIcon(_video()?.paused ?? true);
    document.body.classList.add('mini-active');
}

function _hideMiniBar() {
    const player = _miniPlayer();
    if (player) {
        player.classList.add('hidden');
        player.classList.remove('expanded');
    }
    document.body.classList.remove('mini-active');
    _updateSidebarIndicator('', false);
    _thumb()?.classList.remove('has-video');
}

function _showMiniPoster() {
    const poster = document.getElementById('mini-player-poster');
    if (!poster) return;

    const thumbnailUrl = _currentStream?.thumbnailUrl;
    if (!thumbnailUrl) {
        poster.removeAttribute('src');
        poster.classList.add('hidden');
        return;
    }

    // Avoid showing the browser's broken-image glyph when channel thumbnails
    // fail to load or return transient errors.
    poster.onerror = () => {
        poster.removeAttribute('src');
        poster.classList.add('hidden');
    };
    poster.src = thumbnailUrl;
    poster.classList.remove('hidden');
}

function _hideMiniPoster() {
    const poster = document.getElementById('mini-player-poster');
    if (poster) poster.classList.add('hidden');
}

// ── Public API ───────────────────────────────────────────────────────────

export function isPlaying() { return _currentStream !== null; }
export function getCurrentStream() { return _currentStream; }
export function getCachedChannelData() { return _cachedChannelData; }
export function getHlsInstance() { return _hlsInstance; }
export function getVideoElement() { return _video(); }

/**
 * Load a stream onto the shared video. Does not change the current visual mode.
 */
export function loadStream(playbackUrl, streamInfo, channelData) {
    _currentStream = streamInfo;
    _cachedChannelData = channelData || null;

    const video = _video();
    if (!video) return;

    _bindVideoStateEvents();

    if (_hlsInstance) {
        _hlsInstance.destroy();
        _hlsInstance = null;
    }

    if (streamInfo?.thumbnailUrl) video.poster = streamInfo.thumbnailUrl;

    // Treat Kick proxy redirect routes as HLS sources; the browser/HLS.js
    // follows the redirect to the actual manifest.
    const isRedirectStream = /\/streams\/(vods|go)\//i.test(playbackUrl);
    const isHLS = isRedirectStream || /\.m3u8($|\?)/i.test(playbackUrl);

    // Native HLS (Safari) — handles both live and VOD M3U8
    if (isHLS && video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = playbackUrl;
        video.muted = true;
        video.play().catch(() => {});
        return;
    }

    // HLS.js (Chrome, Firefox) — for M3U8 manifests
    if (isHLS && window.Hls && window.Hls.isSupported()) {
        const isLive = streamInfo?.type !== 'vod' && streamInfo?.type !== 'clip';
        const hls = new window.Hls({
            lowLatencyMode: isLive,
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 6,
            maxBufferLength: isLive ? 10 : 30,
            maxMaxBufferLength: isLive ? 20 : 60,
            liveDurationInfinity: isLive,
            backBufferLength: isLive ? 15 : 60,
        });

        hls.loadSource(playbackUrl);
        hls.attachMedia(video);
        _hlsInstance = hls;
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
            video.muted = true;
            video.play().catch(() => {});
        });
        return;
    }

    // Direct media (MP4, WebM clips) — native <video> playback
    video.src = playbackUrl;
    video.muted = false;
    video.play().catch(() => {});
}

/**
 * Switch the visual mode of the shared video.
 *
 * @param {'hidden'|'mini'|'full'} mode
 * @param {HTMLElement} [slot]
 * @param {object} [opts]
 * @param {boolean} [opts.animate]
 * @param {boolean} [opts.collapsePanel]
 */
export function setMode(mode, slot, opts = {}) {
    const video = _video();
    if (!video) return;
    if (mode === 'full' && !slot) return;

    _bindVideoStateEvents();

    const prev = _mode;
    const shouldAnimate = Boolean(opts.animate)
        && prev !== 'hidden'
        && mode !== 'hidden'
        && !_isSafari()
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fromRect = shouldAnimate ? video.getBoundingClientRect() : null;
    const collapsePanel = Boolean(opts.collapsePanel);

    _clearFullSlot();
    if (mode !== 'mini' || collapsePanel) {
        _collapseVideoPanel({ syncMiniVideo: false });
    } else {
        _syncPanelChrome();
    }

    if (mode === 'hidden') {
        _mode = 'hidden';
        video.controls = false;
        _hideMiniPoster();
        _hideMiniBar();
        _moveVideoTo(_layer());
        _styleVideoForMode('hidden');
        return;
    }

    if (mode === 'mini') {
        _mode = 'mini';
        video.controls = false;
        _showMiniBar(Boolean(fromRect));
        _renderMiniVideo();
        if (fromRect) _flipAnimate(video, fromRect);
        return;
    }

    _mode = 'full';
    _fullSlot = slot;
    video.controls = true;
    video.muted = false;
    _hideMiniPoster();
    _hideMiniBar();
    _moveVideoTo(_fullSlot);
    _styleVideoForMode('full');
    _fullSlot.classList.add('video-active');
    if (fromRect) _flipAnimate(video, fromRect);
}

/**
 * GPU-composited FLIP animation. Only transform is animated.
 */
function _flipAnimate(video, fromRect) {
    const toRect = video.getBoundingClientRect();
    if (!toRect.width || !toRect.height) return;

    const dx = fromRect.left - toRect.left;
    const dy = fromRect.top - toRect.top;
    const sx = fromRect.width / toRect.width;
    const sy = fromRect.height / toRect.height;

    video.style.transformOrigin = '0 0';
    video.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), border-radius 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
    video.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;

    requestAnimationFrame(() => {
        video.style.transform = 'none';

        const cleanup = () => {
            video.style.transform = '';
            video.style.transformOrigin = '';
            video.style.transition = '';
        };
        video.addEventListener('transitionend', cleanup, { once: true });
        setTimeout(cleanup, 400);
    });
}

export function cacheChannelData(data) {
    _cachedChannelData = data;
}

export function stopStream() {
    if (_hlsInstance) {
        _hlsInstance.destroy();
        _hlsInstance = null;
    }

    const video = _video();
    if (video) {
        video.pause();
        video.removeAttribute('src');
        video.removeAttribute('poster');
        video.load();
    }

    _currentStream = null;
    _cachedChannelData = null;
    setMode('hidden', null, { collapsePanel: true });
}

// ── Mini-player bar controls ─────────────────────────────────────────────

export function initMiniPlayerControls() {
    _bindVideoStateEvents();
    _syncPanelChrome();

    const expandBtn = document.getElementById('mini-player-expand');
    const playBtn = document.getElementById('mini-player-play');
    const castBtn = document.getElementById('mini-player-cast');
    const closeBtn = document.getElementById('mini-player-close');

    expandBtn?.addEventListener('click', () => {
        if (_currentStream?.slug) {
            const { navigate } = window.__routerModule || {};
            if (navigate) navigate(`/channel/${_currentStream.slug}`);
        }
    });

    playBtn?.addEventListener('click', _togglePlayPause);

    castBtn?.addEventListener('click', () => {
        if (_currentStream?.playbackUrl) {
            castStream(_currentStream.playbackUrl, _currentStream.title || 'Kick Stream');
        }
    });

    closeBtn?.addEventListener('click', stopStream);

    _thumb()?.addEventListener('click', () => {
        if (_currentStream?.slug) {
            const { navigate } = window.__routerModule || {};
            if (navigate) navigate(`/channel/${_currentStream.slug}`);
        }
    });

    _initResizeSlider();
}

function _initResizeSlider() {
    const slider = document.getElementById('mini-player-slider');
    if (!slider) return;

    const getMaxH = () => Math.round(window.innerHeight * 0.6);

    slider.addEventListener('input', () => {
        if (!_supportsExpandedMini() || _mode !== 'mini') return;
        const h = Math.round((slider.value / 100) * getMaxH());
        _setPanelHeight(h);
    });

    slider.addEventListener('change', () => {
        if (Number(slider.value) < _SNAP_VALUE) {
            slider.value = 0;
            _collapseVideoPanel();
        }
    });

    slider.addEventListener('dblclick', () => {
        if (!_supportsExpandedMini() || _mode !== 'mini') return;
        if (_panelHeight > 0) {
            _collapseVideoPanel();
        } else {
            _expandVideoPanel(_DEFAULT_PANEL_H);
        }
    });
}

// ── Private helpers ──────────────────────────────────────────────────────

function _togglePlayPause() {
    const video = _video();
    if (!video) return;

    if (video.paused) {
        video.play()
            .then(() => _updatePlayPauseIcon(false))
            .catch(() => _updatePlayPauseIcon(video.paused));
        return;
    }

    video.pause();
}

function _updatePlayPauseIcon(paused) {
    const btn = document.getElementById('mini-player-play');
    if (!btn) return;

    btn.innerHTML = paused
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    btn.title = paused ? 'Play' : 'Pause';
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
