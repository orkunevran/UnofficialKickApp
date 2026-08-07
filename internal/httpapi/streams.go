package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"kickapi/internal/apierr"
	"kickapi/internal/breaker"
	"kickapi/internal/kick"
	"kickapi/internal/obs"
	"kickapi/internal/transform"
)

// featuredInflightWait is the default in-flight wait for featured (Python uses
// InflightTracker._WAIT_TIMEOUT = 15s for that endpoint).
const featuredInflightWait = 15 * time.Second

// kickClient is the subset of the Kick client the handlers use. The seam lets
// tests inject fakes without a live network.
type kickClient interface {
	GetChannelData(slug string) (map[string]any, error)
	GetChannelVideos(slug string) (any, error)
	GetChannelClips(slug string) (any, error)
	GetFeaturedLivestreams(language string, page int) (any, error)
	GetAllLivestreams(language string, page int, category, subcategory, subcategories, sort string, strict bool) (any, error)
	FetchPlaylist(playbackURL string) ([]byte, error)
	GetViewerCount(livestreamID int) (int, error)
	GetViewerCountsBatch(ids []int) (map[int]int, error)
	SearchChannelsTypesense(query string) ([]map[string]any, error)
	GetChatHistory(channelID int, startTime string) (any, error)
}

var (
	slugRe        = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,255}$`)
	subcategoryRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9 &.:_()\-]{0,99}$`)
)

func validateSlug(s string) bool { return slugRe.MatchString(s) }

// slug extracts and validates the {slug} path value, writing a 400 and
// returning ok=false when invalid.
func (a *App) slug(w http.ResponseWriter, r *http.Request) (string, bool) {
	s := r.PathValue("slug")
	if !validateSlug(s) {
		errorJSON(w, fmt.Sprintf("Invalid channel slug: '%s'.", s), 400)
		return "", false
	}
	return s, true
}

// writeAPIErr renders an *apierr.Error as the JSON error envelope.
func writeAPIErr(w http.ResponseWriter, e *apierr.Error) { errorJSON(w, e.Message, e.Status) }

// envelopeMap builds the {status, message, data} response body.
func envelopeMap(status, message string, data any) map[string]any {
	return map[string]any{"status": status, "message": message, "data": data}
}

func featuredCacheKey(prefix, language string, page int, category, subcategory, subcategories, sortParam string, strict bool) string {
	v := url.Values{}
	v.Set("language", language)
	v.Set("page", strconv.Itoa(page))
	if category != "" {
		v.Set("category", category)
	}
	if subcategory != "" {
		v.Set("subcategory", subcategory)
	}
	if subcategories != "" {
		v.Set("subcategories", subcategories)
	}
	if sortParam != "" {
		v.Set("sort", sortParam)
	}
	if strict {
		v.Set("strict", "true")
	}
	return prefix + ":/streams/featured-livestreams?" + v.Encode()
}

func (a *App) ttl(seconds int) time.Duration { return time.Duration(seconds) * time.Second }
func (a *App) ttlFloat(seconds float64) time.Duration {
	return time.Duration(seconds * float64(time.Second))
}

// kickCall wraps an upstream call with circuit-breaker gating, the upstream
// call/lane counters, and error→apierr mapping — porting _common.py kick_call.
func kickCall[T any](cb *breaker.Breaker, lane, safeValue string, fn func() (T, error)) (T, *apierr.Error) {
	var zero T
	if !cb.AllowRequest() {
		obs.IncLaneEvent(lane, "rejections")
		return zero, apierr.New("Service temporarily unavailable — upstream failures detected.", 503)
	}
	result, err := fn()
	obs.IncUpstream()
	if err != nil {
		cb.RecordFailure()
		obs.IncLaneEvent(lane, "failures")
		var he *kick.HTTPError
		if errors.As(err, &he) {
			return zero, apierr.FromUpstreamStatus(he.Status, safeValue)
		}
		return zero, apierr.Transport()
	}
	cb.RecordSuccess()
	return result, nil
}

// serveCached serves key from cache, or builds the envelope via build, caches it
// with ttl, and responds. The shared shape for the simple read endpoints.
func (a *App) serveCached(w http.ResponseWriter, key string, ttl time.Duration, build func() (map[string]any, *apierr.Error)) {
	if c, ok := a.cacheGet(key); ok {
		writeCached(w, c)
		return
	}
	payload, e := build()
	if e != nil {
		writeAPIErr(w, e)
		return
	}
	a.cachePut(key, payload, 200, ttl)
	writeCached(w, cachedResp{payload: payload, status: 200})
}

