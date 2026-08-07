package httpapi

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/gzip"
	"kickapi/internal/transform"
)

// processed normalises a raw /videos payload the way the handlers do, so the
// selection tests operate on the same shape as production.
func processed(raw any) []map[string]any { return transform.ProcessVODData(raw) }

const dvrBase = "https://stream.kick.com/3c81249a/ivs/v1/196233775518/z6E52tVNkNXb/2026/7/27/8/59/97yQLSUMaNsm/media/hls/"

func kickTime(t time.Time) string     { return t.UTC().Format("2006-01-02 15:04:05") }
func tdtgStamp(t time.Time) string    { return t.UTC().Format("2006-01-02T15:04:05") }
func vodSource(base string) string    { return base + "master.m3u8" }
func recordingMaster() []byte         { return []byte(dvrMasterBody) }
func recordingMedia(s string) []byte  { return []byte(strings.ReplaceAll(dvrMediaBody, "{TDTG}", s)) }
func inProgressVOD(now time.Time) any { return dvrVODList(now, 0, vodSource(dvrBase)) }

const dvrMasterBody = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=3483143,RESOLUTION=1280x720,VIDEO="720p60"
720p60/playlist.m3u8
`

const dvrMediaBody = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:13
#ID3-EQUIV-TDTG:{TDTG}
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:12.500,
0.ts
#EXTINF:12.500,
1.ts
#EXT-X-ENDLIST
`

// dvrVODList builds a one-entry raw /videos payload (the shape ProcessVODData
// consumes) with the given duration in milliseconds and source URL.
func dvrVODList(createdAt time.Time, durationMS float64, source string) any {
	return []any{map[string]any{
		"id":            float64(119352180),
		"session_title": "Live now",
		"source":        source,
		"duration":      durationMS,
		"created_at":    kickTime(createdAt),
		"video":         map[string]any{"uuid": "4ae9baa1", "views": float64(2)},
		"thumbnail":     map[string]any{"src": "thumb.webp"},
	}}
}

func dvrApp(t *testing.T, videos any, playlists map[string][]byte) *App {
	t.Helper()
	return appWithKick(t, &fakeKick{videos: videos, playlists: playlists})
}

func getRaw(t *testing.T, app *App, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func getRawWithHeader(t *testing.T, app *App, path, header, value string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set(header, value)
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, req)
	return rec
}

// expireFreshMarker makes a cached recording count as due for a refresh, the way
// it would once its target duration had elapsed.
func expireFreshMarker(app *App, base string) {
	_, freshKey := dvrRecordingKeys(base)
	app.cache.SetTTL(freshKey, true, 0)
}

// ── source selection ────────────────────────────────────────────────────────

func TestPickInProgressRecording(t *testing.T) {
	now := time.Date(2026, 7, 27, 15, 0, 0, 0, time.UTC)
	recent := now.Add(-2 * time.Hour)

	older := dvrBase
	newer := "https://stream.kick.com/3c81249a/ivs/v1/1/CID/2026/7/27/14/0/NEWREC/media/hls/"

	tests := []struct {
		name string
		vods []map[string]any
		want string // expected base URL, "" for none
	}{
		{
			name: "in-progress recording is picked",
			vods: processed(dvrVODList(recent, 0, vodSource(dvrBase))),
			want: dvrBase,
		},
		{
			name: "finished recordings are ignored",
			vods: processed(dvrVODList(recent, 21637500, vodSource(dvrBase))),
			want: "",
		},
		{
			name: "newest in-progress recording wins",
			vods: append(
				processed(dvrVODList(recent, 0, vodSource(older))),
				processed(dvrVODList(now.Add(-1*time.Hour), 0, vodSource(newer)))...,
			),
			want: newer,
		},
		{
			name: "recording on another host is rejected",
			vods: processed(dvrVODList(recent, 0, "https://evil.example/ivs/v1/x/media/hls/master.m3u8")),
			want: "",
		},
		{
			name: "non-recording URL is rejected",
			vods: processed(dvrVODList(recent, 0, "https://stream.kick.com/../../etc/passwd")),
			want: "",
		},
		{
			name: "stale recording is not treated as the current broadcast",
			vods: processed(dvrVODList(now.Add(-72*time.Hour), 0, vodSource(dvrBase))),
			want: "",
		},
		{
			name: "recording far in the future is rejected",
			vods: processed(dvrVODList(now.Add(2*time.Hour), 0, vodSource(dvrBase))),
			want: "",
		},
		{
			name: "empty list yields no source",
			vods: nil,
			want: "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := pickInProgressRecording(tc.vods, now)
			if got.BaseURL != tc.want {
				t.Fatalf("BaseURL = %q; want %q", got.BaseURL, tc.want)
			}
			if got.ok() != (tc.want != "") {
				t.Fatalf("ok() = %v; want %v", got.ok(), tc.want != "")
			}
		})
	}
}

