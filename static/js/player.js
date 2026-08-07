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
import { mountPlayerControls, unmountPlayerControls } from './player-controls.js';
import { preferences, savePreferences } from './state.js';
import { toast } from './toast.js';

// ── State ────────────────────────────────────────────────────────────────

let _mode = 'hidden';         // 'hidden' | 'mini' | 'full'
let _hlsInstance = null;
let _currentStream = null;    // { slug, title, channel, playbackUrl, thumbnailUrl }
let _cachedChannelData = null;
let _fullSlot = null;
let _videoEventsBound = false;

// Playback-error recovery/reporting state.
let _lastLoad = null;         // { playbackUrl, streamInfo, channelData } — for Retry
let _loadedAt = 0;            // Date.now() of the last loadStream
let _hlsRecoverCount = 0;     // consecutive fatal-error recovery attempts
let _errorShown = false;      // suppress duplicate error toasts for one failure
const _MAX_HLS_RECOVER = 3;

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

// The mini-player docks as a fixed bottom bar (styled in CSS) wherever a
// floating, drag/resizable PiP would just cover content: phones in either
// orientation, and touch tablets. Only roomy fine-pointer desktops keep the
// draggable floating window.
//
// The short-viewport clause is what catches a phone in landscape — 768–932px
// wide on current handsets, so the width clause alone misses it, and it is the
// case where a floating card does the most damage (a 360px window with its
// control strip is most of a 390px-tall screen). It asks nothing about the
// pointer on purpose: a browser reporting fine-pointer (Android's desktop-site
// mode, embedded WebViews) is still a phone, and the geometry settles it.
//
// This must stay the exact OR of the dock block's media query in style.css —
// the two drifting apart is what leaves the card floating.
function _shouldDock() {
    return window.matchMedia('(max-width: 767px)').matches
        || window.matchMedia('(max-height: 500px) and (max-width: 1199px)').matches
        || window.matchMedia('(hover: none) and (pointer: coarse) and (max-width: 1199px)').matches;
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
    // Native-HLS (Safari) and direct MP4/WebM failures surface on the element.
    // (HLS.js media/network errors come through Hls.Events.ERROR instead.)
    video.addEventListener('error', () => {
        if (!_currentStream || _mode === 'hidden') return; // ignore teardown noise
        _showPlaybackError();
    });
    // A jump can't paint anything until a whole segment arrives, which for a
    // recording's 12–15s segments is a visible wait on the previous frame. Mark it
    // so the player can say it's working rather than looking frozen.
    const markBusy = () => _fullSlot?.classList.add('media-seeking');
    const clearBusy = () => _fullSlot?.classList.remove('media-seeking');
    video.addEventListener('seeking', markBusy);
    video.addEventListener('waiting', markBusy);
    video.addEventListener('seeked', clearBusy);
    video.addEventListener('canplay', clearBusy);
    video.addEventListener('pause', clearBusy);

    // A frame started rendering → recovery succeeded; clear any error UI and
    // restore the full recovery budget. Without resetting _hlsRecoverCount here
    // the cap becomes cumulative over the whole session (startLoad/recoverMediaError
    // resume without re-firing MANIFEST_PARSED), and a 4th transient error hours
    // later would permanently tear down an otherwise-healthy stream.
    video.addEventListener('playing', () => {
        _errorShown = false;
        _hlsRecoverCount = 0;
        _clearPlaybackError();
        clearBusy();
    });
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
// The mobile bottom nav only exists below 768px, so use a strict < 768 here
// (at exactly 768px there is no nav to clear).
function _pipMargin() {
    return window.innerWidth < 768 ? 84 : 24;
}

function _cardHeightFor(width) {
    return Math.round((width * 9) / 16) + _CONTROL_STRIP_H;
}

// _applyPipGeometry writes width + position to the card, clamping it fully
// inside the viewport. Position defaults to the bottom-right corner.
function _applyPipGeometry() {
    const card = _miniPlayer();
    if (!card) return;
    // When docked (touch phones/tablets) the bar is positioned via CSS — don't
    // impose floating coordinates.
    if (_shouldDock()) return;
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
/** When the current source was loaded, for callers deciding whether playback has
 *  only just started. (currentTime can't answer that: on a live playlist it
 *  starts at whatever offset the window happens to have.) */
export function getStreamLoadedAt() { return _loadedAt; }

// _preferredVolume is the level to open at, clamped in case a stored preference has
// been hand-edited. A stored 0 would make "unmuted" silent, so it floors at
// something audible and lets the muted flag carry the silence.
function _preferredVolume() {
    const stored = Number(preferences.playerVolume);
    if (!Number.isFinite(stored) || stored <= 0) return 1;
    return Math.min(1, stored);
}

/**
 * Remember the viewer's volume choice, so the next stream doesn't start silent.
 * Called by the controls rather than inferred from a 'volumechange' listener,
 * because playback itself sets the volume on every load and that must not be
 * mistaken for a choice.
 */
export function rememberVolume(volume, muted) {
    const level = Number(volume);
    if (Number.isFinite(level) && level > 0) preferences.playerVolume = level;
    preferences.playerMuted = Boolean(muted);
    savePreferences();
}

/**
 * Ask HLS.js to fetch the fragment immediately after a seek at a low rendition.
 *
 * A jump shows nothing until a whole segment has downloaded, and a recording's
 * segments run 12–15s: ~9MB at 1080p60 against ~1MB at 360p — the difference
 * between a jump landing in well under a second and taking several. ABR climbs
 * back on the following fragment, so the low rendition lasts one segment.
 *
 * Only applies while ABR is in charge: a viewer who picked a quality keeps it.
 */
export function hintLowLevelForSeek() {
    const hls = _hlsInstance;
    if (!hls || !hls.autoLevelEnabled || !hls.levels?.length) return;
    // Lowest rendition that still looks like video; HLS.js orders levels by bitrate.
    const index = hls.levels.findIndex(level => (level.height || 0) >= 360);
    hls.nextLoadLevel = index >= 0 ? index : 0;
}

// _hlsConfigFor tunes HLS.js for what is being played:
//
//   live     — chase the low-latency edge of the broadcast (the default source)
//   dvr      — the in-progress recording of a live broadcast: an append-only
//              playlist covering the whole stream, so it is seekable end to end
//   recorded — a finished VOD or clip
//
// The DVR case must not set liveDurationInfinity (duration has to stay finite
// for the scrubber to span the recorded window) and must not set any
// liveMaxLatencyDuration*, which would haul the viewer back to the live edge —
// exactly what rewinding is meant to prevent.
function _hlsConfigFor(type, opts = {}) {
    if (type === 'dvr') {
        return {
            lowLatencyMode: false,
            liveDurationInfinity: false,
            // Ride one segment behind the recording's end rather than the usual
            // three: its segments are ~12s, so the default would open a live
            // channel a needless ~40s behind. The segments are already fully
            // written upstream when they appear, so there is little to gain from
            // a deeper safety margin.
            liveSyncDurationCount: 1,
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            // Enough to make short rewinds instant without hoarding: 60s of
            // 1080p60 is already ~45MB of decoded-adjacent buffer, and this
            // plays on phones too.
            backBufferLength: 60,
            // Recording segments are 12–15s, so the first one decides how long the
            // player shows nothing: ~2.3MB at 480p (measured 1894ms) against ~1MB
            // at 360p. Start low deliberately and let ABR climb after the first
            // segment gives it a real bandwidth reading — walking up the ladder is
            // free now that every rendition is served from one cached playlist.
            abrEwmaDefaultEstimate: 700_000,
            // Begin fetching that first segment while the media element is still
            // being attached, rather than after.
            startFragPrefetch: true,
            // And never climb past what the element can actually show: in the
            // mini-player that avoids pulling 1080p60 segments into a 360px box.
            capLevelToPlayerSize: true,
            ...(Number.isFinite(opts.startPosition) ? { startPosition: opts.startPosition } : {}),
        };
    }
    if (type === 'vod' || type === 'clip') {
        return { maxBufferLength: 30, maxMaxBufferLength: 60, backBufferLength: 60 };
    }
    return {
        lowLatencyMode: true,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
        maxBufferLength: 10,
        maxMaxBufferLength: 20,
        liveDurationInfinity: true,
        backBufferLength: 15,
        // Reaching the stream is the whole point of opening a live channel, and the
        // first segment gates that: ~3MB at 1080p60 against ~330KB at 360p. Open
        // low and let ABR climb once it has measured the connection.
        abrEwmaDefaultEstimate: 700_000,
        startFragPrefetch: true,
    };
}

/**
 * Load a stream onto the shared video. Does not change the current visual mode.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.preserveVolume] keep the current muted state instead of
 *   force-muting — for source switches within one viewing session (live ⇄ DVR),
 *   where re-muting a stream the viewer already unmuted would be a regression.
 * @param {number} [opts.startPosition] initial playback position, in seconds.
 */
export function loadStream(playbackUrl, streamInfo, channelData, opts = {}) {
    _currentStream = streamInfo;
    _cachedChannelData = channelData || null;

    const video = _video();
    if (!video) return;

    _bindVideoStateEvents();
    // Route navigation and HLS manifest parsing are asynchronous, so the original
    // click/keypress activation may be gone by the time media is ready. Muted
    // autoplay is deterministic across mouse, touch, and keyboard navigation.
    //
    // The mute is only forced until the viewer has told us otherwise: once they
    // unmute, that choice is remembered and every later stream starts with sound.
    // Autoplay stays allowed because a page where audio has already played counts as
    // engaged — and if a browser disagrees it pauses, which the controls show.
    video.autoplay = true;
    // preserveVolume means this is a source switch inside one viewing session (live ⇄
    // DVR), where whatever is playing right now is the truth — reapplying the stored
    // level would undo an adjustment made since the stream started.
    if (!opts.preserveVolume) {
        video.volume = _preferredVolume();
        video.muted = preferences.playerMuted !== false;
    }

    // Remember the source so a Retry (from the error UI) can reload it, and
    // reset the per-load error/recovery state.
    _lastLoad = { playbackUrl, streamInfo, channelData, opts };
    _loadedAt = Date.now();
    _hlsRecoverCount = 0;
    _errorShown = false;
    _clearPlaybackError();

    if (_hlsInstance) {
        _hlsInstance.destroy();
        _hlsInstance = null;
    }

    if (streamInfo?.thumbnailUrl) video.poster = streamInfo.thumbnailUrl;

    // Treat Kick proxy redirect routes as HLS sources; the browser/HLS.js
    // follows the redirect to the actual manifest.
    const isRedirectStream = /\/streams\/(?:vods|go|clip)\//i.test(playbackUrl);
    const isHLS = isRedirectStream || /\.m3u8($|\?)/i.test(playbackUrl);
    const hlsJsSupported = Boolean(window.Hls && window.Hls.isSupported());
    const isSafari = document.documentElement.classList.contains('safari');

    // Safari's native HLS is excellent, but some Chromium builds on macOS
    // claim native support while rejecting Kick's byterange clip playlists.
    // Prefer hls.js everywhere except Safari for consistent recording support.
    if (isHLS && video.canPlayType('application/vnd.apple.mpegurl') && (isSafari || !hlsJsSupported)) {
        video.src = playbackUrl;
        video.play().catch(() => {});
        return;
    }

    // HLS.js (Chrome, Firefox) — for M3U8 manifests
    if (isHLS && hlsJsSupported) {
        const hls = new window.Hls(_hlsConfigFor(streamInfo?.type, opts));

        hls.loadSource(playbackUrl);
        hls.attachMedia(video);
        _hlsInstance = hls;
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
            _hlsRecoverCount = 0;   // successful (re)load
            _errorShown = false;
            _clearPlaybackError();
            video.play().catch(() => {});
        });
        hls.on(window.Hls.Events.ERROR, (_evt, data) => {
            if (!data || !data.fatal) return; // non-fatal errors auto-recover
            if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && _hlsRecoverCount < _MAX_HLS_RECOVER) {
                _hlsRecoverCount++;
                hls.startLoad();               // e.g. dropped segment → resume loading
                return;
            }
            if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && _hlsRecoverCount < _MAX_HLS_RECOVER) {
                _hlsRecoverCount++;
                hls.recoverMediaError();        // e.g. buffer stall / decode error
                return;
            }
            // Unrecoverable (or retries exhausted): surface it instead of a
            // silent black box.
            hls.destroy();
            if (_hlsInstance === hls) _hlsInstance = null;
            _showPlaybackError();
        });
        return;
    }

    // Direct media (MP4, WebM clips) — native <video> playback
    video.src = playbackUrl;
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
        unmountPlayerControls();
        _hideMiniPoster();
        _hideMiniBar();
        _moveVideoTo(_layer());
        _styleVideoForMode('hidden');
        return;
    }

    if (mode === 'mini') {
        _mode = 'mini';
        video.controls = false;
        unmountPlayerControls();
        _showMiniBar(Boolean(fromRect));
        _renderMiniVideo();
        if (fromRect) _flipAnimate(video, fromRect);
        return;
    }

    _mode = 'full';
    _fullSlot = slot;
    _hideMiniPoster();
    _hideMiniBar();
    // On by default so that a control surface exists no matter what: mountPlayerControls
    // turns it off once its own bar is up, and if it can't mount (no container, no
    // media element) the native bar is still there rather than nothing at all.
    video.controls = true;
    if (_isLandscapePhone()) {
        // Phone landscape → fullscreen theater overlay (the in-page slot would
        // be below the fold). Minimize collapses to the mini-player.
        _moveVideoTo(_theaterLayer());
        _styleVideoForMode('full');
        document.body.classList.add('landscape-theater');
        mountPlayerControls(_theaterLayer());
    } else {
        _moveVideoTo(_fullSlot);
        _styleVideoForMode('full');
        _fullSlot.classList.add('video-active');
        mountPlayerControls(_fullSlot);
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
        // Cast the live stream even when the viewer has rewound locally: a cast
        // device given the DVR playlist would start from an arbitrary point in
        // the recording rather than from where they are watching.
        const url = _currentStream?.liveUrl || _currentStream?.playbackUrl;
        if (url) castStream(url, _currentStream.title || 'Kick Stream');
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
        // Docked (touch) layout: the thumb is tap-to-open only. Skip the drag
        // machinery AND the interaction lock — the lock sets pointer-events:none
        // on #app/.mobile-nav, which would turn the docked thumb into a scroll
        // dead-zone and briefly freeze the nav on every touch. (Open is handled
        // by the click listener below.)
        if (_shouldDock()) return;
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
        if (!dragging || _shouldDock()) return; // docked bar — no drag-to-move on touch
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

    // Docked (touch) layout: no drag machinery runs, so open the channel on a
    // plain click/tap. Guarded by _shouldDock() so it's a no-op on desktop,
    // where endDrag already handles tap-to-open (and this click still fires).
    thumb.addEventListener('click', () => {
        if (_shouldDock()) _openCurrentChannel();
    });

    // ── Drag the corner handle to resize (16:9 locked) ──
    if (!handle) return;
    let resizing = false, rStartX = 0, rBaseW = 0;

    handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (_shouldDock()) return; // no resize on docked (touch) layouts
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
        if (!resizing || _shouldDock()) return; // docked bar — no resize on touch
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

// Surface a playback failure (dead/offline stream, blocked manifest, decode
// error) instead of leaving a silent black box. Shows an inline message in the
// channel slot when it's visible, plus a Retry toast. Guarded so one failure
// doesn't spam duplicate toasts.
function _showPlaybackError() {
    const existingOverlay = _fullSlot?.querySelector('.player-error');
    if (_mode === 'full' && _fullSlot && !_isLandscapePhone() && !existingOverlay) {
        const overlay = document.createElement('div');
        overlay.className = 'player-error';
        overlay.setAttribute('role', 'alert');
        overlay.innerHTML = `
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <p class="player-error-title">Playback failed</p>
            <p class="player-error-hint">This stream couldn't be loaded — it may be offline.</p>
            <button type="button" class="player-error-retry">Retry</button>`;
        _fullSlot.appendChild(overlay);
        overlay.querySelector('.player-error-retry')?.addEventListener('click', _retryLoad);
    }
    if (_errorShown) return;
    _errorShown = true;
    toast('Playback failed', 'error', {
        action: { label: 'Retry', onClick: _retryLoad },
    });
}

function _retryLoad() {
    if (!_lastLoad) return;
    _clearPlaybackError();
    const opts = { ..._lastLoad.opts };
    // Retrying a rewound stream should resume where it broke, not jump back to
    // wherever the failed load started.
    const position = _video()?.currentTime;
    if (_lastLoad.streamInfo?.type === 'dvr' && position > 0) opts.startPosition = position;
    loadStream(_lastLoad.playbackUrl, _lastLoad.streamInfo, _lastLoad.channelData, opts);
}

function _clearPlaybackError() {
    document.querySelectorAll('.player-error').forEach((el) => el.remove());
}

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