// serveStale serves a stale cache entry if present, triggering one background
// refresh when the fresh marker has expired (the stale-while-revalidate read
// path shared by /play and /featured). Returns true if it served a response.
func (a *App) serveStale(w http.ResponseWriter, staleKey, freshKey, cacheControl string, cb *breaker.Breaker, refresh func()) bool {
	stale, ok := a.cacheGet(staleKey)
	if !ok {
		return false
	}
	if cacheControl != "" {
		w.Header().Set("Cache-Control", cacheControl)
	}
	if _, fresh := a.cache.Get(freshKey); !fresh && a.inflight.ClaimInflight(staleKey) {
		if cb.State() == breaker.StateOpen {
			// Breaker open — don't burn DNS/TCP attempts; hold off refresh.
			a.cache.SetTTL(freshKey, true, a.ttl(a.cfg.RefreshBackoffSeconds))
			a.inflight.DedupSet(staleKey)
		} else {
			go refresh()
		}
	}
	writeCached(w, stale)
	return true
}

// ── /streams/play (stale-while-revalidate) ──────────────────────────────────

func (a *App) handlePlayStream(w http.ResponseWriter, r *http.Request) {
	slug, ok := a.slug(w, r)
	if !ok {
		return
	}
	staleKey := "live:/streams/play/" + slug
	freshKey := "live-fresh:/streams/play/" + slug

	if a.serveStale(w, staleKey, freshKey, "", a.cbCritical, func() {
		a.refreshPlayStream(staleKey, freshKey, slug)
	}) {
		// Warm on the serve, not only on the fetch: this response is usually a
		// cache hit (the featured lists prime it), and a viewer opening a channel
		// needs the rewind playlists either way.
		if a.channelIsLive(slug) {
			a.warmDVRSource(slug)
		}
		return
	}

	// Cold: wait for an in-flight fetch, or become the fetcher.
	if v, ok := a.inflight.DedupGet(a.cache, staleKey, a.ttlFloat(a.cfg.LiveInflightWaitTimeoutSeconds)); ok {
		if c, ok := v.(cachedResp); ok {
			writeCached(w, c)
			return
		}
	}
	defer a.inflight.DedupSet(staleKey)

	data, apiErr := kickCall(a.cbCritical, obs.LaneCritical, slug, func() (map[string]any, error) {
		return a.kick.GetChannelData(slug)
	})
	if apiErr != nil {
		if apiErr.Status == 404 {
			a.negativeCache(staleKey, freshKey, apiErr.Message)
		}
		writeAPIErr(w, apiErr)
		return
	}
	payload, perr := a.cachePlayResult(staleKey, freshKey, slug, data)
	if perr != nil {
		writeAPIErr(w, perr)
		return
	}
	writeCached(w, cachedResp{payload: payload, status: 200})
}

// refreshPlayStream revalidates the play cache in the background.
func (a *App) refreshPlayStream(staleKey, freshKey, slug string) {
	defer a.inflight.DedupSet(staleKey)
	if !a.refreshLimiter.tryAcquire(a.ttlFloat(a.cfg.BackgroundRefreshAcquireTimeoutSeconds)) {
		a.log.Info("skipping live refresh: refresh limiter saturated", "key", staleKey)
		return
	}
	defer a.refreshLimiter.release()

	data, apiErr := kickCall(a.cbCritical, obs.LaneCritical, slug, func() (map[string]any, error) {
		return a.kick.GetChannelData(slug)
	})
	if apiErr != nil {
		if apiErr.Status == 404 {
			a.negativeCache(staleKey, freshKey, apiErr.Message)
		} else {
			// Refresh cooldown so a down upstream isn't hammered every request.
			a.cache.SetTTL(freshKey, true, a.ttl(a.cfg.RefreshBackoffSeconds))
		}
		return
	}
	if _, perr := a.cachePlayResult(staleKey, freshKey, slug, data); perr != nil {
		a.cache.SetTTL(freshKey, true, a.ttl(a.cfg.RefreshBackoffSeconds))
	}
}