// The DVR source comes out of the same payload /streams/vods serves, so a warm
// VOD cache must satisfy it without a second upstream fetch.
func TestDVRSourceReusesCachedVODList(t *testing.T) {
	app := appWithKick(t, &fakeKick{}) // no upstream videos payload at all
	app.cachePut("vods:/streams/vods/cavs", envelopeMap("success", "", map[string]any{
		"vods": processed(inProgressVOD(time.Now().UTC())),
	}), 200, time.Minute)

	src, apiErr := app.dvrSource("cavs")
	if apiErr != nil || src.BaseURL != dvrBase {
		t.Fatalf("source = %q (err=%v); want %q resolved from the VOD cache", src.BaseURL, apiErr, dvrBase)
	}
}

// Opening a live channel must resolve its rewind window in the background:
// without that, playback races the lookup and falls back to the live edge's ~30s
// timeline purely on timing.
func TestPlayStreamWarmsDVRSource(t *testing.T) {
	fake := &fakeKick{
		channel: map[string]any{
			"user":         map[string]any{"username": "Cavs"},
			"playback_url": "https://ivs/playlist.m3u8",
			"livestream": map[string]any{
				"id": float64(42), "session_title": "Hi", "viewer_count": float64(99),
			},
		},
		videos: inProgressVOD(time.Now().UTC()),
	}
	app := appWithKick(t, fake)

	if code, _ := getJSON(t, app, "/streams/play/cavs"); code != http.StatusOK {
		t.Fatalf("play status = %d", code)
	}

	key := "dvr-src:cavs:" + app.liveSessionID("cavs")
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if v, ok := app.cache.Get(key); ok {
			if src, _ := v.(dvrSource); src.BaseURL == dvrBase {
				return
			}
			t.Fatalf("warmed source = %#v; want base %q", v, dvrBase)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("DVR source was not warmed (cache key %q still empty)", key)
}

// A resolved recording is cached for the broadcast; "not recorded" must not be,
// or a stream Kick starts recording a minute in would stay unrewindable.
func TestDVRSourceCachesPositiveResultsOnly(t *testing.T) {
	fake := &fakeKick{videos: inProgressVOD(time.Now().UTC())}
	app := appWithKick(t, fake)

	if src, _ := app.dvrSource("cavs"); !src.ok() {
		t.Fatal("expected a resolved recording")
	}
	if _, _ = app.dvrSource("cavs"); fake.videoCalls.Load() != 1 {
		t.Fatalf("resolved recording was looked up %d times; want it reused from cache", fake.videoCalls.Load())
	}

	// A channel with nothing in progress, whose negative result expires at once.
	absent := &fakeKick{videos: dvrVODList(time.Now().UTC(), 21637500, vodSource(dvrBase))}
	app2 := appWithKick(t, absent)
	app2.cfg.NegativeCacheDurationSeconds = 0

	if src, _ := app2.dvrSource("other"); src.ok() {
		t.Fatal("expected no recording")
	}
	if _, _ = app2.dvrSource("other"); absent.videoCalls.Load() < 2 {
		t.Fatalf("negative result was sticky: %d lookups; want it re-checked", absent.videoCalls.Load())
	}
}

// ── ENDLIST handling ────────────────────────────────────────────────────────

func TestDVRRecordingGrowing(t *testing.T) {
	now := time.Date(2026, 7, 27, 15, 0, 0, 0, time.UTC)

	tests := []struct {
		name          string
		body          string
		growing, know bool
	}{
		{"fresh stamp is growing", "#ID3-EQUIV-TDTG:" + tdtgStamp(now.Add(-20*time.Second)), true, true},
		{"stale stamp is finished", "#ID3-EQUIV-TDTG:" + tdtgStamp(now.Add(-10*time.Minute)), false, true},
		{"missing stamp is unknown", "#EXTM3U\n#EXT-X-ENDLIST", false, false},
		{"unparseable stamp is unknown", "#ID3-EQUIV-TDTG:not-a-time", false, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			growing, known := dvrRecordingGrowing([]byte(tc.body), now)
			if growing != tc.growing || known != tc.know {
				t.Fatalf("got (growing=%v, known=%v); want (%v, %v)", growing, known, tc.growing, tc.know)
			}
		})
	}
}

