package transform

import "testing"

func TestBuildChannelProfileFallbacksAndNulls(t *testing.T) {
	// Missing user → username falls back to slug; profile_picture is null.
	p := BuildChannelProfile(map[string]any{}, "mychannel")
	if p["username"] != "mychannel" {
		t.Fatalf("username = %v; want fallback to slug", p["username"])
	}
	if p["profile_picture"] != nil {
		t.Fatalf("profile_picture = %v; want nil (null)", p["profile_picture"])
	}
	if p["verified"] != false {
		t.Fatalf("verified = %v; want false", p["verified"])
	}
	if p["chatroom_id"] != nil {
		t.Fatalf("chatroom_id = %v; want nil", p["chatroom_id"])
	}

	// Empty/whitespace bio → null; present bio → trimmed.
	p = BuildChannelProfile(map[string]any{"user": map[string]any{"bio": "   "}}, "c")
	if p["bio"] != nil {
		t.Fatalf("blank bio should be nil, got %v", p["bio"])
	}
	p = BuildChannelProfile(map[string]any{"user": map[string]any{"username": "Bob", "bio": "  hi  "}}, "c")
	if p["bio"] != "hi" {
		t.Fatalf("bio = %v; want trimmed 'hi'", p["bio"])
	}
	if p["username"] != "Bob" {
		t.Fatalf("username = %v; want Bob", p["username"])
	}

	p = BuildChannelProfile(map[string]any{
		"chatroom": map[string]any{"id": float64(1234)},
	}, "c")
	if p["chatroom_id"] != float64(1234) {
		t.Fatalf("chatroom_id = %v; want 1234", p["chatroom_id"])
	}
}

func TestProcessVODData(t *testing.T) {
	if got := ProcessVODData("not a list"); len(got) != 0 {
		t.Fatalf("non-list input should yield empty slice, got %v", got)
	}

	raw := []any{
		map[string]any{
			"id":            float64(7),
			"session_title": "Title",
			"duration":      float64(120000), // ms → 120s
			"video":         map[string]any{"uuid": "abc", "views": float64(42)},
			"thumbnail":     map[string]any{"src": "t.jpg"},
		},
		"skip-me", // non-dict entries dropped
	}
	out := ProcessVODData(raw)
	if len(out) != 1 {
		t.Fatalf("want 1 vod, got %d", len(out))
	}
	v := out[0]
	if v["duration_seconds"] != 120.0 {
		t.Fatalf("duration_seconds = %v; want 120.0", v["duration_seconds"])
	}
	if v["video_uuid"] != "abc" || v["views"] != float64(42) || v["thumbnail_url"] != "t.jpg" {
		t.Fatalf("unexpected vod fields: %+v", v)
	}
}

func TestBuildFeaturedResponsePagination(t *testing.T) {
	raw := map[string]any{
		"data":          []any{map[string]any{"id": float64(1)}},
		"current_page":  float64(2),
		"per_page":      float64(14),
		"next_page_url": "http://next",
		// prev_page_url absent → has_prev false
	}
	resp := BuildFeaturedResponse(raw, 2)
	pag := resp["pagination"].(map[string]any)
	if pag["has_next"] != true {
		t.Fatalf("has_next = %v; want true", pag["has_next"])
	}
	if pag["has_prev"] != false {
		t.Fatalf("has_prev = %v; want false", pag["has_prev"])
	}
	if resp["status"] != "success" {
		t.Fatalf("status = %v; want success", resp["status"])
	}

	// Non-map input → empty data, defaults.
	resp = BuildFeaturedResponse(nil, 5)
	pag = resp["pagination"].(map[string]any)
	if pag["current_page"] != 5 || pag["per_page"] != 14 {
		t.Fatalf("defaults wrong: %+v", pag)
	}
}

func TestExtractThumbnailPriority(t *testing.T) {
	// src wins over url.
	got := ExtractThumbnail(map[string]any{"thumbnail": map[string]any{"src": "s", "url": "u"}}, "fb")
	if got != "s" {
		t.Fatalf("want src 's', got %v", got)
	}
	// url when no src.
	got = ExtractThumbnail(map[string]any{"thumbnail": map[string]any{"url": "u"}}, "fb")
	if got != "u" {
		t.Fatalf("want 'u', got %v", got)
	}
	// fallback when no thumbnail map.
	got = ExtractThumbnail(map[string]any{}, "fb")
	if got != "fb" {
		t.Fatalf("want fallback 'fb', got %v", got)
	}
}
