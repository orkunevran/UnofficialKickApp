/**
 * Live rewind (DVR).
 *
 * Kick records every broadcast to a VOD *while it is still live*, so the
 * in-progress recording already holds the stream from minute zero. The backend
 * proxies it at /streams/dvr/{slug}/master.m3u8 (see internal/httpapi/dvr.go);
 * this module turns it into seeking on a live channel.
 *
 * A live channel can be played from either of two sources:
 *
 *   dvr  → the recording: the whole broadcast on one timeline, seekable end to
 *          end, trailing real time by the recording's own lag (~30s)
 *   live → the low-latency edge playlist, which carries ~30 seconds of segments
 *          and so cannot be scrubbed beyond that
 *
 * The live edge is the default ('liveStartMode' in state.js), because reaching the
 * stream is the point of opening a live channel. The recording's playlists are
 * primed in the background once playback settles, so the first rewind switches
 * source without waiting on upstream; Go Live switches back. The control bar still
 * shows the whole broadcast as its scrubber either way — the timeline model below
 * measures from the broadcast's start time when the edge playlist is playing, so a
 * viewer can scrub into the past without having loaded it first.
 *
 * The "Live playback start" setting can invert that: 'timeline' opens on the
 * recording, so the whole broadcast is seekable from the first frame, at the cost
 * of a slower start and the recording's ~30s extra lag. There, Go Live seeks to the
 * recording's live end rather than swapping source, since switching to the edge
 * playlist would take the full timeline away again.
 */

import { fetchDvrInfo } from './api.js';
import { preferences } from './state.js';
import { toast } from './toast.js';
import {
    getCurrentStream, getVideoElement, getHlsInstance, getStreamLoadedAt,
    hintLowLevelForSeek, loadStream,
} from './player.js';

// How long after entering DVR mode to keep waiting for the recording's length
// (the seekable range only appears once the manifest has been parsed).
const _EDGE_WAIT_MS = 15000;

// How far below the stream's live point still counts as watching live, rather
// than as a rewind worth reporting.
const _EDGE_SLACK_SECONDS = 10;

// Fallback when the player won't tell us where its live point is (native HLS).
// Recording segments run 12–15s and playback sits a few of them back, so this has
// to be generous enough not to call a normal arrival a rewind.
const _AT_EDGE_SECONDS = 60;

// How long the live source will wait on the availability check before starting
// without it. Playback start matters more than the rewind window: a viewer who
// misses the check can still get it with one click on a rewind button.
const _INFO_TIMEOUT_MS = 700;

// How far into playback a late availability answer may still swap the source for
// the full timeline. Past this, the viewer is watching — leave them alone.
const _UPGRADE_GRACE_SECONDS = 10;

// How long to wait for playback to start before giving up on priming the rewind
// window, and how long to let the buffer fill afterwards before spending bandwidth
// on it.
const _PRIME_WAIT_MS = 20000;
const _PRIME_SETTLE_MS = 2000;

// Distance kept from the end of the recording when jumping back to live, roughly
// one segment. Landing on the boundary itself stalls until the next is published.
const _EDGE_SYNC_SECONDS = 12;

// Elements that own their arrow keys, and so are off limits to the seek shortcuts.
// Widgets first (a tab list, a slider, a menu all move with the arrows), then form
// fields.
const _KEY_EXEMPT_SELECTOR = [
    '[role="tab"]', '[role="tablist"]', '[role="slider"]', '[role="listbox"]',
    '[role="menu"]', '[role="menuitem"]', '[role="radiogroup"]', '[role="spinbutton"]',
    'input', 'textarea', 'select', '[contenteditable="true"]',
].join(', ');

// How long a positive availability answer may be reused. It carries the
// broadcast's start time, which the whole timeline is scaled from — so an answer
// kept past the end of the broadcast would describe the *previous* stream, making
// the scrubber hours too long and every scrub land in the wrong place. A streamer
// restarting is exactly the case this bounds, and re-asking is cheap (the backend
// caches the lookup).
const _INFO_TTL_MS = 5 * 60 * 1000;

let _state = null;      // { slug, dvrUrl, liveUrl, liveData, title }
let _onKeydown = null;
let _pendingBehind = 0; // rewind target still waiting on the recording's length
const _infoCache = new Map();  // slug → { at, promise: Promise<info data|null> }

// ── Helpers ──────────────────────────────────────────────────────────────