func TestDVRMediaStripsEndlistWhileRecording(t *testing.T) {
	now := time.Now().UTC()
	app := dvrApp(t, inProgressVOD(now), map[string][]byte{
		dvrBase + "720p60/playlist.m3u8": recordingMedia(tdtgStamp(now)),
	})

	rec := getRaw(t, app, "/streams/dvr/cavs/720p60/playlist.m3u8")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, "#EXT-X-ENDLIST") {
		t.Fatal("ENDLIST retained for a still-growing recording: players would stop at the load-time duration")
	}
	// Growth relies on the client polling, which needs the playlist to stay live.
	if !strings.Contains(body, "#EXT-X-PLAYLIST-TYPE:EVENT") {
		t.Fatal("EVENT playlist type dropped")
	}
	if !strings.Contains(body, dvrBase+"720p60/0.ts") {
		t.Fatalf("segment URIs not absolutized:\n%s", body)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/vnd.apple.mpegurl" {
		t.Fatalf("Content-Type = %q", ct)
	}
}

func TestDVRMediaKeepsEndlistWhenRecordingFinished(t *testing.T) {
	now := time.Now().UTC()
	app := dvrApp(t, inProgressVOD(now), map[string][]byte{
		dvrBase + "720p60/playlist.m3u8": recordingMedia(tdtgStamp(now.Add(-30 * time.Minute))),
	})

	rec := getRaw(t, app, "/streams/dvr/cavs/720p60/playlist.m3u8")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "#EXT-X-ENDLIST") {
		t.Fatal("ENDLIST stripped from a finished recording: players would wait forever for segments")
	}
}

func TestDVRMediaWithoutStampFallsBackToLiveStatus(t *testing.T) {
	now := time.Now().UTC()
	noStamp := []byte(strings.ReplaceAll(dvrMediaBody, "#ID3-EQUIV-TDTG:{TDTG}\n", ""))
	playlists := map[string][]byte{dvrBase + "720p60/playlist.m3u8": noStamp}
	const path = "/streams/dvr/cavs/720p60/playlist.m3u8"

	// Offline (nothing cached) → the recording is treated as complete.
	offline := dvrApp(t, inProgressVOD(now), playlists)
	if body := getRaw(t, offline, path).Body.String(); !strings.Contains(body, "#EXT-X-ENDLIST") {
		t.Fatal("ENDLIST stripped with no stamp and no live status")
	}

	// Live per the /play cache → keep the DVR window growing.
	live := dvrApp(t, inProgressVOD(now), playlists)
	live.cachePut("live:/streams/play/cavs", envelopeMap("success", "", map[string]any{"status": "live"}), 200, time.Minute)
	if body := getRaw(t, live, path).Body.String(); strings.Contains(body, "#EXT-X-ENDLIST") {
		t.Fatal("ENDLIST retained for a live channel with no stamp")
	}
}

// A streamer who ends a broadcast and starts another must not keep being served
// the finished broadcast's recording for the rest of the source cache TTL.
func TestDVRSourceFollowsNewBroadcast(t *testing.T) {
	now := time.Now().UTC()
	secondBase := "https://stream.kick.com/3c81249a/ivs/v1/1/CID/2026/7/27/15/30/SECONDREC/media/hls/"

	fake := &fakeKick{videos: inProgressVOD(now)}
	app := appWithKick(t, fake)
	setLiveSession := func(id float64) {
		app.cachePut("live:/streams/play/cavs", envelopeMap("success", "", map[string]any{
			"status": "live", "livestream_id": id,
		}), 200, time.Minute)
	}

	setLiveSession(1)
	first, apiErr := app.dvrSource("cavs")
	if apiErr != nil || first.BaseURL != dvrBase {
		t.Fatalf("first broadcast source = %q (err=%v); want %q", first.BaseURL, apiErr, dvrBase)
	}

	fake.videos = dvrVODList(now, 0, vodSource(secondBase))
	setLiveSession(2)
	second, apiErr := app.dvrSource("cavs")
	if apiErr != nil || second.BaseURL != secondBase {
		t.Fatalf("second broadcast source = %q (err=%v); want %q", second.BaseURL, apiErr, secondBase)
	}
}

// ── rewriting: fast path must match the general one ─────────────────────────

// referenceRewrite is the straightforward implementation the fast path replaced:
// resolve every reference as a URL, then drop ENDLIST. The optimised version must
// stay byte-for-byte equivalent to it.
func referenceRewrite(playlistURL string, body []byte, growing bool) []byte {
	body = absolutizeHLSReferences(playlistURL, body)
	if !growing {
		return body
	}
	lines := strings.Split(string(body), "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) == "#EXT-X-ENDLIST" {
			continue
		}
		kept = append(kept, line)
	}
	return []byte(strings.Join(kept, "\n"))
}