// cachePlayResult builds the play payload, caches stale+fresh+live-url, and
// returns the payload.
func (a *App) cachePlayResult(staleKey, freshKey, slug string, data map[string]any) (map[string]any, *apierr.Error) {
	if pb, ok := data["playback_url"].(string); ok && pb != "" {
		a.cache.SetTTL("live-url:"+slug, pb, a.ttl(a.cfg.LiveStaleTTLSeconds))
	}
	payload, perr := buildPlayStreamPayload(data, slug)
	if perr != nil {
		return nil, perr
	}
	a.cachePut(staleKey, payload, 200, a.ttl(a.cfg.LiveStaleTTLSeconds))
	a.cache.SetTTL(freshKey, true, a.ttl(a.cfg.LiveCacheDurationSeconds))
	// Opening a live channel is the signal that its rewind window is about to be
	// asked for; resolve it now so playback can start on the full timeline.
	if data, _ := payload["data"].(map[string]any); data != nil && data["status"] == "live" {
		a.warmDVRSource(slug)
	}
	return payload, nil
}

func (a *App) negativeCache(staleKey, freshKey, message string) {
	a.cachePut(staleKey, envelopeMap("error", message, map[string]any{}), 404, a.ttl(a.cfg.NegativeCacheDurationSeconds))
	a.cache.SetTTL(freshKey, true, a.ttl(a.cfg.NegativeCacheDurationSeconds))
}

// buildPlayStreamPayload ports _build_play_stream_payload (channel.py).
func buildPlayStreamPayload(data map[string]any, slug string) (map[string]any, *apierr.Error) {
	profile := transform.BuildChannelProfile(data, slug)

	ls, ok := data["livestream"].(map[string]any)
	if !ok || data["livestream"] == nil {
		profile["status"] = "offline"
		return envelopeMap("success", "", profile), nil
	}

	pb, _ := data["playback_url"].(string)
	if pb == "" {
		return nil, apierr.New("Live playback URL not found in API response.", 500)
	}

	var profilePic any
	if user, ok := data["user"].(map[string]any); ok {
		profilePic = user["profile_pic"]
	}
	profile["status"] = "live"
	profile["playback_url"] = "/streams/m3u8/" + slug + ".m3u8"
	profile["livestream_id"] = ls["id"]
	profile["livestream_thumbnail_url"] = transform.ExtractThumbnail(ls, profilePic)
	profile["livestream_title"] = ls["session_title"]
	profile["livestream_viewer_count"] = ls["viewer_count"]
	profile["livestream_category"] = transform.ExtractCategoryName(ls)
	return envelopeMap("success", "", profile), nil
}

// ── /streams/go ──────────────────────────────────────────────────────────────

func (a *App) handleGoToLive(w http.ResponseWriter, r *http.Request) {
	if slug, ok := a.slug(w, r); ok {
		http.Redirect(w, r, "/streams/m3u8/"+slug+".m3u8", http.StatusTemporaryRedirect)
	}
}

// ── /streams/m3u8 ────────────────────────────────────────────────────────────

func (a *App) handlePlayM3U8(w http.ResponseWriter, r *http.Request) {
	file := r.PathValue("file")
	slug := strings.TrimSuffix(file, ".m3u8")
	if slug == file || !validateSlug(slug) {
		errorJSON(w, fmt.Sprintf("Invalid channel slug: '%s'.", slug), 400)
		return
	}

	playbackURL := ""
	if v, ok := a.cache.Get("live-url:" + slug); ok {
		playbackURL, _ = v.(string)
	}
	if playbackURL == "" {
		data, apiErr := kickCall(a.cbCritical, obs.LaneCritical, slug, func() (map[string]any, error) {
			return a.kick.GetChannelData(slug)
		})
		if apiErr != nil {
			writeAPIErr(w, apiErr)
			return
		}
		if pb, ok := data["playback_url"].(string); ok && pb != "" {
			playbackURL = pb
			a.cache.SetTTL("live-url:"+slug, pb, a.ttl(a.cfg.LiveStaleTTLSeconds))
		}
	}
	if playbackURL == "" {
		errorJSON(w, fmt.Sprintf("Channel '%s' is offline or has no playback URL.", slug), 404)
		return
	}

	body, err := a.kick.FetchPlaylist(playbackURL)
	if err != nil {
		a.log.Error("failed to proxy master playlist", "slug", slug, "error", err)
		errorJSON(w, "Failed to load stream playlist.", 502)
		return
	}
	writeM3U8(w, body)
}