function _isDvrActive() {
    return getCurrentStream()?.type === 'dvr';
}

// _edge returns the end of the seekable window — the live end of the recording.
function _edge(video) {
    const seekable = video?.seekable;
    if (seekable?.length) return seekable.end(seekable.length - 1);
    return Number.isFinite(video?.duration) ? video.duration : 0;
}

// _liveSyncPosition is where the player considers "live" to be on this stream.
// HLS.js derives it from the playlist's own segment duration — 12–15s for a
// recording, so live sits ~45s back on one stream and ~15s on another. Comparing
// against it, rather than a fixed distance, is what keeps a normal arrival
// labelled LIVE on both.
function _liveSyncPosition() {
    const sync = getHlsInstance()?.liveSyncPosition;
    return Number.isFinite(sync) && sync > 0 ? sync : null;
}

// _isRewound reports whether the viewer has deliberately moved back, as opposed to
// riding the live point.
function _isRewound() {
    const video = getVideoElement();
    if (!video) return false;
    const sync = _liveSyncPosition();
    if (sync != null) return video.currentTime < sync - _EDGE_SLACK_SECONDS;
    return _offsetFromEdge() > _AT_EDGE_SECONDS;
}

// _offsetFromEdge is how far back from the newest available frame the viewer is.
// The rewind controls and the scrubber both work in this timeline, so it is what
// the readout reports.
function _offsetFromEdge() {
    const video = getVideoElement();
    if (!video) return 0;
    const edge = _edge(video);
    return edge > 0 ? Math.max(0, edge - video.currentTime) : 0;
}

// ── Source switching ─────────────────────────────────────────────────────

function _streamInfo({ url, type }) {
    const current = getCurrentStream();
    const s = _state;
    return {
        slug: s.slug,
        title: current?.title || s.title || s.slug,
        channel: current?.channel || s.slug,
        playbackUrl: url,
        // Cast and "copy stream URL" should always point at the live stream,
        // never at a rewound position.
        liveUrl: s.liveUrl,
        thumbnailUrl: current?.thumbnailUrl || '',
        ...(type ? { type } : {}),
    };
}

// _seekWhenReady applies a seek as soon as the recording has a seekable range.
//
// The range only exists once the manifest is parsed, so a seek issued with the
// source is too early. Handing HLS.js a startPosition instead does not work here:
// on a live playlist it ignores it and begins at zero (observed landing at 0:00 for
// a target of 22 minutes), so the seek is always applied explicitly.
//
// computeTarget receives the live end of the recording, so callers can express
// either an absolute position or an offset from the end. onAbandon runs if the
// range never appears, so callers can release whatever state they were holding for
// the pending seek.
function _seekWhenReady(computeTarget, onAbandon = null) {
    const video = getVideoElement();
    if (!video) { onAbandon?.(); return; }

    const events = ['loadedmetadata', 'durationchange', 'progress', 'canplay'];
    let timer = null;

    const attempt = () => {
        const edge = _edge(video);
        if (!(edge > 0)) return false;
        const target = computeTarget(edge);
        if (Number.isFinite(target)) {
            // Never land on the boundary itself: there is nothing buffered past it.
            video.currentTime = Math.max(0, Math.min(target, Math.max(0, edge - 1)));
            video.play?.().catch(() => { /* autoplay may need a gesture */ });
        }
        return true;
    };
    const stop = () => {
        events.forEach(e => video.removeEventListener(e, onEvent));
        if (timer) { clearTimeout(timer); timer = null; }
    };
    const onEvent = () => { if (attempt()) stop(); };

    if (attempt()) return;
    events.forEach(e => video.addEventListener(e, onEvent));
    // Give up quietly: playback continues at the recording's live end, which is
    // still watchable — just not where it was asked to go.
    timer = setTimeout(() => { stop(); onAbandon?.(); }, _EDGE_WAIT_MS);
}

// _seekBehindEdge lands `behind` seconds before the end of the recording. Rewinds
// issued while the wait is outstanding (an impatient second click) add up instead
// of replacing each other.
function _seekBehindEdge(behind) {
    if (_pendingBehind > 0) {
        _pendingBehind += behind;
        return;
    }
    _pendingBehind = behind;
    _seekWhenReady(
        (edge) => {
            const target = edge - _pendingBehind;
            _pendingBehind = 0;
            return target;
        },
        // Abandoning has to release it too. _pendingBehind is what marks a rewind as
        // still outstanding, so a stranded value sends every later rewind down the
        // accumulate-and-return branch above and none of them ever seek again.
        () => { _pendingBehind = 0; },
    );
}

