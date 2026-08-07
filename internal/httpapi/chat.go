package httpapi

// Chat replay.
//
// Kick's chat history is addressable by wall-clock time: one request returns the
// messages from a ~4 second window beginning at a given instant, for any point in
// the past (verified two hours back on a busy channel). That is what lets chat
// follow the DVR timeline — a position on the broadcast maps to an instant, and
// that instant maps to the messages that were on screen then.
//
// It is proxied rather than called from the page because the upstream sends no
// CORS headers, and it is keyed on the channel id rather than the chatroom id the
// live socket uses.

import (
	"fmt"
	"net/http"
	"time"

	"kickapi/internal/apierr"
	"kickapi/internal/obs"
)

const (
	// chatWindowSeconds is how much time one upstream response covers.
	chatWindowSeconds = 5

	// A window that has passed can never change, so it is cached for much longer
	// than one near the live edge, which is still filling.
	chatPastWindowTTL = 10 * time.Minute
	chatLiveWindowTTL = 5 * time.Second

	// chatMaxHistoryAge bounds how far back a replay request may reach, so the
	// endpoint can't be used to walk a channel's entire history.
	chatMaxHistoryAge = 48 * time.Hour
)

// handleChatHistory serves the chat that was on screen at a given moment.
//
//	GET /streams/chat/{slug}/history?at=2026-07-29T05:11:06Z
func (a *App) handleChatHistory(w http.ResponseWriter, r *http.Request) {
	slug, ok := a.slug(w, r)
	if !ok {
		return
	}
	at, err := time.Parse(time.RFC3339, r.URL.Query().Get("at"))
	if err != nil {
		errorJSON(w, "Invalid or missing 'at' timestamp (RFC 3339 expected).", 400)
		return
	}
	at = at.UTC().Truncate(time.Second)

	now := time.Now().UTC()
	if at.After(now.Add(time.Minute)) {
		errorJSON(w, "Cannot replay chat from the future.", 400)
		return
	}
	if now.Sub(at) > chatMaxHistoryAge {
		errorJSON(w, "Chat replay is limited to the last 48 hours.", 400)
		return
	}

	channelID, apiErr := a.chatChannelID(slug)
	if apiErr != nil {
		writeAPIErr(w, apiErr)
		return
	}

	// Windows are snapped to a grid so viewers scrubbing to nearby positions share
	// cache entries instead of each fetching a slightly different offset.
	window := at.Truncate(chatWindowSeconds * time.Second)
	ttl := chatPastWindowTTL
	if now.Sub(window) < chatWindowSeconds*time.Second*2 {
		ttl = chatLiveWindowTTL
	}

	key := fmt.Sprintf("chat:%d:%d", channelID, window.Unix())
	a.serveCached(w, key, ttl, func() (map[string]any, *apierr.Error) {
		raw, e := kickCall(a.cbNonCritical, obs.LaneNonCritical, slug, func() (any, error) {
			return a.kick.GetChatHistory(channelID, window.Format(time.RFC3339))
		})
		if e != nil {
			return nil, e
		}
		return envelopeMap("success", "", map[string]any{
			"at":       window.Format(time.RFC3339),
			"messages": normalizeChatMessages(raw),
		}), nil
	})
}

// chatChannelID resolves the channel id chat history is keyed on, preferring the
// /play cache so a replay request usually costs nothing upstream.
func (a *App) chatChannelID(slug string) (int, *apierr.Error) {
	if v, ok := a.cache.Get("live:/streams/play/" + slug); ok {
		if data := extractDataMap(v); data != nil {
			if id, ok := numeric(data["channel_id"]); ok && id > 0 {
				return int(id), nil
			}
		}
	}
	data, apiErr := kickCall(a.cbNonCritical, obs.LaneNonCritical, slug, func() (map[string]any, error) {
		return a.kick.GetChannelData(slug)
	})
	if apiErr != nil {
		return 0, apiErr
	}
	if id, ok := numeric(data["id"]); ok && id > 0 {
		return int(id), nil
	}
	return 0, apierr.New("Chat history is unavailable for this channel.", 404)
}

// normalizeChatMessages reduces upstream messages to what the renderer needs, so
// the replay payload stays close to what the live socket delivers.
func normalizeChatMessages(raw any) []map[string]any {
	root, _ := raw.(map[string]any)
	data, _ := root["data"].(map[string]any)
	list, _ := data["messages"].([]any)

	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		msg, ok := item.(map[string]any)
		if !ok {
			continue
		}
		content, _ := msg["content"].(string)
		if content == "" {
			continue
		}
		sender, _ := msg["sender"].(map[string]any)
		identity, _ := sender["identity"].(map[string]any)
		entry := map[string]any{
			"id":         fmt.Sprint(msg["id"]),
			"content":    content,
			"created_at": msg["created_at"],
			"username":   sender["username"],
		}
		if identity != nil {
			entry["color"] = identity["color"]
			if badges, ok := identity["badges"].([]any); ok {
				entry["badges"] = badges
			}
		}
		out = append(out, entry)
	}
	return out
}
