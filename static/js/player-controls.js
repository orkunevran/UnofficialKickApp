/**
 * The player's own controls.
 *
 * The browser's native control bar can't express this app's playback: on a live
 * playlist its scrubber spans only the ~30 seconds the playlist carries, so the
 * broadcast timeline had to live outside the player entirely. These controls put it
 * back where it belongs — one bar, inside the video, with the timeline as its
 * scrubber.
 *
 * Two timeline sources, one bar:
 *   broadcast — a live channel Kick is recording: the whole stream is seekable,
 *               and the model comes from dvr.js so there is a single source of truth
 *   media     — a VOD, a clip, or a live channel with no recording: the media
 *               element's own duration and position
 */

import { getTimelineModel, seekToBroadcast, seekBy, goLive, LIVE_TAIL_SECONDS } from './dvr.js';
import {
    getCurrentStream, getVideoElement, getHlsInstance, hintLowLevelForSeek,
    rememberVolume,
} from './player.js';

// Hide the bar after this much inactivity while playing.
const _IDLE_HIDE_MS = 2600;

let _root = null;
let _ticker = null;
let _hideTimer = null;
let _dragging = false;
let _dragTarget = null;
let _endDragOnWindow = null;

// Touch has no hover, so a tap is the only way to summon the bar — which changes
// what a tap on the video has to mean (see the scrim handler in _bind).
function _isCoarsePointer() {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

// ── Timeline source ──────────────────────────────────────────────────────

function _isRecordedMedia() {
    return ['vod', 'clip'].includes(getCurrentStream()?.type);
}

// _timeline normalises whichever timeline applies, so the bar has one shape to draw.
function _timeline() {
    const video = getVideoElement();
    const broadcast = getTimelineModel();

    if (broadcast.available && !_isRecordedMedia()) {
        return {
            kind: 'broadcast',
            length: broadcast.length,
            position: _dragging && _dragTarget != null ? _dragTarget : broadcast.position,
            atLive: broadcast.atLive && !_dragging,
            seekable: true,
        };
    }

    const duration = Number.isFinite(video?.duration) ? video.duration : 0;
    return {
        kind: duration > 0 ? 'media' : 'live-only',
        length: duration,
        position: _dragging && _dragTarget != null ? _dragTarget : (video?.currentTime ?? 0),
        atLive: duration === 0,
        seekable: duration > 0,
    };
}

function _seekTo(seconds, timeline) {
    if (timeline.kind === 'broadcast') {
        void seekToBroadcast(seconds);
        return;
    }
    const video = getVideoElement();
    if (!video || !timeline.seekable) return;
    hintLowLevelForSeek();
    video.currentTime = Math.max(0, Math.min(seconds, timeline.length));
}

function _formatTime(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ── Markup ───────────────────────────────────────────────────────────────

const _ICONS = {
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
    rewind: '<path d="M12 5V1L7 6l5 5V7a6 6 0 11-6 6H4a8 8 0 108-8z"/>',
    volume: '<path d="M3 10v4h3l4 4V6L6 10H3zm11.5 2a4 4 0 00-2-3.46v6.92A4 4 0 0014.5 12z"/>',
    muted: '<path d="M3 10v4h3l4 4V6L6 10H3zm12.5 2 2.5 2.5-1 1L14.5 13 12 15.5l-1-1L13.5 12 11 9.5l1-1 2.5 2.5L17 8.5l1 1z"/>',
    // The frame is a ring, so it needs evenodd: with the default nonzero rule the
    // inner subpath doesn't cut a hole and the whole glyph fills as a solid block.
    pip: '<path fill-rule="evenodd" d="M2 4h20v16H2V4zm2 2v12h16V6H4z"/><rect x="12" y="11" width="7" height="6" rx="1"/>',
    fullscreen: '<path d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z"/>',
    exitFullscreen: '<path d="M8 4h2v6H4V8h4V4zm6 0h2v4h4v2h-6V4zM4 14h6v6H8v-4H4v-2zm10 2v4h-2v-6h6v2h-4z"/>',
};

function _icon(name, size = 20) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${_ICONS[name]}</svg>`;
}

function _template() {
    return `
        <div class="pc-scrim" data-pc="toggle"></div>
        <div class="pc-bar">
            <div class="pc-seek" data-pc="seek" role="slider" tabindex="0"
                 aria-label="Seek" aria-valuemin="0" aria-valuenow="0">
                <div class="pc-seek-track">
                    <div class="pc-seek-buffered" data-pc="buffered"></div>
                    <div class="pc-seek-played" data-pc="played"></div>
                    <div class="pc-seek-handle" data-pc="handle"></div>
                </div>
                <div class="pc-seek-tip hidden" data-pc="tip"></div>
            </div>
            <div class="pc-row">
                <button class="pc-btn" data-pc="play" type="button" aria-label="Play">${_icon('play')}</button>
                <button class="pc-btn" data-pc="rewind" type="button" aria-label="Rewind 30 seconds" title="Rewind 30s (←)">${_icon('rewind')}</button>
                <button class="pc-live" data-pc="live" type="button">
                    <span class="pc-live-dot" aria-hidden="true"></span><span data-pc="live-label">LIVE</span>
                </button>
                <span class="pc-time" data-pc="time"></span>
                <span class="pc-spacer"></span>
                <div class="pc-volume">
                    <button class="pc-btn" data-pc="mute" type="button" aria-label="Mute">${_icon('volume')}</button>
                    <input class="pc-volume-slider" data-pc="volume" type="range" min="0" max="1" step="0.05" aria-label="Volume">
                </div>
                <select class="pc-quality hidden" data-pc="quality" aria-label="Quality"></select>
                <button class="pc-btn hidden" data-pc="pip" type="button" aria-label="Picture-in-picture">${_icon('pip')}</button>
                <button class="pc-btn" data-pc="fullscreen" type="button" aria-label="Fullscreen">${_icon('fullscreen')}</button>
            </div>
        </div>
        <button class="pc-unmute hidden" data-pc="unmute" type="button">
            ${_icon('muted', 16)}<span>Tap for sound</span>
        </button>`;
}

const _el = (name) => _root?.querySelector(`[data-pc="${name}"]`);

// ── Rendering ────────────────────────────────────────────────────────────

// _setIcon swaps a button's glyph only when it changes. The render loop runs four
// times a second, and reassigning innerHTML unconditionally re-parsed three SVGs
// twelve times a second for nothing — measurable GC pressure on a Raspberry Pi.
function _setIcon(button, name) {
    if (!button || button.dataset.icon === name) return;
    button.dataset.icon = name;
    button.innerHTML = _icon(name);
}

function _render() {
    if (!_root) return;
    const video = getVideoElement();
    if (!video) return;

    // Synced before the early-out below: this class is what keeps the bar up while
    // paused, so it has to be right even when nothing else is drawn.
    _root.classList.toggle('is-paused', video.paused);
    // Playback starts muted (autoplay policy), so this is the one control that must
    // be findable without summoning the bar first.
    const unmute = _el('unmute');
    if (unmute) unmute.classList.toggle('hidden', !video.muted);

    // Nothing past here is on screen while the bar is down — which is most of the
    // time during playback, and was the bulk of this loop's work. A backgrounded tab
    // needs no separate check: browsers already throttle the interval to about once a
    // minute, and skipping the draw would only mean coming back to a stale bar.
    const shown = _root.classList.contains('visible') || video.paused
        || _root.contains(document.activeElement);
    if (!shown) return;

    const timeline = _timeline();

    // Seek bar
    const percent = timeline.length > 0
        ? Math.max(0, Math.min(100, (timeline.position / timeline.length) * 100))
        : 100;
    const played = _el('played');
    const handle = _el('handle');
    if (played) played.style.width = `${percent}%`;
    if (handle) handle.style.left = `${percent}%`;

    const buffered = _el('buffered');
    if (buffered && timeline.length > 0 && video.buffered.length) {
        const end = video.buffered.end(video.buffered.length - 1);
        const reference = timeline.kind === 'broadcast' ? timeline.position + (end - video.currentTime) : end;
        buffered.style.width = `${Math.max(0, Math.min(100, (reference / timeline.length) * 100))}%`;
    } else if (buffered) {
        buffered.style.width = '0%';
    }

    const seek = _el('seek');
    if (seek) {
        seek.setAttribute('aria-valuemax', String(Math.round(timeline.length)));
        seek.setAttribute('aria-valuenow', String(Math.round(timeline.position)));
        seek.setAttribute('aria-valuetext', timeline.atLive ? 'Live' : `${_formatTime(timeline.position)} of ${_formatTime(timeline.length)}`);
        seek.classList.toggle('at-live', timeline.atLive);
        seek.classList.toggle('hidden', !timeline.seekable && timeline.kind === 'live-only');
    }

    // Time / live state
    const time = _el('time');
    if (time) {
        // Riding the live end of a broadcast means position *is* length, and
        // "3:07:58 / 3:07:58" tells the viewer nothing. Report how much stream there
        // is to rewind into instead, and only show a position once they have moved.
        if (timeline.kind === 'live-only') time.textContent = '';
        else if (timeline.kind === 'broadcast' && timeline.atLive) time.textContent = _formatTime(timeline.length);
        else time.textContent = `${_formatTime(timeline.position)} / ${_formatTime(timeline.length)}`;
    }
    const live = _el('live');
    if (live) {
        const isLiveStream = timeline.kind !== 'media';
        live.classList.toggle('hidden', !isLiveStream);
        live.classList.toggle('behind', isLiveStream && !timeline.atLive);
        live.disabled = timeline.atLive;
        const label = _el('live-label');
        if (label) label.textContent = timeline.atLive ? 'LIVE' : `−${_formatTime(timeline.length - timeline.position)}`;
        live.title = timeline.atLive ? 'Watching live' : 'Return to live';
    }
    const rewind = _el('rewind');
    if (rewind) rewind.classList.toggle('hidden', timeline.kind === 'media');

    // Play state
    const play = _el('play');
    if (play) {
        _setIcon(play, video.paused ? 'play' : 'pause');
        play.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    }

    // Volume
    const mute = _el('mute');
    if (mute) {
        _setIcon(mute, video.muted || video.volume === 0 ? 'muted' : 'volume');
        mute.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
    }
    const volume = _el('volume');
    if (volume && document.activeElement !== volume) {
        volume.value = String(video.muted ? 0 : video.volume);
    }

    const fullscreen = _el('fullscreen');
    if (fullscreen) {
        const active = Boolean(document.fullscreenElement);
        _setIcon(fullscreen, active ? 'exitFullscreen' : 'fullscreen');
        fullscreen.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Fullscreen');
    }
}

// Quality options come from HLS.js once it has parsed the manifest.
function _renderQuality(attempt = 0) {
    const select = _el('quality');
    const hls = getHlsInstance();
    if (!select) return;
    if (!hls?.levels?.length) {
        select.classList.add('hidden');
        if (attempt < 20) setTimeout(() => _renderQuality(attempt + 1), 300);
        return;
    }
    const levels = hls.levels
        .map((level, index) => ({ index, label: level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)}k` }))
        .sort((a, b) => parseInt(b.label, 10) - parseInt(a.label, 10));
    select.innerHTML = `<option value="-1">Auto</option>${levels.map(l => `<option value="${l.index}">${l.label}</option>`).join('')}`;
    select.value = String(hls.autoLevelEnabled ? -1 : hls.currentLevel);
    select.classList.remove('hidden');
}