// ── /streams/avatar ──────────────────────────────────────────────────────────

func (a *App) handleAvatar(w http.ResponseWriter, r *http.Request) {
	slug, ok := a.slug(w, r)
	if !ok {
		return
	}
	key := "avatar:/streams/avatar/" + slug
	if c, ok := a.cacheGet(key); ok {
		writeCached(w, c)
		return
	}

	// Reuse the profile picture from a cached play response if present.
	if lv, ok := a.cache.Get("live:/streams/play/" + slug); ok {
		if data := extractDataMap(lv); data != nil {
			if _, present := data["profile_picture"]; present {
				payload := envelopeMap("success", "", map[string]any{"profile_picture": data["profile_picture"]})
				a.cachePut(key, payload, 200, a.ttl(a.cfg.AvatarCacheDurationSeconds))
				writeCached(w, cachedResp{payload: payload, status: 200})
				return
			}
		}
	}

	data, apiErr := kickCall(a.cbNonCritical, obs.LaneNonCritical, slug, func() (map[string]any, error) {
		return a.kick.GetChannelData(slug)
	})
	if apiErr != nil {
		writeAPIErr(w, apiErr)
		return
	}
	var pic any
	if user, ok := data["user"].(map[string]any); ok {
		pic = user["profile_pic"]
	}
	payload := envelopeMap("success", "", map[string]any{"profile_picture": pic})
	a.cachePut(key, payload, 200, a.ttl(a.cfg.AvatarCacheDurationSeconds))
	writeCached(w, cachedResp{payload: payload, status: 200})
}

// extractDataMap pulls the "data" map from a cached play response (cachedResp
// or a bare payload map).
func extractDataMap(v any) map[string]any {
	var payload map[string]any
	switch t := v.(type) {
	case cachedResp:
		payload = t.payload
	case map[string]any:
		payload = t
	}
	if payload == nil {
		return nil
	}
	d, _ := payload["data"].(map[string]any)
	return d
}

// ── /streams/clips & /streams/vods ───────────────────────────────────────────

func (a *App) handleClips(w http.ResponseWriter, r *http.Request) {
	slug, ok := a.slug(w, r)
	if !ok {
		return
	}
	a.serveCached(w, "clips:/streams/clips/"+slug, a.ttl(a.cfg.VODCacheDurationSeconds), func() (map[string]any, *apierr.Error) {
		raw, e := kickCall(a.cbNonCritical, obs.LaneNonCritical, slug, func() (any, error) {
			return a.kick.GetChannelClips(slug)
		})
		if e != nil {
			return nil, e
		}
		return envelopeMap("success", "", map[string]any{"clips": transform.NormalizeClipList(raw, slug)}), nil
	})
}

func (a *App) handlePlayClip(w http.ResponseWriter, r *http.Request) {
	slug, ok := a.slug(w, r)
	if !ok {
		return
	}
	clipID := r.PathValue("clipID")
	if !validateSlug(clipID) {
		errorJSON(w, "Invalid clip ID.", 400)
		return
	}

	raw, apiErr := kickCall(a.cbCritical, obs.LaneCritical, slug, func() (any, error) {
		return a.kick.GetChannelClips(slug)
	})
	if apiErr != nil {
		writeAPIErr(w, apiErr)
		return
	}

	manifestURL := ""
	for _, clip := range transform.NormalizeClipList(raw, slug) {
		if fmt.Sprint(clip["clip_id"]) != clipID {
			continue
		}
		manifestURL, _ = clip["clip_url"].(string)
		break
	}
	if manifestURL == "" {
		errorJSON(w, "Clip not found.", 404)
		return
	}

	body, err := a.kick.FetchPlaylist(manifestURL)
	if err != nil {
		a.log.Error("failed to proxy clip playlist", "slug", slug, "clip_id", clipID, "error", err)
		errorJSON(w, "Failed to load clip playlist.", 502)
		return
	}
	body = absolutizeHLSReferences(manifestURL, body)

	h := w.Header()
	h.Set("Content-Type", "application/vnd.apple.mpegurl")
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Cache-Control", "private, max-age=60")
	_, _ = w.Write(body)
}