// _enterDvr switches to the recording. With neither `behind` nor `position` it
// lands at the recording's live end — the default way to watch, with the whole
// broadcast on the timeline.
function _enterDvr({ behind = null, position = null } = {}) {
    if (!_state?.dvrUrl) return;

    loadStream(
        _state.dvrUrl,
        _streamInfo({ url: _state.dvrUrl, type: 'dvr' }),
        _state.liveData,
        { preserveVolume: true },
    );
    if (position != null) _seekWhenReady(() => position);
    else if (behind != null) _seekBehindEdge(behind);
}

// _goLive returns the viewer to live. On the recording that means seeking to its
// live end — *not* switching to the low-latency edge playlist, which would throw
// away the full-broadcast timeline and leave nothing to scrub. The 'edge'
// preference is the exception: there, live means that playlist, so returning to
// live means going back to it.
function _goLive() {
    if (!_state || !_isDvrActive()) return;   // already on the live edge playlist

    if (preferences.liveStartMode === 'edge' && _state.liveUrl) {
        loadStream(
            _state.liveUrl,
            _streamInfo({ url: _state.liveUrl }),
            _state.liveData,
            { preserveVolume: true },
        );
        return;
    }

    const video = getVideoElement();
    if (!video) return;
    // liveSyncPosition is HLS.js's own idea of the live point; the fallback keeps
    // a segment's distance from the boundary, which would otherwise stall until
    // the next segment is published.
    const target = _liveSyncPosition() ?? Math.max(0, _edge(video) - _EDGE_SYNC_SECONDS);
    if (target > 0) {
        video.currentTime = target;
        video.play?.().catch(() => { /* autoplay may need a gesture */ });
    }
}

// _seek moves by `delta` seconds (negative rewinds). On the live edge playlist
// there is nothing to seek within, so a rewind switches to the recording first.
// Seeks are clamped to the recording's own range, so a forward seek runs up to
// the live end instead of off the end of the timeline.
function _seek(delta) {
    const video = getVideoElement();
    if (!video || !_state) return;

    if (!_isDvrActive()) {
        if (delta < 0) _enterDvr({ behind: -delta });
        return;
    }

    // Forward seeks stop at the live point rather than the raw end of the
    // playlist: past it there is nothing buffered yet, so playback would stall
    // waiting for the next segment to be published.
    const edge = _edge(video);
    const limit = _liveSyncPosition() ?? (edge > 0 ? Math.max(0, edge - 1) : Infinity);
    hintLowLevelForSeek();
    video.currentTime = Math.max(0, Math.min(video.currentTime + delta, limit));
}

// ── Broadcast timeline ───────────────────────────────────────────────────
//
// The player's own scrubber spans whatever the playing playlist carries — ~30s on
// the live edge. This one spans the broadcast, so any moment can be picked while
// playback stays live until it is. Landing within LIVE_TAIL_SECONDS of the right
// end means "live", since the recording doesn't reach that far anyway.

// Exported so the control bar snaps to live on the same threshold this module
// applies, rather than keeping a second copy of it.
export const LIVE_TAIL_SECONDS = 45;

let _startedAtMs = 0;

// _broadcastLength is how much stream there is to seek within: measured from the
// recording when playing it, and from its start time when playing live.
function _broadcastLength() {
    const recorded = _isDvrActive() ? _edge(getVideoElement()) : 0;
    const elapsed = _startedAtMs ? (Date.now() - _startedAtMs) / 1000 : 0;
    return Math.max(recorded, elapsed, 1);
}

// Where the viewer is on that timeline. On the live edge that is simply "now" —
// currentTime there is an offset into the live window, not into the broadcast.
function _timelinePosition() {
    if (!_isDvrActive()) return _broadcastLength();
    return getVideoElement()?.currentTime ?? 0;
}

/**
 * Jump to a point in the broadcast. Switches to the recording if that is where the
 * point lives — which is the first time the past is actually needed, and is quick
 * because its playlists are primed once playback settles.
 */
