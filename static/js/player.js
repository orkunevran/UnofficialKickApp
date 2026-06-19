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
let _videoEventsBound = false;

// Picture-in-picture geometry (persisted). The mini-player is a floating,
// draggable, resizable 16:9 window — not a bottom bar with a size slider.
const _PIP_MIN_W = 240;
const _PIP_MAX_W = 1600;         // hard ceiling; the viewport is the real limit
const _PIP_DEFAULT_W = 360;
const _PIP_EDGE = 8;             // min gap kept between the card and viewport edges
const _CONTROL_STRIP_H = 52;     // approx height of the control row under the video
const _PIP_STORAGE_KEY = 'kick_pip_geom';

let _pipW = _PIP_DEFAULT_W;
let _pipLeft = null;             // px from viewport left; null → compute bottom-right
let _pipTop = null;

// ── DOM refs ─────────────────────────────────────────────────────────────

const _layer = () => document.getElementById('video-layer');
const _video = () => document.getElementById('sharedVideo');
const _thumb = () => document.getElementById('mini-player-thumb');
const _miniPlayer = () => document.getElementById('mini-player');
const _theaterLayer = () => document.getElementById('theater-layer');

function _isSafari() {
    return document.documentElement.classList.contains('safari');
}

// Below 768px the mini-player docks as a fixed bottom bar (styled in CSS);
// the floating/draggable PiP geometry is desktop-only.
function _isMobile() {
    return window.matchMedia('(max-width: 767px)').matches;
}