func absolutizeHLSReferences(manifestURL string, body []byte) []byte {
	base, err := url.Parse(manifestURL)
	if err != nil {
		return body
	}

	lines := strings.Split(string(body), "\n")
	normalizeHLSByteRangeOrder(lines)
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if !strings.HasPrefix(trimmed, "#") {
			if ref, parseErr := url.Parse(trimmed); parseErr == nil {
				lines[i] = base.ResolveReference(ref).String()
			}
			continue
		}
		lines[i] = absolutizeHLSURIAttributes(base, line)
	}
	return []byte(strings.Join(lines, "\n"))
}

// Kick clip playlists sometimes place EXT-X-BYTERANGE immediately before
// EXTINF. RFC 8216 orders the segment duration first; normalising that pair
// keeps strict HLS clients (including hls.js) from rejecting otherwise valid
// clip media playlists.
func normalizeHLSByteRangeOrder(lines []string) {
	for i := 0; i+1 < len(lines); i++ {
		if strings.HasPrefix(strings.TrimSpace(lines[i]), "#EXT-X-BYTERANGE:") &&
			strings.HasPrefix(strings.TrimSpace(lines[i+1]), "#EXTINF:") {
			lines[i], lines[i+1] = lines[i+1], lines[i]
			i++
		}
	}
}

func absolutizeHLSURIAttributes(base *url.URL, line string) string {
	const marker = `URI="`
	searchFrom := 0
	for {
		start := strings.Index(line[searchFrom:], marker)
		if start < 0 {
			return line
		}
		start += searchFrom + len(marker)
		endOffset := strings.IndexByte(line[start:], '"')
		if endOffset < 0 {
			return line
		}
		end := start + endOffset
		ref, err := url.Parse(line[start:end])
		if err == nil {
			absolute := base.ResolveReference(ref).String()
			line = line[:start] + absolute + line[end:]
			searchFrom = start + len(absolute) + 1
		} else {
			searchFrom = end + 1
		}
	}
}

func (a *App) handleVODs(w http.ResponseWriter, r *http.Request) {
	slug, ok := a.slug(w, r)
	if !ok {
		return
	}
	a.serveCached(w, "vods:/streams/vods/"+slug, a.ttl(a.cfg.VODCacheDurationSeconds), func() (map[string]any, *apierr.Error) {
		raw, e := kickCall(a.cbNonCritical, obs.LaneNonCritical, slug, func() (any, error) {
			return a.kick.GetChannelVideos(slug)
		})
		if e != nil {
			return nil, e
		}
		return envelopeMap("success", "", map[string]any{"vods": transform.ProcessVODData(raw)}), nil
	})
}

func (a *App) handlePlayVOD(w http.ResponseWriter, r *http.Request) {
	slug, ok := a.slug(w, r)
	if !ok {
		return
	}
	vodID, err := strconv.Atoi(r.PathValue("vodID"))
	if err != nil || vodID < 0 || vodID > 2_147_483_647 {
		errorJSON(w, "Invalid VOD ID.", 400)
		return
	}
	raw, apiErr := kickCall(a.cbCritical, obs.LaneCritical, slug, func() (any, error) {
		return a.kick.GetChannelVideos(slug)
	})
	if apiErr != nil {
		writeAPIErr(w, apiErr)
		return
	}
	for _, v := range transform.ProcessVODData(raw) {
		if id, ok := v["vod_id"].(float64); ok && int(id) == vodID {
			if src, ok := v["source_url"].(string); ok && src != "" {
				http.Redirect(w, r, src, http.StatusTemporaryRedirect)
				return
			}
		}
	}
	errorJSON(w, "VOD not found.", 404)
}

// ── /streams/featured-livestreams (stale-while-revalidate) ───────────────────