async function _seekToBroadcast(seconds) {
    const video = getVideoElement();
    if (!video || !_state) return;

    const length = _broadcastLength();
    const target = Math.max(0, Math.min(seconds, length));

    if (length - target <= LIVE_TAIL_SECONDS) {
        if (_isDvrActive()) _goLive();
        return;
    }
    if (_isDvrActive()) {
        hintLowLevelForSeek();
        video.currentTime = Math.min(target, Math.max(0, _edge(video) - 1));
        return;
    }
    await _primeDvrSource(_state.dvrUrl);
    _enterDvr({ position: target });
}

/**
 * The timeline as the player's controls need to draw it — one source of truth, so
 * the control bar renders this rather than recomputing it.
 *
 * @returns {{available: boolean, length: number, position: number, atLive: boolean,
 *            behind: number, wallClockAt: (seconds: number) => Date|null}}
 */
export function getTimelineModel() {
    return {
        available: Boolean(_state?.dvrUrl),
        length: _broadcastLength(),
        position: _timelinePosition(),
        atLive: !_isDvrActive() || !_isRewound(),
        behind: _isDvrActive() ? _offsetFromEdge() : 0,
        // The instant a position corresponds to, which is what chat replay needs.
        wallClockAt: (seconds) => (_startedAtMs ? new Date(_startedAtMs + seconds * 1000) : null),
    };
}

/** Jump to a point in the broadcast, in seconds from its start. */
export function seekToBroadcast(seconds) { return _seekToBroadcast(seconds); }

/** Move by a relative amount; negative rewinds. */
export function seekBy(deltaSeconds) { _seek(deltaSeconds); }

/** Return to live. */
export function goLive() { _goLive(); }

// ── Source selection on arrival ───────────────────────────────────────────

// _infoFresh reports whether a cached availability answer is still worth reusing.
function _infoFresh(slug) {
    const hit = _infoCache.get(slug);
    return Boolean(hit) && Date.now() - hit.at < _INFO_TTL_MS;
}

// _dvrInfo asks the backend whether this broadcast is being recorded, keeping the
// answer briefly so opening a channel — or opening one that was prefetched on
// hover — doesn't wait on a request. Bounded by _INFO_TTL_MS rather than kept for
// the session, since the answer describes one broadcast.
function _dvrInfo(slug) {
    if (!_infoFresh(slug)) {
        const entry = {
            at: Date.now(),
            promise: fetchDvrInfo(slug)
                .then(info => (info?.status === 'success' ? info.data : null))
                .catch(() => null)
                .then(data => {
                    // A negative answer may be a stream Kick hasn't started recording
                    // yet, or a request that simply failed — drop those immediately so
                    // they're asked again rather than writing off rewind until the TTL.
                    if (!data?.available && _infoCache.get(slug) === entry) _infoCache.delete(slug);
                    return data;
                }),
        };
        _infoCache.set(slug, entry);
    }
    return _infoCache.get(slug).promise;
}

// ── prefetch on intent ───────────────────────────────────────────────────

// Hovering a channel for this long, or holding a finger still on it, is taken as
// intent to open it. The touch dwell is shorter — a finger that is going to scroll
// has usually started moving well inside it — and tolerates a little jitter.
const _PREFETCH_DWELL_MS = 150;
const _PREFETCH_TOUCH_DWELL_MS = 120;
const _PREFETCH_TOUCH_SLOP = 8;

// Ceiling per session, so sweeping the cursor across a grid can't turn into a
// stack of upstream fetches.
const _PREFETCH_MAX = 12;

let _prefetchCount = 0;
let _prefetchTimer = null;

/**
 * Warm a channel's rewind playlists before it is opened.
 *
 * Opening a live channel costs three serial upstream fetches — the video list, the
 * master playlist, then a media playlist — measured at ~2.5s in total, all of it
 * ahead of the first frame. Asking the backend about the channel now (which warms
 * those playlists) moves that work into the time a viewer spends deciding.
 */
export function prefetchDvr(slug) {
    if (!slug || _infoFresh(slug) || _prefetchCount >= _PREFETCH_MAX) return;
    _prefetchCount++;
    void _dvrInfo(slug);
}

/**
 * Watch for intent to open a channel anywhere in the app — the browse grid,
 * favorites, history, search results all use the same link shape.
 */
