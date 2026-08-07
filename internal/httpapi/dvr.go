package httpapi

// DVR (live rewind) support.
//
// Kick records every livestream to a VOD *while it is still live*: the
// recording's HLS playlist is append-only (#EXT-X-PLAYLIST-TYPE:EVENT) and
// grows in real time, so it already holds the broadcast from minute zero. That
// makes it a full DVR window — something the live edge playlist cannot give us,
// since its sliding window is only ~30 seconds wide.
//
// Two upstream quirks stop players from using the recording directly:
//
//  1. Kick writes #EXT-X-ENDLIST on every rewrite of the playlist, even
//     mid-broadcast. Players take that as "this VOD is complete", so they never
//     poll for new segments: playback would stop dead at whatever duration the
//     recording had when the page loaded.
//  2. Segment URIs are relative to the upstream recording directory, which is a
//     different origin from this app.
//
// So the media playlists are proxied here: ENDLIST is dropped while the
// recording is still being appended to, and segment URIs are absolutized. The
// master playlist is served verbatim — its variant URIs are relative
// ({variant}/playlist.m3u8) and resolve against this proxy's own path.
//
// The live edge playlist stays the default source for live playback (it is
// ~30s ahead of the recording); the frontend switches to the DVR playlist only
// when the viewer rewinds, and back when they return to live.

import (
	"bytes"
	"fmt"
	"hash/fnv"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/klauspost/compress/gzip"
	"kickapi/internal/apierr"
	"kickapi/internal/obs"
	"kickapi/internal/transform"
)

const (
	// dvrRecordingHost is the only host a recording may be proxied from. The
	// source URL comes from an upstream API response, so it is pinned rather
	// than trusted — otherwise a changed (or poisoned) upstream payload would
	// turn this proxy into an open one.
	dvrRecordingHost = "stream.kick.com"

	// dvrGrowingWindow is how recently the recording must have been rewritten
	// (per its #ID3-EQUIV-TDTG stamp) to count as still growing.
	dvrGrowingWindow = 90 * time.Second

	// dvrMaxRecordingAge bounds how old an unfinished recording may be before
	// it stops being a plausible stand-in for the current broadcast.
	dvrMaxRecordingAge = 48 * time.Hour

	// dvrClockSkew tolerates a created_at slightly in the future (upstream
	// clock skew, or a recording registered before its first segment lands).
	dvrClockSkew = 10 * time.Minute

	// Bounds on the refresh cadence derived from a playlist's target duration:
	// often enough to track a moving live edge, rarely enough not to re-fetch a
	// playlist that cannot have changed.
	dvrMinRefreshInterval = 5 * time.Second
	dvrMaxRefreshInterval = 30 * time.Second

	// dvrRenderedTTL keeps a rendered rendition around a little past the idle
	// window, so a viewer returning to it doesn't pay to re-render.
	dvrRenderedTTL = 60 * time.Second

	// dvrGzipLevel matches the response middleware's level, so moving compression
	// off the request path doesn't change what clients receive.
	dvrGzipLevel = 5

	// dvrWatchIdleWindow is how long after the last request a recording keeps
	// being refreshed in the background.
	dvrWatchIdleWindow = 30 * time.Second

	// dvrKeeperMaxFailures stops a keeper whose recording has stopped answering
	// (a rendition withdrawn, upstream gone) instead of retrying forever.
	dvrKeeperMaxFailures = 3
)

func dvrRecordingKeys(base string) (staleKey, freshKey string) {
	return "dvr-rec:" + base, "dvr-rec-fresh:" + base
}

// dvrRecording is a recording's media playlist as fetched from upstream, cached
// once per broadcast and shared by every rendition.
//
// Segment URIs in it are relative to their rendition's directory, and HLS
// requires every rendition of a ladder to share segment boundaries for ABR
// switching to work at all — so one fetched playlist describes them all, and any
// rendition is served by resolving this same body against its own directory.
// Verified against a live recording: 1553 segments with identical names,
// durations, and program dates across 1080p60 and 360p30.
//
// That matters because a player switching level asks for a rendition it has never
// requested before. Fetching that from upstream took 300–1200ms — a stall for
// content already in memory.
//
// Alongside the playlist text it keeps the few properties everything else is
// derived from, so the proxy reasons about metadata instead of re-scanning
// hundreds of kilobytes: the stamp upstream rewrites on every change, the segment
// count, and the target duration — which is how often the playlist can change at
// all, and therefore how often it is worth refreshing or re-rendering.
type dvrRecording struct {
	body     []byte
	growing  bool
	stamp    string        // #ID3-EQUIV-TDTG, changes on every upstream rewrite
	segments int           // #EXTINF count
	target   time.Duration // #EXT-X-TARGETDURATION
}

