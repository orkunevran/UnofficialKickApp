package httpapi

import (
	"net/http"
	"testing"
	"time"
)

func chatApp(t *testing.T, history any) (*App, *fakeKick) {
	t.Helper()
	fake := &fakeKick{
		channel: map[string]any{
			"id":         float64(77264178),
			"user":       map[string]any{"username": "Cavs"},
			"chatroom":   map[string]any{"id": float64(76975266)},
			"livestream": map[string]any{"id": float64(42)},
		},
		chatHistory: history,
	}
	return appWithKick(t, fake), fake
}

func chatHistoryPayload() any {
	return map[string]any{"data": map[string]any{
		"messages": []any{
			map[string]any{
				"id": "m1", "content": "first", "created_at": "2026-07-29T05:11:05Z",
				"sender": map[string]any{"username": "alice", "identity": map[string]any{
					"color": "#ff0000", "badges": []any{map[string]any{"type": "moderator"}},
				}},
			},
			map[string]any{
				"id": "m2", "content": "second", "created_at": "2026-07-29T05:11:07Z",
				"sender": map[string]any{"username": "bob"},
			},
			// No content: nothing to render, so it must not reach the client.
			map[string]any{"id": "m3", "sender": map[string]any{"username": "carol"}},
		},
		"cursor": "123",
	}}
}

func TestChatHistoryReplaysAWindow(t *testing.T) {
	app, fake := chatApp(t, chatHistoryPayload())
	at := time.Now().UTC().Add(-30 * time.Minute).Truncate(time.Second)

	code, body := getJSON(t, app, "/streams/chat/cavs/history?at="+at.Format(time.RFC3339))
	if code != http.StatusOK {
		t.Fatalf("status = %d; body=%v", code, body)
	}
	data, _ := body["data"].(map[string]any)
	messages, _ := data["messages"].([]any)
	if len(messages) != 2 {
		t.Fatalf("got %d messages; want 2 renderable ones", len(messages))
	}
	first, _ := messages[0].(map[string]any)
	if first["username"] != "alice" || first["content"] != "first" || first["color"] != "#ff0000" {
		t.Fatalf("first message not carried through: %v", first)
	}
	if first["created_at"] != "2026-07-29T05:11:05Z" {
		t.Fatalf("timestamps must survive — chat is aligned by them: %v", first["created_at"])
	}

	// The upstream is asked for the window the position falls in, snapped to a grid
	// so nearby scrub positions share one cache entry.
	if fake.chatAskedFor == "" {
		t.Fatal("upstream was never asked for a window")
	}
	asked, err := time.Parse(time.RFC3339, fake.chatAskedFor)
	if err != nil {
		t.Fatalf("asked for an unparseable window %q", fake.chatAskedFor)
	}
	if asked.Unix()%chatWindowSeconds != 0 {
		t.Fatalf("window %v is not snapped to a %ds grid", asked, chatWindowSeconds)
	}
}

func TestChatHistoryCachesPastWindows(t *testing.T) {
	app, fake := chatApp(t, chatHistoryPayload())
	at := time.Now().UTC().Add(-time.Hour).Truncate(chatWindowSeconds * time.Second)
	path := "/streams/chat/cavs/history?at=" + at.Format(time.RFC3339)

	getJSON(t, app, path)
	after := fake.chatCalls.Load()
	// A window that has passed can't change; scrubbing back over it must not refetch.
	for i := 0; i < 3; i++ {
		getJSON(t, app, path)
	}
	if fake.chatCalls.Load() != after {
		t.Fatalf("re-requesting a past window cost %d extra upstream calls", fake.chatCalls.Load()-after)
	}
}

func TestChatHistoryUsesChannelIDNotChatroomID(t *testing.T) {
	app, fake := chatApp(t, chatHistoryPayload())
	// Prime /play so the id comes from cache, as it does in normal use.
	getJSON(t, app, "/streams/play/cavs")

	fake.chatHistory = chatHistoryPayload()
	code, _ := getJSON(t, app, "/streams/chat/cavs/history?at="+time.Now().UTC().Add(-time.Minute).Format(time.RFC3339))
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if fake.chatCalls.Load() == 0 {
		t.Fatal("no chat history request was made")
	}
}

func TestChatHistoryRejectsBadTimestamps(t *testing.T) {
	app, _ := chatApp(t, chatHistoryPayload())

	tests := []struct {
		name, query string
	}{
		{"missing", ""},
		{"garbage", "?at=yesterday"},
		{"future", "?at=" + time.Now().UTC().Add(2*time.Hour).Format(time.RFC3339)},
		{"beyond the replay limit", "?at=" + time.Now().UTC().Add(-72*time.Hour).Format(time.RFC3339)},
	}
	for _, tc := range tests {
		if code, _ := getJSON(t, app, "/streams/chat/cavs/history"+tc.query); code != http.StatusBadRequest {
			t.Errorf("%s: status = %d; want 400", tc.name, code)
		}
	}
}