func (a *App) handleFeatured(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	language := q.Get("language")
	if language == "" {
		language = "en"
	}
	if !a.isValidLanguage(language) {
		language = a.cfg.DefaultLanguageCode
	}
	page := 1
	if p, err := strconv.Atoi(q.Get("page")); err == nil && p > 1 {
		page = p
	}
	if page > 1000 {
		page = 1000
	}
	category := strings.TrimSpace(q.Get("category"))
	subcategory := strings.TrimSpace(q.Get("subcategory"))
	subcategories := strings.TrimSpace(q.Get("subcategories"))
	sortParam := strings.ToLower(strings.TrimSpace(q.Get("sort")))
	strict := strings.EqualFold(strings.TrimSpace(q.Get("strict")), "true")
	if category != "" && !subcategoryRe.MatchString(category) {
		category = ""
	}
	if subcategory != "" && !subcategoryRe.MatchString(subcategory) {
		subcategory = ""
	}
	if subcategories != "" && !subcategoryRe.MatchString(subcategories) {
		subcategories = ""
	}
	switch sortParam {
	case "", "asc", "desc", "featured":
	default:
		sortParam = ""
	}

	cacheControl := fmt.Sprintf("public, max-age=%d", a.cfg.FeaturedCacheDurationSeconds)
	staleKey := featuredCacheKey("featured-livestreams", language, page, category, subcategory, subcategories, sortParam, strict)
	freshKey := featuredCacheKey("featured-fresh", language, page, category, subcategory, subcategories, sortParam, strict)

	if a.serveStale(w, staleKey, freshKey, cacheControl, a.cbNonCritical, func() {
		a.refreshFeatured(staleKey, freshKey, language, page, category, subcategory, subcategories, sortParam, strict)
	}) {
		return
	}

	if v, ok := a.inflight.DedupGet(a.cache, staleKey, featuredInflightWait); ok {
		if c, ok := v.(cachedResp); ok {
			w.Header().Set("Cache-Control", cacheControl)
			writeCached(w, c)
			return
		}
	}
	defer a.inflight.DedupSet(staleKey)

	raw, apiErr := a.fetchFeatured(language, page, category, subcategory, subcategories, sortParam, strict)
	if apiErr != nil {
		writeAPIErr(w, apiErr)
		return
	}
	body := transform.BuildFeaturedResponse(raw, page)
	a.cachePut(staleKey, body, 200, a.ttl(a.cfg.FeaturedStaleTTLSeconds))
	a.cache.SetTTL(freshKey, true, a.ttl(a.cfg.FeaturedCacheDurationSeconds))
	a.warmCachesFromFeatured(dataList(body))
	w.Header().Set("Cache-Control", cacheControl)
	writeCached(w, cachedResp{payload: body, status: 200})
}

func (a *App) fetchFeatured(language string, page int, category, subcategory, subcategories, sortParam string, strict bool) (any, *apierr.Error) {
	filtered := category != "" || subcategory != "" || subcategories != ""
	return kickCall(a.cbNonCritical, obs.LaneNonCritical, language, func() (any, error) {
		if filtered {
			return a.kick.GetAllLivestreams(language, page, category, subcategory, subcategories, sortParam, strict)
		}
		return a.kick.GetFeaturedLivestreams(language, page)
	})
}

func (a *App) refreshFeatured(staleKey, freshKey, language string, page int, category, subcategory, subcategories, sortParam string, strict bool) {
	defer a.inflight.DedupSet(staleKey)
	if !a.refreshLimiter.tryAcquire(a.ttlFloat(a.cfg.BackgroundRefreshAcquireTimeoutSeconds)) {
		a.log.Info("skipping featured refresh: refresh limiter saturated", "key", staleKey)
		return
	}
	defer a.refreshLimiter.release()

	raw, apiErr := a.fetchFeatured(language, page, category, subcategory, subcategories, sortParam, strict)
	if apiErr != nil {
		a.cache.SetTTL(freshKey, true, a.ttl(a.cfg.RefreshBackoffSeconds))
		return
	}
	body := transform.BuildFeaturedResponse(raw, page)
	a.cachePut(staleKey, body, 200, a.ttl(a.cfg.FeaturedStaleTTLSeconds))
	a.cache.SetTTL(freshKey, true, a.ttl(a.cfg.FeaturedCacheDurationSeconds))
	a.warmCachesFromFeatured(dataList(body))
}

// sleepCtx sleeps for d, returning false if ctx is cancelled first.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	select {
	case <-time.After(d):
		return true
	case <-ctx.Done():
		return false
	}
}