// A phone in landscape (short + wide): a live stream in full mode goes into the
// fullscreen "theater" overlay rather than the in-page slot, which would sit
// below the fold. iOS blocks programmatic native fullscreen, so this is a
// CSS overlay, not the Fullscreen API.
function _isLandscapePhone() {
    return window.matchMedia('(orientation: landscape) and (max-height: 500px)').matches;
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

    if (mode === 'mini') {
        // cover fills the 16:9 PiP window; pointer-events:none lets the thumb
        // receive drag gestures instead of the video swallowing them.
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

// ── PiP geometry: clamp, persist, apply ──────────────────────────────────

function _pipMaxW() {
    // Bound by both viewport dimensions so the whole card (16:9 video + control
    // strip) always fits — width on landscape, height on short/wide windows.
    const byWidth = window.innerWidth - _PIP_EDGE * 2;
    const byHeight = ((window.innerHeight - _PIP_EDGE * 2 - _CONTROL_STRIP_H) * 16) / 9;
    return Math.max(_PIP_MIN_W, Math.min(_PIP_MAX_W, byWidth, byHeight));
}

// Default bottom-right anchor; clears the mobile nav on narrow viewports.
function _pipMargin() {
    return window.innerWidth <= 768 ? 84 : 24;
}

function _cardHeightFor(width) {
    return Math.round((width * 9) / 16) + _CONTROL_STRIP_H;
}

// _applyPipGeometry writes width + position to the card, clamping it fully
// inside the viewport. Position defaults to the bottom-right corner.
function _applyPipGeometry() {
    const card = _miniPlayer();
    if (!card) return;
    // On mobile the bar is docked via CSS — don't impose floating coordinates.
    if (_isMobile()) return;
    // Skip while the viewport has no layout (zero size during route
    // transitions / background tabs); applying now would clamp the window into
    // the corner. A later resize/render recomputes once dimensions are real.
    if (window.innerWidth === 0 || window.innerHeight === 0) return;

    _pipW = Math.max(_PIP_MIN_W, Math.min(_pipMaxW(), _pipW));
    const w = _pipW;
    const h = _cardHeightFor(w);

    let left = _pipLeft;
    let top = _pipTop;
    if (left == null || top == null) {
        const m = _pipMargin();
        left = window.innerWidth - w - m;
        top = window.innerHeight - h - m;
    }
    left = Math.max(_PIP_EDGE, Math.min(window.innerWidth - w - _PIP_EDGE, left));
    top = Math.max(_PIP_EDGE, Math.min(window.innerHeight - h - _PIP_EDGE, top));
    _pipLeft = left;
    _pipTop = top;

    card.style.width = `${w}px`;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    card.style.right = 'auto';
    card.style.bottom = 'auto';
}

function _savePipGeom() {
    try {
        localStorage.setItem(_PIP_STORAGE_KEY, JSON.stringify({ w: _pipW, left: _pipLeft, top: _pipTop }));
    } catch { /* storage unavailable — geometry just won't persist */ }
}

function _loadPipGeom() {
    try {
        const g = JSON.parse(localStorage.getItem(_PIP_STORAGE_KEY) || 'null');
        if (g && typeof g.w === 'number') _pipW = g.w;
        if (g && typeof g.left === 'number') _pipLeft = g.left;
        if (g && typeof g.top === 'number') _pipTop = g.top;
    } catch { /* ignore malformed state */ }
}

function _renderMiniVideo() {
    const thumb = _thumb();
    if (!thumb) return;
    _moveVideoTo(thumb);
    _styleVideoForMode('mini');
    thumb.classList.add('has-video');
    _hideMiniPoster();
    _applyPipGeometry();
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

    _clearFullSlot();
    document.body.classList.remove('landscape-theater'); // off by default; full mode re-adds in landscape

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
    if (_isLandscapePhone()) {
        // Phone landscape → fullscreen theater overlay (the in-page slot would
        // be below the fold). Minimize collapses to the mini-player.
        _moveVideoTo(_theaterLayer());
        _styleVideoForMode('full');
        document.body.classList.add('landscape-theater');
    } else {
        _moveVideoTo(_fullSlot);
        _styleVideoForMode('full');
        _fullSlot.classList.add('video-active');
    }
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
    setMode('hidden', null);
}

// ── Mini-player (PiP) controls ───────────────────────────────────────────

function _openCurrentChannel() {
    if (_currentStream?.slug) {
        const { navigate } = window.__routerModule || {};
        if (navigate) navigate(`/channel/${_currentStream.slug}`);
    }
}

export function initMiniPlayerControls() {
    _bindVideoStateEvents();
    _loadPipGeom();

    const expandBtn = document.getElementById('mini-player-expand');
    const playBtn = document.getElementById('mini-player-play');
    const castBtn = document.getElementById('mini-player-cast');
    const closeBtn = document.getElementById('mini-player-close');

    expandBtn?.addEventListener('click', _openCurrentChannel);
    playBtn?.addEventListener('click', _togglePlayPause);

    castBtn?.addEventListener('click', () => {
        if (_currentStream?.playbackUrl) {
            castStream(_currentStream.playbackUrl, _currentStream.title || 'Kick Stream');
        }
    });

    closeBtn?.addEventListener('click', stopStream);

    // Theater minimize → collapse to the mini-player (keeps playing; browse the
    // app in landscape). Tapping the mini-player re-opens the channel → theater.
    document.getElementById('theater-exit')?.addEventListener('click', () => {
        setMode('mini', null, { collapsePanel: true });
    });

    // Re-evaluate theater when orientation flips: a live full-mode stream toggles
    // between the fullscreen overlay (landscape) and the in-page slot (portrait).
    window.matchMedia('(orientation: landscape) and (max-height: 500px)').addEventListener('change', () => {
        if (_mode === 'full' && _fullSlot) setMode('full', _fullSlot);
    });

    _initPipInteractions();
    // Keep the floating window on-screen when the viewport changes.
    window.addEventListener('resize', () => { if (_mode === 'mini') _applyPipGeometry(); });
}

// _initPipInteractions wires drag-to-move (on the video surface) and
// drag-to-resize (on the corner handle). A press on the video that doesn't
// move past a small threshold is treated as a click → open the channel page.
function _setPipInteractionLock(active) {
    document.documentElement.classList.toggle('pip-interacting', active);
    document.body.classList.toggle('pip-interacting', active);
    if (!active) {
        try { window.getSelection()?.removeAllRanges(); } catch { /* no-op */ }
    }
}

function _initPipInteractions() {
    const card = _miniPlayer();
    const thumb = _thumb();
    const handle = document.getElementById('mini-player-resize');
    if (!card || !thumb) return;

    // ── Drag to move ──
    let dragging = false, moved = false, startX = 0, startY = 0, baseLeft = 0, baseTop = 0;

    thumb.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target === handle) return;
        e.preventDefault();
        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        const r = card.getBoundingClientRect();
        baseLeft = _pipLeft ?? r.left;
        baseTop = _pipTop ?? r.top;
        try { thumb.setPointerCapture(e.pointerId); } catch { /* no-op */ }
        card.classList.add('dragging');
        _setPipInteractionLock(true);
    });

    thumb.addEventListener('pointermove', (e) => {
        if (!dragging || _isMobile()) return; // docked bar — no drag-to-move on mobile
        e.preventDefault();
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        _pipLeft = baseLeft + dx;
        _pipTop = baseTop + dy;
        _applyPipGeometry();
    });

    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        card.classList.remove('dragging');
        _setPipInteractionLock(false);
        try { thumb.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
        if (moved) _savePipGeom();
        else _openCurrentChannel();   // tap without drag → open channel
    };
    thumb.addEventListener('pointerup', endDrag);
    thumb.addEventListener('pointercancel', endDrag);

    // ── Drag the corner handle to resize (16:9 locked) ──
    if (!handle) return;
    let resizing = false, rStartX = 0, rBaseW = 0;

    handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        resizing = true;
        rStartX = e.clientX;
        rBaseW = _pipW;
        try { handle.setPointerCapture(e.pointerId); } catch { /* no-op */ }
        card.classList.add('resizing');
        _setPipInteractionLock(true);
    });

    handle.addEventListener('pointermove', (e) => {
        if (!resizing || _isMobile()) return; // docked bar — no resize on mobile
        e.preventDefault();
        _pipW = rBaseW + (e.clientX - rStartX);
        _applyPipGeometry();
    });

    const endResize = (e) => {
        if (!resizing) return;
        resizing = false;
        card.classList.remove('resizing');
        _setPipInteractionLock(false);
        try { handle.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
        _savePipGeom();
    };
    handle.addEventListener('pointerup', endResize);
    handle.addEventListener('pointercancel', endResize);
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