// ── Visibility ───────────────────────────────────────────────────────────

function _show() {
    if (!_root) return;
    const wasVisible = _root.classList.contains('visible');
    _root.classList.add('visible');
    clearTimeout(_hideTimer);
    // _render skips its work while the bar is down, so the contents need one pass on
    // the way up or the bar appears showing whatever it last drew.
    if (!wasVisible) _render();
    const video = getVideoElement();
    // Keep it up while paused, being scrubbed, or focused — hiding then would be
    // hiding the thing the viewer is using.
    if (!video || video.paused || _dragging || _root.contains(document.activeElement)) return;
    _hideTimer = setTimeout(() => _root?.classList.remove('visible'), _IDLE_HIDE_MS);
}

function _hide() {
    clearTimeout(_hideTimer);
    _root?.classList.remove('visible');
}

// ── Interaction ──────────────────────────────────────────────────────────

function _positionFromPointer(seek, clientX, timeline) {
    const rect = seek.getBoundingClientRect();
    if (!rect.width) return 0;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return fraction * timeline.length;
}

function _bind() {
    const video = getVideoElement();
    const seek = _el('seek');
    if (!_root || !video) return;

    const togglePlay = () => {
        if (video.paused) video.play().catch(() => {});
        else video.pause();
        _render();
    };

    // A tap on the video is the only way to summon the bar on a touchscreen, so
    // there it toggles the bar. Pausing on it would mean the controls could not be
    // reached without stopping playback first. With a mouse the bar is already
    // there on hover, so a click keeps its usual play/pause meaning.
    _el('toggle')?.addEventListener('click', () => {
        if (_isCoarsePointer()) {
            if (_root?.classList.contains('visible')) _hide();
            else _show();
            return;
        }
        togglePlay();
    });
    _el('play')?.addEventListener('click', togglePlay);
    _el('rewind')?.addEventListener('click', () => seekBy(-30));
    _el('live')?.addEventListener('click', () => goLive());

    const applyVolume = () => {
        // Persisted, so the next stream doesn't start silent again: playback has to
        // begin muted for autoplay to be allowed, and re-muting a viewer who has
        // already asked for sound on every channel change is its own bug.
        rememberVolume(video.volume, video.muted);
        _render();
    };
    _el('mute')?.addEventListener('click', () => {
        video.muted = !video.muted;
        if (!video.muted && video.volume === 0) video.volume = 0.5;
        applyVolume();
    });
    _el('unmute')?.addEventListener('click', () => {
        video.muted = false;
        if (video.volume === 0) video.volume = 0.5;
        video.play?.().catch(() => {});
        applyVolume();
        _show();
    });
    _el('volume')?.addEventListener('input', (e) => {
        const level = Number(e.target.value);
        video.volume = level;
        video.muted = level === 0;
        applyVolume();
    });
    _el('quality')?.addEventListener('change', (e) => {
        const hls = getHlsInstance();
        if (hls) hls.currentLevel = parseInt(e.target.value, 10);
    });
    _el('pip')?.addEventListener('click', async () => {
        try {
            if (document.pictureInPictureElement) await document.exitPictureInPicture();
            else await video.requestPictureInPicture();
        } catch { /* denied or unsupported */ }
    });
    _el('fullscreen')?.addEventListener('click', async () => {
        const container = _root.parentElement;
        try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else if (container?.requestFullscreen) await container.requestFullscreen();
            else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iOS
        } catch { /* denied */ }
        _render();
    });

    if (_el('pip') && document.pictureInPictureEnabled) _el('pip').classList.remove('hidden');

    // Scrubbing
    if (seek) {
        const tip = _el('tip');
        seek.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            const timeline = _timeline();
            if (!timeline.seekable) return;
            e.preventDefault();
            try { seek.setPointerCapture(e.pointerId); } catch { /* move events still arrive */ }
            _dragging = true;
            _dragTarget = _positionFromPointer(seek, e.clientX, timeline);
            _render();
        });
        seek.addEventListener('pointermove', (e) => {
            const timeline = _timeline();
            if (!timeline.seekable) return;
            if (_dragging) {
                _dragTarget = _positionFromPointer(seek, e.clientX, timeline);
                _render();
                _show();
                return;
            }
            if (tip && e.pointerType === 'mouse') {
                const rect = seek.getBoundingClientRect();
                tip.textContent = _formatTime(_positionFromPointer(seek, e.clientX, timeline));
                tip.style.left = `${Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100))}%`;
                tip.classList.remove('hidden');
            }
        });
        seek.addEventListener('pointerleave', () => tip?.classList.add('hidden'));
        // commit=false abandons the drag where playback already is: a cancelled
        // pointer (the browser claiming it for a scroll, say) is not a chosen
        // position, so seeking to it would move the viewer somewhere they never
        // asked for.
        const endDrag = (e, commit = true) => {
            if (!_dragging) return;
            const timeline = _timeline();
            const target = _dragTarget;
            _dragging = false;
            _dragTarget = null;
            try { seek.releasePointerCapture(e.pointerId); } catch { /* nothing captured */ }
            if (commit && target != null) _seekTo(target, timeline);
            _render();
        };
        const abandonDrag = (e) => endDrag(e, false);
        seek.addEventListener('pointerup', endDrag);
        seek.addEventListener('pointercancel', abandonDrag);
        // A release that never reaches the track — capture was refused, the pointer
        // left the document, the browser took it away — would otherwise leave
        // _dragging stuck, freezing the timeline at the drag target and pinning the
        // bar open with no way out.
        seek.addEventListener('lostpointercapture', endDrag);
        _endDragOnWindow = { up: endDrag, cancel: abandonDrag };
        window.addEventListener('pointerup', _endDragOnWindow.up);
        window.addEventListener('pointercancel', _endDragOnWindow.cancel);

        seek.addEventListener('keydown', (e) => {
            const timeline = _timeline();
            if (!timeline.seekable) return;
            const step = e.shiftKey ? 300 : 30;
            let target = null;
            if (e.key === 'ArrowLeft') target = timeline.position - step;
            else if (e.key === 'ArrowRight') target = timeline.position + step;
            else if (e.key === 'Home') target = 0;
            else if (e.key === 'End') target = timeline.length;
            else return;
            e.preventDefault();
            e.stopPropagation();
            if (timeline.kind === 'broadcast' && timeline.length - target <= LIVE_TAIL_SECONDS) goLive();
            else _seekTo(target, timeline);
        });
    }

    // Coming back to the tab: the interval was throttled to roughly once a minute
    // while it was hidden, so draw now rather than showing a minute-old bar.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) _render(); });

    // Reveal on any interaction with the player.
    ['pointermove', 'pointerdown', 'focusin'].forEach(type => _root.addEventListener(type, _show));
    _root.addEventListener('pointerleave', (e) => {
        // A touch fires pointerleave the moment the finger lifts, which would undo
        // the tap that just summoned the bar. Leaving is a mouse idea.
        if (e.pointerType === 'touch') return;
        if (!getVideoElement()?.paused && !_dragging) _hide();
    });
}