export function initDvrPrefetch() {
    const slugFrom = (event) => {
        const link = event.target?.closest?.('a[href^="#/channel/"]');
        if (!link) return '';
        try {
            return decodeURIComponent(link.getAttribute('href').slice('#/channel/'.length));
        } catch {
            return '';
        }
    };

    document.addEventListener('mouseover', (e) => {
        const slug = slugFrom(e);
        if (!slug) return;
        clearTimeout(_prefetchTimer);
        _prefetchTimer = setTimeout(() => prefetchDvr(slug), _PREFETCH_DWELL_MS);
    });
    document.addEventListener('mouseout', () => clearTimeout(_prefetchTimer));

    // A touch that stays put is intent to open; a touch that moves is a scroll.
    // Without the distinction, flicking through a grid fires a prefetch for every
    // card the finger lands on — each one an upstream playlist warm for a channel
    // nobody asked for. A stationary tap still gets its head start, because the
    // dwell is far shorter than the gap before the click lands.
    let _touchStart = null;
    document.addEventListener('touchstart', (e) => {
        const slug = slugFrom(e);
        if (!slug) return;
        const touch = e.touches?.[0];
        _touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
        clearTimeout(_prefetchTimer);
        _prefetchTimer = setTimeout(() => prefetchDvr(slug), _PREFETCH_TOUCH_DWELL_MS);
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
        const touch = e.touches?.[0];
        if (!_touchStart || !touch) return;
        if (Math.abs(touch.clientX - _touchStart.x) > _PREFETCH_TOUCH_SLOP
            || Math.abs(touch.clientY - _touchStart.y) > _PREFETCH_TOUCH_SLOP) {
            clearTimeout(_prefetchTimer);   // scrolling, not opening
            _touchStart = null;
        }
    }, { passive: true });
    document.addEventListener('touchcancel', () => { clearTimeout(_prefetchTimer); _touchStart = null; }, { passive: true });
}

/**
 * Which source a live channel should open with.
 *
 * The recording is preferred, because it carries the whole broadcast: the
 * scrubber spans from minute zero instead of from the moment the viewer arrived,
 * which is all the live edge playlist can offer (~30 seconds). The cost is the
 * recording's lag behind the broadcast, so *Go Live* switches to the live edge
 * and the "Live playback start" setting can make that the default.
 *
 * @returns {Promise<{url: string, type?: 'dvr'}>}
 */
export async function preferredLiveSource({ slug, liveUrl }) {
    if (preferences.liveStartMode === 'edge') return { url: liveUrl };

    // Usually settled already: the backend resolves the recording when the live
    // status is fetched, and the answer is kept for the session. When it isn't,
    // start on the live edge rather than delaying the first frame — mountDvrControls
    // upgrades to the full timeline as soon as the answer lands.
    const data = await Promise.race([
        _dvrInfo(slug),
        new Promise(resolve => setTimeout(() => resolve(undefined), _INFO_TIMEOUT_MS)),
    ]);
    return data?.available && data.playlist_url
        ? { url: data.playlist_url, type: 'dvr' }
        : { url: liveUrl };
}

// _shouldUpgradeToTimeline reports whether this stream can still be moved onto the
// recording. Elapsed wall-clock decides it, not currentTime: on a live playlist
// currentTime starts at whatever offset the window has, so it says nothing about
// how long the viewer has been watching.
function _shouldUpgradeToTimeline() {
    if (!_state?.dvrUrl || preferences.liveStartMode === 'edge' || _isDvrActive()) return false;
    const video = getVideoElement();
    if (!video || video.seeking) return false;
    return Date.now() - getStreamLoadedAt() < _UPGRADE_GRACE_SECONDS * 1000;
}

// _primeOncePlaying waits for the stream to be running before fetching anything for
// the past, so priming never competes with the segments that get the first frame on
// screen. If playback never settles, the rewind path just pays for itself later.
async function _primeOncePlaying() {
    const video = getVideoElement();
    const url = _state?.dvrUrl;
    if (!video || !url) return;

    const playing = () => !video.paused && video.readyState >= 3;
    if (!playing()) {
        const settled = await new Promise((resolve) => {
            const done = (ok) => { video.removeEventListener('playing', onPlaying); resolve(ok); };
            const onPlaying = () => done(true);
            video.addEventListener('playing', onPlaying);
            setTimeout(() => done(playing()), _PRIME_WAIT_MS);
        });
        if (!settled) return;
    }
    // Let the player finish filling its buffer before spending bandwidth on a
    // playlist nobody is waiting for.
    await new Promise(r => setTimeout(r, _PRIME_SETTLE_MS));
    if (_state?.dvrUrl !== url) return; // navigated away meanwhile
    await _primeDvrSource(url);
}

