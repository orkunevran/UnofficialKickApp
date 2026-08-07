// Package transform ports the pure data-transformation functions from
// services/transformers.py. They convert raw Kick API response shapes (decoded
// JSON, i.e. map[string]any) into the stable response format the frontend
// expects, with no HTTP or cache dependencies so they can be unit-tested in
// isolation.
//
// Faithfulness note: Python distinguishes a missing/None field (serialised as
// JSON null) from an empty string. These functions return `any` for nullable
// fields and use nil for null so encoding/json reproduces the Python output.
package transform

import (
	"fmt"
	"strings"
)

// ── dynamic-access helpers (the Go equivalent of dict.get chains) ────────

func getMap(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

func getList(v any) ([]any, bool) {
	l, ok := v.([]any)
	return l, ok
}

// get returns m[key] or nil when m is nil or the key is absent.
func get(m map[string]any, key string) any {
	if m == nil {
		return nil
	}
	return m[key]
}

// asNumber returns v as float64 if it is a JSON number (float64) or an int.
func asNumber(v any) (float64, bool) {
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

// truthy mirrors Python's bool(x): nil/false/""/0/empty-collection are falsy.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	case int:
		return x != 0
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	default:
		return true
	}
}

// orFallback returns v when truthy, else fallback — Python's `v or fallback`.
func orFallback(v any, fallback any) any {
	if truthy(v) {
		return v
	}
	return fallback
}

// ── Shared utilities ─────────────────────────────────────────────────────

// ExtractThumbnail returns the best thumbnail URL: thumbnail.src → thumbnail.url
// → fallback.
func ExtractThumbnail(data map[string]any, fallback any) any {
	if thumb, ok := getMap(get(data, "thumbnail")); ok {
		return orFallback(thumb["src"], orFallback(thumb["url"], fallback))
	}
	return fallback
}

// ExtractCategoryName returns the first category name, or nil.
func ExtractCategoryName(data map[string]any) any {
	if cats, ok := getList(get(data, "categories")); ok && len(cats) > 0 {
		if first, ok := getMap(cats[0]); ok {
			return first["name"]
		}
	}
	return nil
}

// ── Channel profile ──────────────────────────────────────────────────────

// BuildChannelProfile flattens raw channel data into the frontend profile shape.
func BuildChannelProfile(data map[string]any, channelSlug string) map[string]any {
	user, _ := getMap(get(data, "user"))
	chatroom, _ := getMap(get(data, "chatroom"))

	var bannerURL any
	if banner, ok := getMap(get(data, "banner_image")); ok {
		bannerURL = banner["url"]
	}

	// bio: (user.get("bio") or "").strip() or None
	var bio any
	if s, ok := get(user, "bio").(string); ok {
		if trimmed := strings.TrimSpace(s); trimmed != "" {
			bio = trimmed
		}
	}

	social := map[string]any{}
	for _, k := range []string{"instagram", "twitter", "youtube", "discord", "tiktok"} {
		social[k] = orFallback(get(user, k), nil)
	}

	recent := []any{}
	if cats, ok := getList(get(data, "recent_categories")); ok {
		for _, c := range cats {
			if cm, ok := getMap(c); ok && truthy(cm["name"]) {
				recent = append(recent, cm["name"])
			}
		}
	}

	return map[string]any{
		"channel_slug":         channelSlug,
		"username":             orFallback(get(user, "username"), channelSlug),
		"profile_picture":      get(user, "profile_pic"),
		"banner_image_url":     bannerURL,
		"bio":                  bio,
		"followers_count":      get(data, "followers_count"),
		"verified":             truthy(get(data, "verified")),
		"subscription_enabled": truthy(get(data, "subscription_enabled")),
		"chatroom_id":          get(chatroom, "id"),
		// Chat *replay* is keyed on the channel id, not the chatroom id the live
		// socket uses (see internal/httpapi/chat.go).
		"channel_id":        get(data, "id"),
		"social_links":      social,
		"recent_categories": recent,
	}
}

// ── VOD processing ─────────────────────────────────────────────────────────

// ProcessVODData normalises a raw VOD list into the stable VOD shape.
func ProcessVODData(raw any) []map[string]any {
	list, ok := getList(raw)
	if !ok {
		return []map[string]any{}
	}
	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		vod, ok := getMap(item)
		if !ok {
			continue
		}
		video, _ := getMap(vod["video"])
		thumb, _ := getMap(vod["thumbnail"])

		var durationSeconds any
		if n, ok := asNumber(vod["duration"]); ok {
			durationSeconds = n / 1000.0
		}

		out = append(out, map[string]any{
			"vod_id":           vod["id"],
			"video_uuid":       get(video, "uuid"),
			"title":            vod["session_title"],
			"source_url":       vod["source"],
			"thumbnail_url":    get(thumb, "src"),
			"views":            get(video, "views"),
			"duration_seconds": durationSeconds,
			"created_at":       vod["created_at"],
			"language":         vod["language"],
			"is_mature":        vod["is_mature"],
		})
	}
	return out
}

// ── Clip normalisation ───────────────────────────────────────────────────

// NormalizeClipList normalises clips from the several shapes Kick returns them in.
func NormalizeClipList(raw any, channelSlug string) []map[string]any {
	var clips []any
	switch v := raw.(type) {
	case map[string]any:
		clipsObj := v["clips"]
		if clipsObj == nil {
			clipsObj = v
		}
		switch co := clipsObj.(type) {
		case map[string]any:
			clips, _ = getList(co["data"])
		case []any:
			clips = co
		}
	case []any:
		clips = v
	}

	out := make([]map[string]any, 0, len(clips))
	for _, item := range clips {
		c, ok := getMap(item)
		if !ok {
			continue
		}

		var categoryName any
		if cat, ok := getMap(c["category"]); ok {
			categoryName = cat["name"]
		} else {
			categoryName = c["category"]
		}

		channelSlugVal := any(channelSlug)
		if ch, ok := getMap(c["channel"]); ok {
			channelSlugVal = ch["slug"]
		}

		out = append(out, map[string]any{
			"clip_id":          c["id"],
			"title":            c["title"],
			"clip_url":         orFallback(c["clip_url"], c["video_url"]),
			"playback_url":     "/streams/clip/" + channelSlug + "/" + fmt.Sprint(c["id"]),
			"thumbnail_url":    c["thumbnail_url"],
			"duration_seconds": c["duration"],
			"views":            c["views"],
			"category_name":    categoryName,
			"created_at":       c["created_at"],
			"channel_slug":     channelSlugVal,
		})
	}
	return out
}

// ── Featured streams ───────────────────────────────────────────────────────

// BuildFeaturedResponse builds the featured-livestreams response body with
// pagination metadata.
func BuildFeaturedResponse(raw any, pageInt int) map[string]any {
	data := any([]any{})
	pagination := map[string]any{
		"current_page": pageInt,
		"per_page":     14,
		"has_next":     false,
		"has_prev":     false,
	}
	if m, ok := getMap(raw); ok {
		if d, ok := m["data"]; ok {
			data = d
		}
		if cp, ok := m["current_page"]; ok {
			pagination["current_page"] = cp
		}
		if pp, ok := m["per_page"]; ok {
			pagination["per_page"] = pp
		}
		pagination["has_next"] = m["next_page_url"] != nil
		pagination["has_prev"] = m["prev_page_url"] != nil
	}
	return map[string]any{
		"status":     "success",
		"message":    "",
		"data":       data,
		"pagination": pagination,
	}
}