// RunWarmup pre-populates the featured and avatar caches for every configured
// language shortly after startup, eliminating cold-start latency spikes. It
// runs as a background goroutine and exits when ctx is cancelled.
func (a *App) RunWarmup(ctx context.Context) {
	select {
	case <-time.After(2 * time.Second):
	case <-ctx.Done():
		return
	}
	for _, lang := range a.cfg.FeaturedLanguages {
		select {
		case <-ctx.Done():
			return
		default:
		}
		staleKey := featuredCacheKey("featured-livestreams", lang.Code, 1, "", "", "", "", false)
		if _, ok := a.cacheGet(staleKey); ok {
			continue
		}
		raw, apiErr := a.fetchFeatured(lang.Code, 1, "", "", "", "", false)
		if apiErr != nil {
			a.log.Warn("startup warmup failed", "language", lang.Code, "error", apiErr.Message)
			if !sleepCtx(ctx, 500*time.Millisecond) {
				return
			}
			continue
		}
		body := transform.BuildFeaturedResponse(raw, 1)
		freshKey := featuredCacheKey("featured-fresh", lang.Code, 1, "", "", "", "", false)
		a.cachePut(staleKey, body, 200, a.ttl(a.cfg.FeaturedStaleTTLSeconds))
		a.cache.SetTTL(freshKey, true, a.ttl(a.cfg.FeaturedCacheDurationSeconds))
		a.warmCachesFromFeatured(dataList(body))
		a.log.Info("startup warmup complete", "language", lang.Code)
		if !sleepCtx(ctx, 200*time.Millisecond) {
			return
		}
	}
}

func (a *App) isValidLanguage(code string) bool {
	for _, l := range a.cfg.FeaturedLanguages {
		if l.Code == code {
			return true
		}
	}
	return false
}

func dataList(body map[string]any) []any {
	l, _ := body["data"].([]any)
	return l
}

// warmCachesFromFeatured pre-populates avatar (7d) and partial play (short TTL)
// caches from a featured response — porting transformers.warm_caches_from_featured.
// SetIfAbsent is atomic, avoiding a TOCTOU overwrite of a full entry with a partial one.
func (a *App) warmCachesFromFeatured(streams []any) {
	for _, s := range streams {
		stream, ok := s.(map[string]any)
		if !ok {
			continue
		}
		ch, _ := stream["channel"].(map[string]any)
		slug, _ := ch["slug"].(string)
		if slug == "" {
			continue
		}
		user, _ := ch["user"].(map[string]any)
		pic := user["profilepic"]

		if pic != nil {
			a.cache.SetIfAbsent("avatar:/streams/avatar/"+slug, cachedResp{
				payload: envelopeMap("success", "", map[string]any{"profile_picture": pic}),
				status:  200,
			}, a.ttl(a.cfg.AvatarCacheDurationSeconds))
		}
		if rawURL, ok := ch["playback_url"].(string); ok && rawURL != "" {
			a.cache.SetIfAbsent("live-url:"+slug, rawURL, a.ttl(a.cfg.LiveStaleTTLSeconds))
		}
		status := "offline"
		if b, ok := stream["is_live"].(bool); ok && b {
			status = "live"
		}
		username := any(slug)
		if u, ok := user["username"]; ok {
			username = u
		}
		partial := envelopeMap("success", "", map[string]any{
			"status":                   status,
			"channel_slug":             slug,
			"username":                 username,
			"profile_picture":          pic,
			"playback_url":             "/streams/m3u8/" + slug + ".m3u8",
			"session_title":            stream["session_title"],
			"livestream_id":            stream["id"],
			"livestream_viewer_count":  stream["viewer_count"],
			"livestream_thumbnail_url": transform.ExtractThumbnail(stream, pic),
			"livestream_category":      transform.ExtractCategoryName(stream),
			"start_time":               stream["start_time"],
			"_partial":                 true,
		})
		a.cache.SetIfAbsent("live:/streams/play/"+slug, cachedResp{payload: partial, status: 200}, a.ttl(a.cfg.LiveCacheDurationSeconds))
	}
}

// ── /streams/search ──────────────────────────────────────────────────────────