func TestRewriteDVRPlaylistMatchesReference(t *testing.T) {
	playlistURL := dvrBase + "720p60/playlist.m3u8"

	playlists := map[string]string{
		"relative segments":   dvrMediaBody,
		"already absolute":    "#EXTM3U\n#EXTINF:12.5,\n" + dvrBase + "720p60/9.ts\n#EXT-X-ENDLIST\n",
		"root relative":       "#EXTM3U\n#EXTINF:12.5,\n/other/path/9.ts\n",
		"query string":        "#EXTM3U\n#EXTINF:12.5,\n9.ts?dna=abc\n",
		"uri attribute":       "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:12.5,\n9.m4s\n",
		"byteranges":          "#EXTM3U\n#EXT-X-BYTERANGE:1000@0\n#EXTINF:12.5,\n9.ts\n",
		"blank lines":         "#EXTM3U\n\n#EXTINF:12.5,\n9.ts\n\n",
		"no trailing newline": "#EXTM3U\n#EXTINF:12.5,\n9.ts",
	}

	for name, body := range playlists {
		for _, growing := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/growing=%v", name, growing), func(t *testing.T) {
				stamped := strings.ReplaceAll(body, "{TDTG}", tdtgStamp(time.Now().UTC()))
				got := rewriteDVRPlaylist(playlistURL, []byte(stamped), growing)
				want := referenceRewrite(playlistURL, []byte(stamped), growing)
				if !bytes.Equal(got, want) {
					t.Fatalf("fast path diverged\n got: %q\nwant: %q", got, want)
				}
			})
		}
	}
}

// CRLF is deliberately not compared against the reference implementation: that
// one resolves each segment line as a URL, which drops the CR from the lines it
// rewrites and leaves it on the lines it doesn't. Both are valid HLS, but
// preserving the file's own line endings is the better behaviour.
func TestRewriteDVRPlaylistPreservesCRLF(t *testing.T) {
	body := []byte("#EXTM3U\r\n#EXTINF:12.5,\r\n9.ts\r\n#EXT-X-ENDLIST\r\n")

	got := string(rewriteDVRPlaylist(dvrBase+"720p60/playlist.m3u8", body, true))
	want := "#EXTM3U\r\n#EXTINF:12.5,\r\n" + dvrBase + "720p60/9.ts\r\n"
	if got != want {
		t.Fatalf("got %q; want %q", got, want)
	}
}

func TestETagMatches(t *testing.T) {
	tests := []struct {
		header, etag string
		want         bool
	}{
		{`"abc"`, `"abc"`, true},
		{`W/"abc"`, `"abc"`, true},
		{`"abc-gzip"`, `"abc"`, true}, // compressing proxies mark the encoding
		{`"xyz", "abc"`, `"abc"`, true},
		{`*`, `"abc"`, true},
		{`"xyz"`, `"abc"`, false},
		{``, `"abc"`, false},
		{`"abc"`, ``, false},
	}
	for _, tc := range tests {
		if got := etagMatches(tc.header, tc.etag); got != tc.want {
			t.Errorf("etagMatches(%q, %q) = %v; want %v", tc.header, tc.etag, got, tc.want)
		}
	}
}

// ── caching behaviour ───────────────────────────────────────────────────────

func TestDVRPlaylistServedFromCache(t *testing.T) {
	now := time.Now().UTC()
	fake := &fakeKick{videos: inProgressVOD(now), playlists: map[string][]byte{
		dvrBase + "720p60/playlist.m3u8": recordingMedia(tdtgStamp(now)),
	}}
	app := appWithKick(t, fake)
	const path = "/streams/dvr/cavs/720p60/playlist.m3u8"

	if rec := getRaw(t, app, path); rec.Code != http.StatusOK {
		t.Fatalf("first request status = %d", rec.Code)
	}
	before := fake.playlistFetches()

	// Players refresh this every few seconds; while the copy is fresh those must
	// not reach upstream at all.
	for i := 0; i < 5; i++ {
		if rec := getRaw(t, app, path); rec.Code != http.StatusOK || rec.Body.Len() == 0 {
			t.Fatalf("refresh %d: status = %d, %d bytes", i, rec.Code, rec.Body.Len())
		}
	}
	if got := fake.playlistFetches(); got != before {
		t.Fatalf("fresh refreshes hit upstream %d extra times; want 0", got-before)
	}
}

