package httpapi

import (
	"errors"
	"fmt"
	"net/http"
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

// kickClient is the subset of the Kick client the handlers use. The seam lets
// later phases inject fakes for parity tests without a live network.
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
}

var (
	slugRe        = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,255}$`)
	subcategoryRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9 &.:_()\-]{0,99}$`)
)

func validateSlug(slug string) bool { return slugRe.MatchString(slug) }

// envelopeMap builds the {status, message, data} response body.
func envelopeMap(status, message string, data any) map[string]any {
	return map[string]any{"status": status, "message": message, "data": data}
}

// requestCacheKey mirrors api/cache.py request_cache_key (prefix:path?sorted-query).
func requestCacheKey(prefix string, r *http.Request) string {
	key := prefix + ":" + r.URL.Path
	if q := r.URL.Query().Encode(); q != "" {
		return key + "?" + q
	}
	return key
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

func (a *App) ttl(seconds int) time.Duration { return time.Duration(seconds) * time.Second }

// ── /streams/play ────────────────────────────────────────────────────────────

func (a *App) handlePlayStream(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	if !validateSlug(slug) {
		errorJSON(w, fmt.Sprintf("Invalid channel slug: '%s'.", slug), 400)
		return
	}
	key := "live:/streams/play/" + slug
	if v, ok := a.cache.Get(key); ok {
		writeJSON(w, 200, v)
		return
	}

	data, apiErr := kickCall(a.cbCritical, obs.LaneCritical, slug, func() (map[string]any, error) {
		return a.kick.GetChannelData(slug)
	})
	if apiErr != nil {
		errorJSON(w, apiErr.Message, apiErr.Status)
		return
	}
	if pb, ok := data["playback_url"].(string); ok && pb != "" {
		a.cache.SetTTL("live-url:"+slug, pb, a.ttl(a.cfg.LiveStaleTTLSeconds))
	}
	payload, perr := buildPlayStreamPayload(data, slug)
	if perr != nil {
		errorJSON(w, perr.Message, perr.Status)
		return
	}
	a.cache.SetTTL(key, payload, a.ttl(a.cfg.LiveCacheDurationSeconds))
	writeJSON(w, 200, payload)
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
	slug := r.PathValue("slug")
	if !validateSlug(slug) {
		errorJSON(w, fmt.Sprintf("Invalid channel slug: '%s'.", slug), 400)
		return
	}
	http.Redirect(w, r, "/streams/m3u8/"+slug+".m3u8", http.StatusTemporaryRedirect)
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
			errorJSON(w, apiErr.Message, apiErr.Status)
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
	h := w.Header()
	h.Set("Content-Type", "application/vnd.apple.mpegurl")
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Cache-Control", "no-cache, no-store, must-revalidate")
	_, _ = w.Write(body)
}

// ── /streams/avatar ──────────────────────────────────────────────────────────

func (a *App) handleAvatar(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	if !validateSlug(slug) {
		errorJSON(w, fmt.Sprintf("Invalid channel slug: '%s'.", slug), 400)
		return
	}
	key := "avatar:/streams/avatar/" + slug
	if v, ok := a.cache.Get(key); ok {
		writeJSON(w, 200, v)
		return
	}

	// Reuse the profile picture from a cached play response if present.
	if lv, ok := a.cache.Get("live:/streams/play/" + slug); ok {
		if data := extractDataMap(lv); data != nil {
			if _, present := data["profile_picture"]; present {
				payload := envelopeMap("success", "", map[string]any{"profile_picture": data["profile_picture"]})
				a.cache.SetTTL(key, payload, a.ttl(a.cfg.AvatarCacheDurationSeconds))
				writeJSON(w, 200, payload)
				return
			}
		}
	}

	data, apiErr := kickCall(a.cbNonCritical, obs.LaneNonCritical, slug, func() (map[string]any, error) {
		return a.kick.GetChannelData(slug)
	})
	if apiErr != nil {
		errorJSON(w, apiErr.Message, apiErr.Status)
		return
	}
	var pic any
	if user, ok := data["user"].(map[string]any); ok {
		pic = user["profile_pic"]
	}
	payload := envelopeMap("success", "", map[string]any{"profile_picture": pic})
	a.cache.SetTTL(key, payload, a.ttl(a.cfg.AvatarCacheDurationSeconds))
	writeJSON(w, 200, payload)
}

func extractDataMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		d, _ := m["data"].(map[string]any)
		return d
	}
	return nil
}

// ── /streams/clips ───────────────────────────────────────────────────────────

func (a *App) handleClips(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	if !validateSlug(slug) {
		errorJSON(w, fmt.Sprintf("Invalid channel slug: '%s'.", slug), 400)
		return
	}
	key := "clips:/streams/clips/" + slug
	if v, ok := a.cache.Get(key); ok {
		writeJSON(w, 200, v)
		return
	}
	raw, apiErr := kickCall(a.cbNonCritical, obs.LaneNonCritical, slug, func() (any, error) {
		return a.kick.GetChannelClips(slug)
	})
	if apiErr != nil {
		errorJSON(w, apiErr.Message, apiErr.Status)
		return
	}
	payload := envelopeMap("success", "", map[string]any{"clips": transform.NormalizeClipList(raw, slug)})
	a.cache.SetTTL(key, payload, a.ttl(a.cfg.VODCacheDurationSeconds))
	writeJSON(w, 200, payload)
}