// version identifies these contents. Two playlists agree on it only if upstream
// hasn't rewritten the recording since, which makes it both the cache key for
// rendered output and the basis of the client-facing validator — no hashing of
// the body required.
func (r dvrRecording) version() string {
	if r.stamp == "" {
		// No stamp to trust: fall back to fingerprinting the body.
		return "h" + strconv.FormatUint(fnvHash(r.body), 36)
	}
	return r.stamp + "/" + strconv.Itoa(r.segments)
}

// dvrResponse is one rendition's rendered playlist, compressed once per change and
// shared by every viewer of it. Only the compressed copy is kept: it is ~11KB
// against ~324KB of text, and virtually every client accepts gzip.
type dvrResponse struct {
	version string
	etag    string
	gzipped []byte
}

// Variant directory names as they appear in a recording master playlist
// ("720p60", "480p30", "audio_only"). Constrained to one path segment with no
// dots, so a variant can never escape the recording directory.
var dvrVariantRe = regexp.MustCompile(`^[a-z0-9_]{1,24}$`)

// #ID3-EQUIV-TDTG:2026-07-27T15:00:41 — the time Kick last rewrote the
// playlist. The only reliable "still recording" signal, since ENDLIST is
// present either way.
var dvrTDTGRe = regexp.MustCompile(`(?m)^#ID3-EQUIV-TDTG:(\S+)`)

// #EXT-X-TARGETDURATION:13 — the segment cadence every timing here derives from.
var dvrTargetRe = regexp.MustCompile(`(?m)^#EXT-X-TARGETDURATION:(\d+)`)

var extinfTag = []byte("#EXTINF:")

// dvrSource identifies the recording that backs a channel's DVR window. A zero
// value means "no in-progress recording", and is cached as such.
type dvrSource struct {
	BaseURL   string // recording directory, ends in "/"
	VODID     any
	Title     any
	CreatedAt string
}

func (s dvrSource) ok() bool { return s.BaseURL != "" }

// ── /streams/dvr/{slug} ─────────────────────────────────────────────────────

// handleDVRInfo reports whether the channel's current broadcast has a rewindable
// recording, and where to play it. An absent recording is a successful response
// with available:false, not an error — the frontend hides its rewind controls
// rather than surfacing a failure for a channel Kick simply isn't recording.
func (a *App) handleDVRInfo(w http.ResponseWriter, r *http.Request) {
	slug, ok := a.slug(w, r)
	if !ok {
		return
	}
	src, apiErr := a.dvrSource(slug)
	if apiErr != nil {
		writeAPIErr(w, apiErr)
		return
	}
	if !src.ok() {
		writeJSON(w, 200, envelopeMap("success", "", map[string]any{"available": false}))
		return
	}
	// Asking this is the clearest signal a player is about to load: its next two
	// requests are the master and a media playlist, so start fetching them now
	// rather than serially after this response.
	a.warmDVRPlaylistsAsync(slug, src)
	writeJSON(w, 200, envelopeMap("success", "", map[string]any{
		"available":    true,
		"vod_id":       src.VODID,
		"title":        src.Title,
		"started_at":   src.CreatedAt,
		"playlist_url": "/streams/dvr/" + slug + "/master.m3u8",
	}))
}

// ── /streams/dvr/{slug}/master.m3u8 ─────────────────────────────────────────

// handleDVRMaster proxies the recording's master playlist. Its variant URIs are
// relative, so they resolve against this route's own path and land on
// handleDVRMedia — no rewriting needed.
func (a *App) handleDVRMaster(w http.ResponseWriter, r *http.Request) {
	slug, ok := a.slug(w, r)
	if !ok {
		return
	}
	src, apiErr := a.dvrSource(slug)
	if apiErr != nil {
		writeAPIErr(w, apiErr)
		return
	}
	if !src.ok() {
		errorJSON(w, fmt.Sprintf("No in-progress recording for channel '%s'.", slug), 404)
		return
	}

	body, err := a.dvrMaster(src)
	if err != nil {
		a.log.Error("failed to proxy DVR master playlist", "slug", slug, "error", err)
		errorJSON(w, "Failed to load rewind playlist.", 502)
		return
	}
	writeM3U8(w, body)
}