func TestDVRPlaylistServesStaleWhileRefreshing(t *testing.T) {
	now := time.Now().UTC()
	fake := &fakeKick{videos: inProgressVOD(now), playlists: map[string][]byte{
		dvrBase + "720p60/playlist.m3u8": recordingMedia(tdtgStamp(now)),
	}}
	app := appWithKick(t, fake)
	const path = "/streams/dvr/cavs/720p60/playlist.m3u8"

	getRaw(t, app, path)
	// Due for a refresh, as it would be once its target duration had elapsed.
	expireFreshMarker(app, dvrBase)
	before := fake.playlistFetches()

	// A refreshing player (it carries a validator) must be answered from the
	// cached copy with a refresh behind it, rather than waiting on the upstream.
	// The validator deliberately doesn't match, so the body comes back too.
	rec := getRawWithHeader(t, app, path, "If-None-Match", `"an-older-copy"`)
	if rec.Code != http.StatusOK || rec.Body.Len() == 0 {
		t.Fatalf("stale request status = %d, %d bytes; want a cached playlist", rec.Code, rec.Body.Len())
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if fake.playlistFetches() > before {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("stale hit did not trigger a background refresh")
}

// A player loading a playlist for the first time reads the live edge off it to
// choose a start position. With nothing keeping the recording warm, it must not be
// handed a stale copy — that would show up as startup latency behind the broadcast.
func TestDVRFirstLoadFetchesWhenNothingKeepsItWarm(t *testing.T) {
	now := time.Now().UTC()
	fake := &fakeKick{videos: inProgressVOD(now), playlists: map[string][]byte{
		dvrBase + "720p60/playlist.m3u8": recordingMedia(tdtgStamp(now)),
	}}
	app := appWithKick(t, fake)

	if _, err := app.dvrRecordingFor("cavs", dvrBase, "720p60", false); err != nil {
		t.Fatalf("initial load: %v", err)
	}
	expireFreshMarker(app, dvrBase)
	before := fake.playlistFetches()

	if _, err := app.dvrRecordingFor("cavs", dvrBase, "720p60", false); err != nil {
		t.Fatalf("second load: %v", err)
	}
	if got := fake.playlistFetches(); got <= before {
		t.Fatal("a stale copy was served with nothing keeping it warm; the player would start behind the live edge")
	}
}

// Once a keeper is refreshing on a timer the cached copy is recent by
// construction, so a player's first look at a freshly switched rendition is served
// from memory instead of waiting on an upstream fetch.
func TestDVRKeeperLetsFirstLoadSkipTheUpstream(t *testing.T) {
	now := time.Now().UTC()
	fake := &fakeKick{videos: inProgressVOD(now), playlists: map[string][]byte{
		dvrBase + "720p60/playlist.m3u8": recordingMedia(tdtgStamp(now)),
	}}
	app := appWithKick(t, fake)

	if _, err := app.dvrRecordingFor("cavs", dvrBase, "720p60", false); err != nil {
		t.Fatalf("initial load: %v", err)
	}
	expireFreshMarker(app, dvrBase)
	app.dvrKeepers[dvrBase] = struct{}{} // as the request path would have
	before := fake.playlistFetches()

	if _, err := app.dvrRecordingFor("cavs", dvrBase, "480p30", false); err != nil {
		t.Fatalf("rendition switch: %v", err)
	}
	if got := fake.playlistFetches(); got != before {
		t.Fatalf("rendition switch cost %d upstream fetch(es) despite a keeper; want 0", got-before)
	}
}

func TestDVRKeeperStopsWhenNobodyIsWatching(t *testing.T) {
	now := time.Now().UTC()
	media := map[string][]byte{dvrBase + "720p60/playlist.m3u8": recordingMedia(tdtgStamp(now))}

	watchedApp := appWithKick(t, &fakeKick{videos: inProgressVOD(now), playlists: media})
	watchedApp.cache.SetTTL("dvr-watch:"+dvrBase, true, time.Minute)
	watched, err := watchedApp.refreshWatchedRecording("cavs", dvrBase, "720p60")
	if err != nil || !watched {
		t.Fatalf("watched recording: (watched=%v, err=%v); want it refreshed", watched, err)
	}

	// Nothing has requested it inside the idle window: the keeper must stop rather
	// than refresh an abandoned broadcast forever.
	idleFake := &fakeKick{videos: inProgressVOD(now), playlists: media}
	idleApp := appWithKick(t, idleFake)
	if watched, _ := idleApp.refreshWatchedRecording("cavs", dvrBase, "720p60"); watched {
		t.Fatal("keeper kept going with nobody watching")
	}
	if idleFake.playlistFetches() != 0 {
		t.Fatalf("abandoned recording still fetched %d time(s)", idleFake.playlistFetches())
	}
}

// A player switching rendition asks for a playlist it has never requested before.
// HLS requires renditions to share segment boundaries, so the recording already in
// memory describes all of them — the switch must not cost an upstream fetch.
func TestDVRPlaylistSharesOneFetchAcrossVariants(t *testing.T) {
	now := time.Now().UTC()
	media := recordingMedia(tdtgStamp(now))
	fake := &fakeKick{videos: inProgressVOD(now), playlists: map[string][]byte{
		dvrBase + "720p60/playlist.m3u8": media,
		dvrBase + "360p30/playlist.m3u8": media,
	}}
	app := appWithKick(t, fake)

	first := getRaw(t, app, "/streams/dvr/cavs/720p60/playlist.m3u8")
	if !strings.Contains(first.Body.String(), dvrBase+"720p60/0.ts") {
		t.Fatalf("720p60 segments not resolved:\n%s", first.Body.String())
	}
	fetches := fake.playlistFetches()

	second := getRaw(t, app, "/streams/dvr/cavs/360p30/playlist.m3u8")
	if got := fake.playlistFetches(); got != fetches {
		t.Fatalf("switching rendition cost %d extra upstream fetch(es); want 0", got-fetches)
	}
	body := second.Body.String()
	if !strings.Contains(body, dvrBase+"360p30/0.ts") {
		t.Fatalf("360p30 segments not resolved against their own directory:\n%s", body)
	}
	if strings.Contains(body, "720p60/") {
		t.Fatal("360p30 playlist points at 720p60 segments")
	}
	// Distinct validators, or a player would 304 its way into the wrong rendition.
	if e1, e2 := first.Header().Get("ETag"), second.Header().Get("ETag"); e1 == e2 || e1 == "" {
		t.Fatalf("renditions share the validator %q", e1)
	}
}

func TestDVRPlaylistRevalidatesWithETag(t *testing.T) {
	now := time.Now().UTC()
	app := dvrApp(t, inProgressVOD(now), map[string][]byte{
		dvrBase + "720p60/playlist.m3u8": recordingMedia(tdtgStamp(now)),
	})
	const path = "/streams/dvr/cavs/720p60/playlist.m3u8"

	first := getRaw(t, app, path)
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("no ETag: every refresh would re-send the whole playlist")
	}
	if cc := first.Header().Get("Cache-Control"); strings.Contains(cc, "no-store") {
		t.Fatalf("Cache-Control = %q; no-store prevents the revalidation that makes 304s possible", cc)
	}

	revalidated := getRawWithHeader(t, app, path, "If-None-Match", etag)
	if revalidated.Code != http.StatusNotModified {
		t.Fatalf("status = %d; want 304 for an unchanged playlist", revalidated.Code)
	}
	if revalidated.Body.Len() != 0 {
		t.Fatalf("304 carried %d bytes of body", revalidated.Body.Len())
	}

	stale := getRawWithHeader(t, app, path, "If-None-Match", `"something-else"`)
	if stale.Code != http.StatusOK || stale.Body.Len() == 0 {
		t.Fatalf("mismatched validator: status = %d, %d bytes; want the playlist", stale.Code, stale.Body.Len())
	}
}

func TestDVRFirstVariant(t *testing.T) {
	if got := dvrFirstVariant(recordingMaster()); got != "720p60" {
		t.Fatalf("variant = %q; want 720p60", got)
	}
	if got := dvrFirstVariant([]byte("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://elsewhere/x.m3u8\n")); got != "" {
		t.Fatalf("absolute variant URI accepted as a rendition name: %q", got)
	}
	if got := dvrFirstVariant([]byte("#EXTM3U\n../escape/playlist.m3u8\n")); got != "" {
		t.Fatalf("traversal accepted as a rendition name: %q", got)
	}
}

// Opening a live channel must leave the player's next two requests already in
// cache. Cold they are serial upstream fetches on the path to first frame — 1607ms
// for the master and 1270ms for the media playlist when this was measured.
func TestPlayStreamWarmsPlaylistsNotJustTheSource(t *testing.T) {
	now := time.Now().UTC()
	fake := &fakeKick{
		channel: map[string]any{
			"user":         map[string]any{"username": "Cavs"},
			"playback_url": "https://ivs/playlist.m3u8",
			"livestream":   map[string]any{"id": float64(42), "session_title": "Hi"},
		},
		videos: inProgressVOD(now),
		playlists: map[string][]byte{
			vodSource(dvrBase):               recordingMaster(),
			dvrBase + "720p60/playlist.m3u8": recordingMedia(tdtgStamp(now)),
		},
	}
	app := appWithKick(t, fake)

	if code, _ := getJSON(t, app, "/streams/play/cavs"); code != http.StatusOK {
		t.Fatalf("play status = %d", code)
	}

	// The warm runs in the background; give it a bounded window to land.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		_, master := app.cachedBytes("dvr-master:" + dvrBase)
		staleKey, _ := dvrRecordingKeys(dvrBase)
		_, playlist := app.cachedRecording(staleKey)
		if master && playlist {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("opening a live channel left the master or media playlist cold; first frame would wait on both")
}

// ── metadata driving the timings ────────────────────────────────────────────

func TestDVRPlaylistMetadata(t *testing.T) {
	body := recordingMedia(tdtgStamp(time.Date(2026, 7, 27, 15, 0, 41, 0, time.UTC)))

	if stamp, ok := dvrPlaylistStamp(body); !ok || stamp != "2026-07-27T15:00:41" {
		t.Fatalf("stamp = %q (ok=%v)", stamp, ok)
	}
	if got := dvrTargetDuration(body); got != 13*time.Second {
		t.Fatalf("target duration = %v; want 13s", got)
	}
	if got := dvrTargetDuration([]byte("#EXTM3U\n")); got != 0 {
		t.Fatalf("missing target duration = %v; want 0", got)
	}
}

func TestDVRRefreshIntervalFollowsTargetDuration(t *testing.T) {
	app := appWithKick(t, &fakeKick{})
	app.cfg.DVRPlaylistCacheDurationSeconds = 5

	tests := []struct {
		name string
		rec  dvrRecording
		want time.Duration
	}{
		{"from the playlist", dvrRecording{target: 13 * time.Second}, 13 * time.Second},
		{"configured fallback when undeclared", dvrRecording{}, 5 * time.Second},
		{"floored", dvrRecording{target: time.Second}, dvrMinRefreshInterval},
		{"capped", dvrRecording{target: 10 * time.Minute}, dvrMaxRefreshInterval},
	}
	for _, tc := range tests {
		if got := app.dvrRefreshInterval(tc.rec); got != tc.want {
			t.Errorf("%s: interval = %v; want %v", tc.name, got, tc.want)
		}
	}
}

// The validator has to move when the recording grows and hold still when it
// doesn't — it is what lets an unchanged refresh cost a 304.
func TestDVRVersionTracksRecordingChanges(t *testing.T) {
	stamp := tdtgStamp(time.Now().UTC())
	base := dvrRecording{stamp: stamp, segments: 1600}

	if base.version() != (dvrRecording{stamp: stamp, segments: 1600}).version() {
		t.Fatal("version changed without the recording changing")
	}
	grown := dvrRecording{stamp: tdtgStamp(time.Now().UTC().Add(13 * time.Second)), segments: 1601}
	if base.version() == grown.version() {
		t.Fatal("version unchanged after the recording grew")
	}
	// With no stamp to trust it must still distinguish different contents.
	a := dvrRecording{body: []byte("#EXTM3U\n0.ts\n")}
	b := dvrRecording{body: []byte("#EXTM3U\n0.ts\n1.ts\n")}
	if a.version() == b.version() {
		t.Fatal("unstamped recordings with different contents share a version")
	}
}

func TestAcceptsGzip(t *testing.T) {
	tests := []struct {
		header string
		want   bool
	}{
		{"gzip", true},
		{"gzip, deflate, br", true},
		{"br, gzip;q=0.8", true},
		{"gzip;q=0", false},
		{"identity", false},
		{"", false},
	}
	for _, tc := range tests {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		if tc.header != "" {
			r.Header.Set("Accept-Encoding", tc.header)
		}
		if got := acceptsGzip(r); got != tc.want {
			t.Errorf("acceptsGzip(%q) = %v; want %v", tc.header, got, tc.want)
		}
	}
}

// The playlist is compressed once per change rather than per request, so the
// response carries an encoding the middleware must leave alone — a second pass
// would produce a body no client could read.
func TestDVRPlaylistServesPreCompressedBody(t *testing.T) {
	now := time.Now().UTC()
	app := dvrApp(t, inProgressVOD(now), map[string][]byte{
		dvrBase + "720p60/playlist.m3u8": recordingMedia(tdtgStamp(now)),
	})
	const path = "/streams/dvr/cavs/720p60/playlist.m3u8"

	rec := getRawWithHeader(t, app, path, "Accept-Encoding", "gzip")
	if enc := rec.Header().Get("Content-Encoding"); enc != "gzip" {
		t.Fatalf("Content-Encoding = %q; want exactly gzip", enc)
	}
	zr, err := gzip.NewReader(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		t.Fatalf("body is not readable gzip (double-compressed?): %v", err)
	}
	plain, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("decompressing: %v", err)
	}
	if !bytes.Contains(plain, []byte(dvrBase+"720p60/0.ts")) {
		t.Fatalf("decompressed playlist missing absolutized segments:\n%s", plain)
	}
	if bytes.Contains(plain, []byte("#EXT-X-ENDLIST")) {
		t.Fatal("decompressed playlist still ends the stream")
	}

	// A client that can't take gzip still gets a usable playlist.
	plainRec := getRawWithHeader(t, app, path, "Accept-Encoding", "identity")
	if enc := plainRec.Header().Get("Content-Encoding"); enc != "" {
		t.Fatalf("Content-Encoding = %q for an identity request", enc)
	}
	if !strings.Contains(plainRec.Body.String(), dvrBase+"720p60/0.ts") {
		t.Fatalf("uncompressed playlist missing segments:\n%s", plainRec.Body.String())
	}
}

// ── routes ──────────────────────────────────────────────────────────────────

func TestDVRInfo(t *testing.T) {
	now := time.Now().UTC()
	app := dvrApp(t, inProgressVOD(now), nil)

	code, body := getJSON(t, app, "/streams/dvr/cavs")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	data, _ := body["data"].(map[string]any)
	if data["available"] != true {
		t.Fatalf("available = %v; want true (data=%v)", data["available"], data)
	}
	if data["playlist_url"] != "/streams/dvr/cavs/master.m3u8" {
		t.Fatalf("playlist_url = %v", data["playlist_url"])
	}
	if data["vod_id"] != float64(119352180) {
		t.Fatalf("vod_id = %v", data["vod_id"])
	}
}

func TestDVRInfoUnavailableIsNotAnError(t *testing.T) {
	// A finished recording only — nothing to rewind into.
	app := dvrApp(t, dvrVODList(time.Now().UTC().Add(-48*time.Hour), 21637500, vodSource(dvrBase)), nil)

	code, body := getJSON(t, app, "/streams/dvr/cavs")
	if code != http.StatusOK {
		t.Fatalf("status = %d; want 200", code)
	}
	data, _ := body["data"].(map[string]any)
	if data["available"] != false {
		t.Fatalf("available = %v; want false", data["available"])
	}
}

func TestDVRMasterProxiesRecordingMaster(t *testing.T) {
	now := time.Now().UTC()
	app := dvrApp(t, inProgressVOD(now), map[string][]byte{
		vodSource(dvrBase): recordingMaster(),
	})

	rec := getRaw(t, app, "/streams/dvr/cavs/master.m3u8")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	// Variant URIs must stay relative so they resolve back onto this proxy.
	if !strings.Contains(rec.Body.String(), "\n720p60/playlist.m3u8") {
		t.Fatalf("variant URI rewritten:\n%s", rec.Body.String())
	}
}

func TestDVRMediaRejectsInvalidVariant(t *testing.T) {
	app := dvrApp(t, inProgressVOD(time.Now().UTC()), nil)

	for _, variant := range []string{"..", "720p60.", "720P60", "a/b", strings.Repeat("x", 25)} {
		rec := getRaw(t, app, "/streams/dvr/cavs/"+variant+"/playlist.m3u8")
		if rec.Code == http.StatusOK {
			t.Fatalf("variant %q accepted; want rejection", variant)
		}
	}
}

func TestDVRRejectsInvalidSlug(t *testing.T) {
	app := dvrApp(t, inProgressVOD(time.Now().UTC()), nil)

	for _, path := range []string{
		"/streams/dvr/bad$slug",
		"/streams/dvr/bad$slug/master.m3u8",
		"/streams/dvr/bad$slug/720p60/playlist.m3u8",
	} {
		if rec := getRaw(t, app, path); rec.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d; want 400", path, rec.Code)
		}
	}
}

func TestDVRPlaylistUpstreamFailureIsBadGateway(t *testing.T) {
	app := appWithKick(t, &fakeKick{
		videos:      inProgressVOD(time.Now().UTC()),
		playlistErr: http.ErrHandlerTimeout,
	})
	if rec := getRaw(t, app, "/streams/dvr/cavs/720p60/playlist.m3u8"); rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d; want 502", rec.Code)
	}
}