// ── /streams/vods ────────────────────────────────────────────────────────────

func (a *App) handleVODs(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	if !validateSlug(slug) {
		errorJSON(w, fmt.Sprintf("Invalid channel slug: '%s'.", slug), 400)
		return
	}
	key := "vods:/streams/vods/" + slug
	if v, ok := a.cache.Get(key); ok {
		writeJSON(w, 200, v)
		return
	}
	raw, apiErr := kickCall(a.cbNonCritical, obs.LaneNonCritical, slug, func() (any, error) {
		return a.kick.GetChannelVideos(slug)
	})
	if apiErr != nil {
		errorJSON(w, apiErr.Message, apiErr.Status)
		return
	}
	payload := envelopeMap("success", "", map[string]any{"vods": transform.ProcessVODData(raw)})
	a.cache.SetTTL(key, payload, a.ttl(a.cfg.VODCacheDurationSeconds))
	writeJSON(w, 200, payload)
}

func (a *App) handlePlayVOD(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	if !validateSlug(slug) {
		errorJSON(w, fmt.Sprintf("Invalid channel slug: '%s'.", slug), 400)
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
		errorJSON(w, apiErr.Message, apiErr.Status)
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

// ── /streams/featured-livestreams ────────────────────────────────────────────

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
	key := requestCacheKey("featured-livestreams", r)
	if v, ok := a.cache.Get(key); ok {
		w.Header().Set("Cache-Control", cacheControl)
		writeJSON(w, 200, v)
		return
	}

	filtered := category != "" || subcategory != "" || subcategories != ""
	raw, apiErr := kickCall(a.cbNonCritical, obs.LaneNonCritical, language, func() (any, error) {
		if filtered {
			return a.kick.GetAllLivestreams(language, page, category, subcategory, subcategories, sortParam, strict)
		}
		return a.kick.GetFeaturedLivestreams(language, page)
	})
	if apiErr != nil {
		errorJSON(w, apiErr.Message, apiErr.Status)
		return
	}
	body := transform.BuildFeaturedResponse(raw, page)
	a.cache.SetTTL(key, body, a.ttl(a.cfg.FeaturedCacheDurationSeconds))
	w.Header().Set("Cache-Control", cacheControl)
	writeJSON(w, 200, body)
}

func (a *App) isValidLanguage(code string) bool {
	for _, l := range a.cfg.FeaturedLanguages {
		if l.Code == code {
			return true
		}
	}
	return false
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
	key := requestCacheKey("search", r)
	if v, ok := a.cache.Get(key); ok {
		writeJSON(w, 200, v)
		return
	}
	results, apiErr := kickCall(a.cbNonCritical, obs.LaneNonCritical, query, func() ([]map[string]any, error) {
		return a.kick.SearchChannelsTypesense(query)
	})
	if apiErr != nil {
		errorJSON(w, apiErr.Message, apiErr.Status)
		return
	}
	payload := envelopeMap("success", "", results)
	a.cache.SetTTL(key, payload, a.ttl(a.cfg.SearchCacheDurationSeconds))
	writeJSON(w, 200, payload)
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
	key := requestCacheKey("viewers", r)
	if v, ok := a.cache.Get(key); ok {
		writeJSON(w, 200, v)
		return
	}
	viewers, apiErr := kickCall(a.cbNonCritical, obs.LaneNonCritical, strconv.Itoa(id), func() (int, error) {
		return a.kick.GetViewerCount(id)
	})
	if apiErr != nil {
		errorJSON(w, apiErr.Message, apiErr.Status)
		return
	}
	payload := envelopeMap("success", "", map[string]any{"viewer_count": viewers})
	a.cache.SetTTL(key, payload, a.ttl(a.cfg.ViewerCacheDurationSeconds))
	writeJSON(w, 200, payload)
}

func (a *App) handleViewersBatch(w http.ResponseWriter, r *http.Request) {
	raw := strings.Split(r.URL.Query().Get("ids"), ",")
	ids := make([]int, 0, len(raw))
	for _, s := range raw {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		val, err := strconv.Atoi(s)
		if err != nil {
			errorJSON(w, "Invalid ID list.", 400)
			return
		}
		if val > 0 {
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
	key := "viewers-batch:" + strings.Join(parts, ",")
	if v, ok := a.cache.Get(key); ok {
		writeJSON(w, 200, v)
		return
	}

	counts, apiErr := kickCall(a.cbNonCritical, obs.LaneNonCritical, "batch", func() (map[int]int, error) {
		return a.kick.GetViewerCountsBatch(ids)
	})
	if apiErr != nil {
		errorJSON(w, apiErr.Message, apiErr.Status)
		return
	}
	data := make(map[string]any, len(counts))
	for k, v := range counts {
		data[strconv.Itoa(k)] = v
	}
	payload := envelopeMap("success", "", data)
	a.cache.SetTTL(key, payload, a.ttl(a.cfg.ViewerCacheDurationSeconds))
	writeJSON(w, 200, payload)
}