// dvrMaster returns the recording's master playlist, cached per recording so a new
// broadcast can never be served the previous one's.
func (a *App) dvrMaster(src dvrSource) ([]byte, error) {
	key := "dvr-master:" + src.BaseURL
	if body, ok := a.cachedBytes(key); ok {
		return body, nil
	}
	body, err := a.kick.FetchPlaylist(src.BaseURL + "master.m3u8")
	if err != nil {
		return nil, err
	}
	a.cache.SetTTL(key, body, a.ttl(a.cfg.DVRSourceCacheDurationSeconds))
	return body, nil
}

// dvrFirstVariant returns any rendition named in a master playlist. Any will do:
// one fetched media playlist serves them all, so warming one warms the ladder.
func dvrFirstVariant(master []byte) string {
	for _, line := range bytes.Split(master, []byte("\n")) {
		trimmed := string(bytes.TrimSpace(line))
		name, ok := strings.CutSuffix(trimmed, "/playlist.m3u8")
		if ok && dvrVariantRe.MatchString(name) {
			return name
		}
	}
	return ""
}

// ── /streams/dvr/{slug}/{variant}/playlist.m3u8 ─────────────────────────────

// handleDVRMedia proxies one variant's media playlist, absolutizing its segment
// URIs and dropping ENDLIST while the recording is still growing (see the
// package comment) so players keep polling and the DVR window extends with the
// broadcast.
func (a *App) handleDVRMedia(w http.ResponseWriter, r *http.Request) {
	slug, ok := a.slug(w, r)
	if !ok {
		return
	}
	variant := r.PathValue("variant")
	if !dvrVariantRe.MatchString(variant) {
		errorJSON(w, fmt.Sprintf("Invalid stream variant: '%s'.", variant), 400)
		return
	}
	src, apiErr := a.dvrSource(slug)
	if apiErr != nil {
		writeAPIErr(w, apiErr)
		return
	}
	if !src.ok() {
		errorJSON(w, fmt.Sprintf("No in-progress recording for channel '%s'.", slug), 404)
		return
	}

	// While anyone is watching, the recording is refreshed on a timer rather than
	// on demand, so no request — not even a player's first look at a rendition it
	// just switched to — ends up waiting on an upstream fetch.
	a.cache.SetTTL("dvr-watch:"+src.BaseURL, true, dvrWatchIdleWindow)
	a.startDVRKeeper(slug, src.BaseURL, variant)

	// One cached playlist per recording, shared by every rendition, refreshed
	// stale-while-revalidate: a player's refresh reads from memory instead of
	// waiting behind an upstream fetch (measured at 250–1200ms), and switching
	// rendition costs a rewrite rather than a fetch.
	rec, err := a.dvrRecordingFor(slug, src.BaseURL, variant, r.Header.Get("If-None-Match") != "")
	if err != nil {
		a.log.Error("failed to proxy DVR media playlist", "slug", slug, "variant", variant, "error", err)
		errorJSON(w, "Failed to load rewind playlist.", 502)
		return
	}

	playlistURL := src.BaseURL + variant + "/playlist.m3u8"
	resp := a.dvrResponseFor(src.BaseURL, variant, rec)

	h := w.Header()
	h.Set("Content-Type", "application/vnd.apple.mpegurl")
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Cache-Control", "no-cache")
	h.Set("ETag", resp.etag)
	h.Set("Vary", "Accept-Encoding")
	// The validator covers (recording version, rendition), so an unchanged refresh
	// costs nothing but the comparison.
	if etagMatches(r.Header.Get("If-None-Match"), resp.etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if len(resp.gzipped) > 0 && acceptsGzip(r) {
		// Already compressed, which also tells the compressing middleware to pass
		// this through untouched.
		h.Set("Content-Encoding", "gzip")
		_, _ = w.Write(resp.gzipped)
		return
	}
	_, _ = w.Write(rewriteDVRPlaylist(playlistURL, rec.body, rec.growing))
}

// dvrResponseFor renders and compresses a rendition's playlist once per change to
// the recording, so viewers of the same rendition share the work: rendering and
// compressing per request measured 499µs and 1.46MB of garbage, against ~17µs to
// hand back bytes already prepared.
func (a *App) dvrResponseFor(base, variant string, rec dvrRecording) dvrResponse {
	key := "dvr-out:" + base + variant
	version := rec.version()
	if v, ok := a.cache.Get(key); ok {
		if resp, ok := v.(dvrResponse); ok && resp.version == version {
			return resp
		}
	}

	plain := rewriteDVRPlaylist(base+variant+"/playlist.m3u8", rec.body, rec.growing)
	resp := dvrResponse{
		version: version,
		etag:    `"` + strconv.FormatUint(fnvHashString(version+"\x00"+variant), 36) + `"`,
		gzipped: gzipPlaylist(plain),
	}
	a.cache.SetTTL(key, resp, dvrRenderedTTL)
	return resp
}

func acceptsGzip(r *http.Request) bool {
	for _, encoding := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(encoding), ";")
		if !strings.EqualFold(name, "gzip") {
			continue
		}
		// Only q=0 is a refusal; any other weight (q=0.8 and friends) accepts it.
		for _, param := range strings.Split(params, ";") {
			key, value, ok := strings.Cut(strings.TrimSpace(param), "=")
			if !ok || !strings.EqualFold(key, "q") {
				continue
			}
			if weight, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
				return weight > 0
			}
		}
		return true
	}
	return false
}