func (a *App) handleSearch(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) < 2 {
		errorJSON(w, "Query must be at least 2 characters.", 400)
		return
	}
	if len(query) > 100 {
		errorJSON(w, "Query too long.", 400)
		return
	}
	key := "search:" + strings.ToLower(query)
	if c, ok := a.cacheGet(key); ok {
		// Enrich on hits too: avatar cache (7d TTL) may have filled since this
		// 30s entry was stored. Shallow-copy each result map first — the cached
		// slice is shared across goroutines, so in-place writes would race.
		if data, ok := c.payload["data"].([]map[string]any); ok {
			copied := shallowCopyMaps(data)
			a.enrichSearchAvatars(copied)
			writeCached(w, cachedResp{status: c.status, payload: map[string]any{
				"status": c.payload["status"], "message": c.payload["message"], "data": copied,
			}})
		} else {
			writeCached(w, c)
		}
		return
	}
	results, apiErr := kickCall(a.cbNonCritical, obs.LaneNonCritical, query, func() ([]map[string]any, error) {
		return a.kick.SearchChannelsTypesense(query)
	})
	if apiErr != nil {
		writeAPIErr(w, apiErr)
		return
	}
	a.enrichSearchAvatars(results)
	payload := envelopeMap("success", "", results)
	a.cachePut(key, payload, 200, a.ttl(a.cfg.SearchCacheDurationSeconds))
	writeCached(w, cachedResp{payload: payload, status: 200})
}

// shallowCopyMaps returns a new slice of shallow-copied maps, so concurrent
// requests don't race on writes to a map stored in the cache.
func shallowCopyMaps(src []map[string]any) []map[string]any {
	out := make([]map[string]any, len(src))
	for i, m := range src {
		mc := make(map[string]any, len(m))
		for k, v := range m {
			mc[k] = v
		}
		out[i] = mc
	}
	return out
}

// enrichSearchAvatars fills profile_picture from the avatar cache (7-day TTL).
func (a *App) enrichSearchAvatars(results []map[string]any) {
	for _, res := range results {
		slug, _ := res["slug"].(string)
		if slug == "" || res["profile_picture"] != nil {
			continue
		}
		if cv, ok := a.cache.Get("avatar:/streams/avatar/" + slug); ok {
			if cr, ok := cv.(cachedResp); ok {
				if dataMap, ok := cr.payload["data"].(map[string]any); ok {
					res["profile_picture"] = dataMap["profile_picture"]
				}
			}
		}
	}
}

// ── /streams/viewers ─────────────────────────────────────────────────────────

func (a *App) handleViewers(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.URL.Query().Get("id"))
	if err != nil {
		errorJSON(w, "Missing or invalid livestream ID.", 400)
		return
	}
	if id <= 0 {
		errorJSON(w, "Invalid livestream ID.", 400)
		return
	}
	a.serveCached(w, "viewers:"+strconv.Itoa(id), a.ttl(a.cfg.ViewerCacheDurationSeconds), func() (map[string]any, *apierr.Error) {
		viewers, e := kickCall(a.cbNonCritical, obs.LaneNonCritical, strconv.Itoa(id), func() (int, error) {
			return a.kick.GetViewerCount(id)
		})
		if e != nil {
			return nil, e
		}
		return envelopeMap("success", "", map[string]any{"viewer_count": viewers}), nil
	})
}

func (a *App) handleViewersBatch(w http.ResponseWriter, r *http.Request) {
	ids := make([]int, 0)
	seen := make(map[int]struct{})
	for _, s := range strings.Split(r.URL.Query().Get("ids"), ",") {
		if s = strings.TrimSpace(s); s == "" {
			continue
		}
		val, err := strconv.Atoi(s)
		if err != nil {
			errorJSON(w, "Invalid ID list.", 400)
			return
		}
		if val > 0 {
			if _, duplicate := seen[val]; duplicate {
				continue
			}
			seen[val] = struct{}{}
			ids = append(ids, val)
		}
	}
	if len(ids) == 0 {
		errorJSON(w, "Missing livestream IDs.", 400)
		return
	}
	if len(ids) > 50 {
		ids = ids[:50]
	}
	sortedIDs := append([]int(nil), ids...)
	sort.Ints(sortedIDs)
	parts := make([]string, len(sortedIDs))
	for i, id := range sortedIDs {
		parts[i] = strconv.Itoa(id)
	}
	a.serveCached(w, "viewers-batch:"+strings.Join(parts, ","), a.ttl(a.cfg.ViewerCacheDurationSeconds), func() (map[string]any, *apierr.Error) {
		counts, e := kickCall(a.cbNonCritical, obs.LaneNonCritical, "batch", func() (map[int]int, error) {
			return a.kick.GetViewerCountsBatch(ids)
		})
		if e != nil {
			return nil, e
		}
		data := make(map[string]any, len(counts))
		for k, v := range counts {
			data[strconv.Itoa(k)] = v
		}
		return envelopeMap("success", "", data), nil
	})
}