// _primeDvrSource pulls the master and one media playlist into the browser cache so
// a source switch costs a parse rather than two upstream round trips.
async function _primeDvrSource(dvrUrl) {
    try {
        const masterURL = new URL(dvrUrl, location.href).href;
        const master = await (await fetch(masterURL)).text();
        const variant = master.split('\n')
            .map(line => line.trim())
            .find(line => line.endsWith('playlist.m3u8'));
        if (variant) await fetch(new URL(variant, masterURL).href);
    } catch { /* the switch just won't have the head start */ }
}

// ── Mount ────────────────────────────────────────────────────────────────

/**
 * Wire up the rewind controls for a live channel. Resolves once availability is
 * known; returns a disposer that drops this channel's rewind state without
 * stopping playback (a rewound stream keeps playing in the mini-player).
 *
 * @param {{slug: string, liveUrl: string, liveData: object, title?: string}} args
 * @returns {Promise<() => void>}
 */
export async function mountDvrControls({ slug, liveUrl, liveData, title }) {
    dispose();
    if (!slug || !liveUrl) return () => {};

    const data = await _dvrInfo(slug);
    if (!data?.available || !data.playlist_url) {
        // Kick isn't recording this broadcast (or hasn't started yet): there is
        // nothing to rewind into, so the player's timeline stays a live-only one.
        return () => {};
    }

    // A stream may have been switched out while the availability check was in
    // flight (tab change, navigation).
    if (getCurrentStream()?.slug !== slug) return () => {};

    _state = { slug, dvrUrl: data.playlist_url, liveUrl, liveData, title: title || data.title };
    // started_at is UTC without a zone marker; left to the browser it would be read
    // as local time and the timeline would be hours long or negative.
    _startedAtMs = data.started_at ? Date.parse(`${String(data.started_at).replace(' ', 'T')}Z`) || 0 : 0;

    _onKeydown = (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const el = e.target;
        // Anything that owns its arrow keys keeps them. The channel's tab list is
        // the reason this list isn't just form fields: it implements the APG roving
        // tabindex, so an unscoped handler here moved the tab *and* seeked the
        // stream on the same keypress.
        if (el?.closest?.(_KEY_EXEMPT_SELECTOR)) return;
        if (document.querySelector('.modal.visible')) return;

        const step = { ArrowLeft: -30, ArrowRight: 30, j: -10, J: -10, l: 10, L: 10 }[e.key];
        if (step === undefined) return;
        // Live mode has nothing to seek forward into.
        if (step > 0 && !_isDvrActive()) return;
        e.preventDefault();
        _seek(step);
    };
    document.addEventListener('keydown', _onKeydown);

    // Getting the past ready is deliberately not part of getting the stream
    // playing. Once playback is flowing, the recording's playlists are fetched in
    // the background so the first rewind is instant — but nothing switches source
    // on its own: the recording trails the live edge and never catches up to a
    // viewer watching at normal speed, so any automatic switch would jump them
    // backwards by that lag. Rewinding is when they've asked for it.
    void _primeOncePlaying();

    // In 'timeline' mode the viewer has asked for the whole broadcast up front, so
    // there the switch does happen — while playback is still starting, never after
    // they have settled in.
    if (_shouldUpgradeToTimeline()) {
        await _primeDvrSource(_state.dvrUrl);
        if (_shouldUpgradeToTimeline()) _enterDvr();
    }

    if (!_seenHint()) {
        toast('This stream is seekable — drag the player\'s timeline, or use ← / →', 'info');
        _markHintSeen();
    }

    return dispose;
}

export function dispose() {
    if (_onKeydown) { document.removeEventListener('keydown', _onKeydown); _onKeydown = null; }
    _state = null;
    _pendingBehind = 0;
    _startedAtMs = 0;
}

// One-time discoverability hint; the controls are otherwise easy to miss under
// the native control bar.
const _HINT_KEY = 'kick_dvr_hint_seen';
function _seenHint() {
    try { return localStorage.getItem(_HINT_KEY) === '1'; } catch { return true; }
}
function _markHintSeen() {
    try { localStorage.setItem(_HINT_KEY, '1'); } catch { /* non-persistent is fine */ }
}