// gzipPlaylist compresses at the same level as the response middleware, so moving
// compression here changes only when it happens, not what clients receive.
func gzipPlaylist(body []byte) []byte {
	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, dvrGzipLevel)
	if err != nil {
		return nil
	}
	if _, err := zw.Write(body); err != nil {
		return nil
	}
	if err := zw.Close(); err != nil {
		return nil
	}
	return buf.Bytes()
}

// dvrRecordingFor returns the recording's cached playlist, refreshing it in the
// background once stale. A caller that already holds a copy (it sent a validator)
// is answered from cache immediately; one loading for the first time waits for a
// current copy, since it reads the live edge off the playlist to choose where to
// start — a stale copy would silently become startup latency.
func (a *App) dvrRecordingFor(slug, base, variant string, revalidating bool) (dvrRecording, error) {
	staleKey, freshKey := dvrRecordingKeys(base)

	if rec, ok := a.cachedRecording(staleKey); ok {
		_, fresh := a.cache.Get(freshKey)
		// A keeper refreshing on a timer means the cached copy is recent by
		// construction, so a rendition switch is served from memory rather than
		// paying for a fetch just because it arrived between refreshes.
		if fresh || revalidating || a.dvrKeeperRunning(base) {
			if !fresh && a.inflight.ClaimInflight(freshKey) {
				go func() {
					defer a.inflight.DedupSet(freshKey)
					if _, err := a.loadDVRRecording(slug, base, variant, staleKey, freshKey); err != nil {
						a.log.Info("dvr playlist refresh failed", "slug", slug, "error", err)
					}
				}()
			}
			return rec, nil
		}
	}

	// Concurrent callers coalesce onto one upstream request; waiting on the fresh
	// marker also picks up a refresh already in flight.
	if _, ok := a.inflight.DedupGet(a.cache, freshKey, a.ttlFloat(a.cfg.LiveInflightWaitTimeoutSeconds)); ok {
		if rec, ok := a.cachedRecording(staleKey); ok {
			return rec, nil
		}
	}
	defer a.inflight.DedupSet(freshKey)
	return a.loadDVRRecording(slug, base, variant, staleKey, freshKey)
}

// ── keeping a watched recording warm ────────────────────────────────────────

// startDVRKeeper begins refreshing a recording on a timer, at most one keeper per
// recording. It exits once nothing has requested the recording for
// dvrWatchIdleWindow, so an abandoned broadcast stops costing upstream fetches.
func (a *App) startDVRKeeper(slug, base, variant string) {
	a.dvrKeepersMu.Lock()
	if _, running := a.dvrKeepers[base]; running {
		a.dvrKeepersMu.Unlock()
		return
	}
	a.dvrKeepers[base] = struct{}{}
	a.dvrKeepersMu.Unlock()
	go a.runDVRKeeper(slug, base, variant)
}

func (a *App) dvrKeeperRunning(base string) bool {
	a.dvrKeepersMu.Lock()
	defer a.dvrKeepersMu.Unlock()
	_, running := a.dvrKeepers[base]
	return running
}