// ── Mount ────────────────────────────────────────────────────────────────

/**
 * Put the controls in whichever container currently holds the video, replacing the
 * browser's own bar.
 */
export function mountPlayerControls(container) {
    const video = getVideoElement();
    // Bail without touching video.controls: the caller left the native bar on, and
    // a player with no control surface at all is worse than one with the wrong
    // scrubber.
    if (!container || !video) return;

    if (!_root) {
        _root = document.createElement('div');
        _root.className = 'player-controls';
        _root.innerHTML = _template();
    }
    if (_root.parentElement !== container) container.appendChild(_root);
    if (!_root.dataset.bound) {
        _bind();
        _root.dataset.bound = '1';
    }

    // Ours is up, so the native bar can go: it would otherwise sit underneath with a
    // scrubber spanning a different timeline — the confusion this module exists to
    // remove.
    video.controls = false;

    _renderQuality();
    _render();
    _show();

    clearInterval(_ticker);
    _ticker = setInterval(_render, 250);
}

export function unmountPlayerControls() {
    clearInterval(_ticker);
    _ticker = null;
    clearTimeout(_hideTimer);
    if (_endDragOnWindow) {
        window.removeEventListener('pointerup', _endDragOnWindow.up);
        window.removeEventListener('pointercancel', _endDragOnWindow.cancel);
        _endDragOnWindow = null;
    }
    _root?.remove();
    _root = null;
    _dragging = false;
    _dragTarget = null;
}