func (a *App) runDVRKeeper(slug, base, variant string) {
	defer func() {
		a.dvrKeepersMu.Lock()
		delete(a.dvrKeepers, base)
		a.dvrKeepersMu.Unlock()
	}()

	interval := a.ttl(a.cfg.DVRPlaylistCacheDurationSeconds)
	if interval < time.Second {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	failures := 0
	for {
		select {
		case <-a.shutdownCh:
			return
		case <-ticker.C:
			watched, err := a.refreshWatchedRecording(slug, base, variant)
			if !watched {
				return
			}
			if err == nil {
				failures = 0
				continue
			}
			if failures++; failures >= dvrKeeperMaxFailures {
				a.log.Info("dvr keeper giving up", "slug", slug, "error", err)
				return
			}
		}
	}
}

// refreshWatchedRecording refreshes the recording if anything is still requesting
// it, reporting whether it is still being watched.
func (a *App) refreshWatchedRecording(slug, base, variant string) (bool, error) {
	if _, watched := a.cache.Get("dvr-watch:" + base); !watched {
		return false, nil
	}
	staleKey, freshKey := dvrRecordingKeys(base)
	_, err := a.loadDVRRecording(slug, base, variant, staleKey, freshKey)
	return true, err
}

// loadDVRRecording fetches the recording's playlist through one of its renditions
// and caches it for all of them.
func (a *App) loadDVRRecording(slug, base, variant, staleKey, freshKey string) (dvrRecording, error) {
	body, err := a.kick.FetchPlaylist(base + variant + "/playlist.m3u8")
	if err != nil {
		return dvrRecording{}, err
	}

	growing, known := dvrRecordingGrowing(body, time.Now().UTC())
	if !known {
		// No TDTG stamp to read — fall back to the channel's live status, so a
		// change in upstream tagging degrades to "no rewind past the snapshot"
		// rather than a player that waits forever for segments after the
		// broadcast has ended.
		growing = a.channelIsLive(slug)
	}

	stamp, _ := dvrPlaylistStamp(body)
	rec := dvrRecording{
		body:     body,
		growing:  growing,
		stamp:    stamp,
		segments: bytes.Count(body, extinfTag),
		target:   dvrTargetDuration(body),
	}

	// The playlist cannot change more often than one segment, so that is both how
	// long this copy counts as current and the cadence worth refreshing it at.
	interval := a.dvrRefreshInterval(rec)
	a.cache.SetTTL(staleKey, rec, 4*interval)
	a.cache.SetTTL(freshKey, true, interval)
	return rec, nil
}

// dvrRefreshInterval is how often a recording is worth re-fetching: its own target
// duration, since nothing can change in between. Bounded either way, and falling
// back to the configured value when the playlist doesn't declare one.
func (a *App) dvrRefreshInterval(rec dvrRecording) time.Duration {
	interval := rec.target
	if interval <= 0 {
		interval = a.ttl(a.cfg.DVRPlaylistCacheDurationSeconds)
	}
	if interval < dvrMinRefreshInterval {
		interval = dvrMinRefreshInterval
	}
	if interval > dvrMaxRefreshInterval {
		interval = dvrMaxRefreshInterval
	}
	return interval
}

// ── source resolution ───────────────────────────────────────────────────────

// dvrSource resolves (and caches) the recording backing the channel's current
// broadcast. A resolved "none" is cached too, so channels without a recording
// don't re-hit upstream on every playlist refresh.
//
// The cache is scoped to the live session, so a streamer who ends a broadcast
// and starts another doesn't keep serving the previous broadcast's recording for
// the rest of the source TTL.
func (a *App) dvrSource(slug string) (dvrSource, *apierr.Error) {
	key := "dvr-src:" + slug + ":" + a.liveSessionID(slug)
	if v, ok := a.cache.Get(key); ok {
		if src, ok := v.(dvrSource); ok {
			// A resolved recording is touched on read, so a broadcast someone is
			// watching keeps it warm: an expiry mid-playback would otherwise put an
			// upstream lookup in front of the next playlist refresh. A negative
			// result is left on its short TTL — a broadcast Kick hasn't started
			// recording yet should be re-checked soon, not written off.
			if src.ok() {
				a.cache.SetTTL(key, src, a.ttl(a.cfg.DVRSourceCacheDurationSeconds))
			}
			return src, nil
		}
	}
	vods, apiErr := a.channelVODs(slug)
	if apiErr != nil {
		return dvrSource{}, apiErr
	}
	src := pickInProgressRecording(vods, time.Now().UTC())
	ttl := a.ttl(a.cfg.DVRSourceCacheDurationSeconds)
	if !src.ok() {
		ttl = a.ttl(a.cfg.NegativeCacheDurationSeconds)
	}
	a.cache.SetTTL(key, src, ttl)
	return src, nil
}

// channelVODs returns the channel's normalised VOD list, reusing the /streams/vods
// cache when it is warm — the DVR source is derived from the same payload, so
// there is no reason to pay for a second upstream fetch.
func (a *App) channelVODs(slug string) ([]map[string]any, *apierr.Error) {
	if c, ok := a.cacheGet("vods:/streams/vods/" + slug); ok {
		if data, _ := c.payload["data"].(map[string]any); data != nil {
			if list, ok := data["vods"].([]map[string]any); ok {
				return list, nil
			}
		}
	}
	raw, apiErr := kickCall(a.cbNonCritical, obs.LaneNonCritical, slug, func() (any, error) {
		return a.kick.GetChannelVideos(slug)
	})
	if apiErr != nil {
		return nil, apiErr
	}
	return transform.ProcessVODData(raw), nil
}

// warmDVRSource resolves a live channel's recording in the background, so that by
// the time the frontend asks whether the broadcast is rewindable the answer is a
// cache hit. Without this, opening a channel cold would race the lookup and fall
// back to the live edge playlist — leaving playback stuck with a ~30s timeline
// for no reason other than timing.
func (a *App) warmDVRSource(slug string) {
	if _, ok := a.cache.Get("dvr-src:" + slug + ":" + a.liveSessionID(slug)); ok {
		return
	}
	// One attempt in flight per channel; the marker also throttles retries for
	// channels that turn out not to be recorded.
	if !a.cache.SetIfAbsent("dvr-warm:"+slug, true, a.ttl(a.cfg.NegativeCacheDurationSeconds)) {
		return
	}
	go func() {
		if !a.refreshLimiter.tryAcquire(a.ttlFloat(a.cfg.BackgroundRefreshAcquireTimeoutSeconds)) {
			return
		}
		defer a.refreshLimiter.release()
		src, apiErr := a.dvrSource(slug)
		if apiErr != nil {
			a.log.Info("dvr warm failed", "slug", slug, "error", apiErr.Message)
			return
		}
		if src.ok() {
			a.warmDVRPlaylistsAsync(slug, src)
		}
	}()
}

// warmDVRPlaylistsAsync runs the playlist warm in the background, at most one per
// recording, so it never delays the response that triggered it.
func (a *App) warmDVRPlaylistsAsync(slug string, src dvrSource) {
	if !a.cache.SetIfAbsent("dvr-warm-pl:"+src.BaseURL, true, dvrWatchIdleWindow) {
		return
	}
	go a.warmDVRPlaylists(slug, src)
}

// warmDVRPlaylists fetches what the player asks for immediately after the live
// status: the master playlist, then a rendition's media playlist. Cold, those are
// two serial upstream fetches — measured at 1607ms and 1270ms, 57% of a 5s time to
// first frame — and they sit squarely on the critical path. Fetched here they land
// while the page is still rendering, and because one media playlist serves every
// rendition, warming one covers whichever the player picks.
func (a *App) warmDVRPlaylists(slug string, src dvrSource) {
	master, err := a.dvrMaster(src)
	if err != nil {
		a.log.Info("dvr master warm failed", "slug", slug, "error", err)
		return
	}
	variant := dvrFirstVariant(master)
	if variant == "" {
		return
	}
	if _, err := a.dvrRecordingFor(slug, src.BaseURL, variant, false); err != nil {
		a.log.Info("dvr playlist warm failed", "slug", slug, "variant", variant, "error", err)
	}
}

// pickInProgressRecording returns the recording Kick is still writing, if any.
// Kick reports duration 0 until it finalises a recording, so the newest
// zero-duration entry with a plausible created_at is the live session's DVR
// source. Entries whose source URL isn't a recording on the pinned host are
// ignored.
func pickInProgressRecording(vods []map[string]any, now time.Time) dvrSource {
	var best dvrSource
	var bestAt time.Time
	for _, vod := range vods {
		duration, ok := numeric(vod["duration_seconds"])
		if !ok || duration != 0 {
			continue
		}
		sourceURL, _ := vod["source_url"].(string)
		base, ok := dvrBaseURL(sourceURL)
		if !ok {
			continue
		}
		createdAt, _ := vod["created_at"].(string)
		created, ok := parseKickTimestamp(createdAt)
		if !ok {
			continue
		}
		age := now.Sub(created)
		if age > dvrMaxRecordingAge || age < -dvrClockSkew {
			continue
		}
		if best.ok() && !created.After(bestAt) {
			continue
		}
		best = dvrSource{BaseURL: base, VODID: vod["vod_id"], Title: vod["title"], CreatedAt: createdAt}
		bestAt = created
	}
	return best
}

// dvrBaseURL returns the recording's directory URL (everything up to
// master.m3u8), rejecting anything that isn't an HTTPS recording master on the
// pinned host.
func dvrBaseURL(sourceURL string) (string, bool) {
	u, err := url.Parse(sourceURL)
	if err != nil || u.Scheme != "https" || u.Host != dvrRecordingHost {
		return "", false
	}
	if u.RawQuery != "" || !strings.HasSuffix(u.Path, "/master.m3u8") {
		return "", false
	}
	u.Fragment = ""
	return strings.TrimSuffix(u.String(), "master.m3u8"), true
}

// parseKickTimestamp parses the "2026-07-27 09:00:07" form Kick uses for
// created_at (UTC), also accepting RFC 3339.
func parseKickTimestamp(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{"2006-01-02 15:04:05", time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

// numeric reports v as a float64 when it is a JSON number.
func numeric(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

// ── playlist rewriting ──────────────────────────────────────────────────────

// dvrPlaylistStamp returns the #ID3-EQUIV-TDTG value: the time upstream last
// rewrote this playlist. It doubles as a change marker, since a rewrite is the
// only thing that moves it.
func dvrPlaylistStamp(body []byte) (string, bool) {
	m := dvrTDTGRe.FindSubmatch(body)
	if m == nil {
		return "", false
	}
	return string(m[1]), true
}

// dvrTargetDuration reads #EXT-X-TARGETDURATION — the longest a segment may run,
// and so the shortest interval at which the playlist can gain one.
func dvrTargetDuration(body []byte) time.Duration {
	m := dvrTargetRe.FindSubmatch(body)
	if m == nil {
		return 0
	}
	seconds, err := strconv.Atoi(string(m[1]))
	if err != nil || seconds <= 0 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}

// dvrRecordingGrowing reports whether the recording is still being appended to,
// and whether that could be determined at all.
func dvrRecordingGrowing(body []byte, now time.Time) (growing, known bool) {
	raw, ok := dvrPlaylistStamp(body)
	if !ok {
		return false, false
	}
	// The stamp carries no zone; upstream writes it in UTC.
	stamp, err := time.Parse("2006-01-02T15:04:05", raw)
	if err != nil {
		return false, false
	}
	return now.Sub(stamp.UTC()) <= dvrGrowingWindow, true
}

// rewriteDVRPlaylist absolutizes segment URIs against the upstream playlist and,
// while the recording is still growing, drops the ENDLIST tag Kick writes on
// every rewrite — the tag that would otherwise freeze the DVR window at its
// load-time length.
//
// This is the hottest path in the DVR proxy: it runs for every viewer's playlist
// refresh, on playlists that reach thousands of lines for a long broadcast. So it
// is one pass with a single output allocation. Resolving each segment line as a
// URL instead cost ~16k allocations and 3.5MB of garbage per refresh, which on a
// Raspberry Pi is several milliseconds of avoidable GC pressure every few seconds.
func rewriteDVRPlaylist(playlistURL string, body []byte, growing bool) []byte {
	base, err := url.Parse(playlistURL)
	dir, root, ok := dvrURIPrefixes(base)
	// Byteranges need the segment-duration reordering the general path applies,
	// and recordings don't use them — so hand those (and unparseable URLs) over
	// rather than growing a second implementation.
	if err != nil || !ok || bytes.Contains(body, byteRangeTag) {
		body = absolutizeHLSReferences(playlistURL, body)
		if growing {
			body = dropTagLines(body, endListTag)
		}
		return body
	}

	// Segment lines gain the directory prefix; ".ts" counts them closely enough
	// to size the buffer in one shot.
	out := make([]byte, 0, len(body)+bytes.Count(body, tsSuffix)*len(dir)+64)
	for rest := body; len(rest) > 0; {
		line := rest
		if i := bytes.IndexByte(rest, '\n'); i >= 0 {
			line, rest = rest[:i+1], rest[i+1:]
		} else {
			rest = nil
		}
		trimmed := bytes.TrimRight(line, "\r\n")

		switch {
		case len(trimmed) == 0:
			// blank line — preserved as-is
		case trimmed[0] == '#':
			if growing && bytes.Equal(trimmed, endListTag) {
				continue
			}
			if bytes.Contains(trimmed, uriAttribute) {
				out = append(out, absolutizeHLSURIAttributes(base, string(trimmed))...)
				out = append(out, line[len(trimmed):]...) // original line ending
				continue
			}
		case bytes.HasPrefix(trimmed, httpsScheme), bytes.HasPrefix(trimmed, httpScheme):
			// already absolute
		case trimmed[0] == '/':
			out = append(out, root...)
		default:
			out = append(out, dir...)
		}
		out = append(out, line...)
	}
	return out
}

var (
	endListTag   = []byte("#EXT-X-ENDLIST")
	byteRangeTag = []byte("#EXT-X-BYTERANGE:")
	uriAttribute = []byte(`URI="`)
	httpsScheme  = []byte("https://")
	httpScheme   = []byte("http://")
	tsSuffix     = []byte(".ts")
)

// dvrURIPrefixes splits a playlist URL into the prefixes relative segment URIs
// resolve against: its directory, and its scheme+host for root-relative ones.
func dvrURIPrefixes(u *url.URL) (dir, root string, ok bool) {
	if u == nil || u.Scheme == "" || u.Host == "" {
		return "", "", false
	}
	slash := strings.LastIndexByte(u.Path, '/')
	if slash < 0 {
		return "", "", false
	}
	root = u.Scheme + "://" + u.Host
	return root + u.Path[:slash+1], root, true
}

func dropTagLines(body, tag []byte) []byte {
	out := make([]byte, 0, len(body))
	for rest := body; len(rest) > 0; {
		line := rest
		if i := bytes.IndexByte(rest, '\n'); i >= 0 {
			line, rest = rest[:i+1], rest[i+1:]
		} else {
			rest = nil
		}
		if bytes.Equal(bytes.TrimRight(line, "\r\n"), tag) {
			continue
		}
		out = append(out, line...)
	}
	return out
}

// fnvHash is a content fingerprint for change detection. Non-cryptographic on
// purpose: it runs over a few hundred KB per refresh and only needs to notice
// that the recording grew.
func fnvHash(body []byte) uint64 {
	h := fnv.New64a()
	_, _ = h.Write(body)
	return h.Sum64()
}

func fnvHashString(s string) uint64 {
	return fnvHash([]byte(s))
}

// ── shared helpers ──────────────────────────────────────────────────────────

// channelIsLive reads the channel's live status from the /play cache without
// triggering an upstream fetch.
func (a *App) channelIsLive(slug string) bool {
	v, ok := a.cache.Get("live:/streams/play/" + slug)
	if !ok {
		return false
	}
	data := extractDataMap(v)
	return data != nil && data["status"] == "live"
}

// liveSessionID identifies the channel's current broadcast from the /play cache
// (empty when it hasn't been fetched yet). Used only to scope caches to a single
// broadcast, so an unknown value is a distinct bucket rather than an error.
func (a *App) liveSessionID(slug string) string {
	v, ok := a.cache.Get("live:/streams/play/" + slug)
	if !ok {
		return ""
	}
	data := extractDataMap(v)
	if data == nil || data["livestream_id"] == nil {
		return ""
	}
	return fmt.Sprint(data["livestream_id"])
}

func (a *App) cachedBytes(key string) ([]byte, bool) {
	v, ok := a.cache.Get(key)
	if !ok {
		return nil, false
	}
	b, ok := v.([]byte)
	return b, ok
}

func (a *App) cachedRecording(key string) (dvrRecording, bool) {
	v, ok := a.cache.Get(key)
	if !ok {
		return dvrRecording{}, false
	}
	rec, ok := v.(dvrRecording)
	return rec, ok
}

// etagMatches reports whether an If-None-Match header covers etag, tolerating the
// weak prefix and the suffix compressing proxies add.
func etagMatches(header, etag string) bool {
	if header == "" || etag == "" {
		return false
	}
	want := normalizeETag(etag)
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || normalizeETag(candidate) == want {
			return true
		}
	}
	return false
}

func normalizeETag(tag string) string {
	tag = strings.TrimPrefix(strings.TrimSpace(tag), "W/")
	tag = strings.Trim(tag, `"`)
	// gzhttp marks compressed variants so caches don't mix encodings.
	return strings.TrimSuffix(tag, "-gzip")
}

func writeM3U8(w http.ResponseWriter, body []byte) {
	h := w.Header()
	h.Set("Content-Type", "application/vnd.apple.mpegurl")
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Cache-Control", "no-cache, no-store, must-revalidate")
	_, _ = w.Write(body)
}
