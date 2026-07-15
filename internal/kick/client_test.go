package kick

import (
	"strings"
	"testing"
)

func TestReadResponseBodyLimit(t *testing.T) {
	got, err := readResponseBody(strings.NewReader("1234"), 4)
	if err != nil || string(got) != "1234" {
		t.Fatalf("bounded read = %q, %v", got, err)
	}
	if _, err := readResponseBody(strings.NewReader("12345"), 4); err == nil {
		t.Fatal("oversized upstream response should fail")
	}
}

func TestParseViewerCount(t *testing.T) {
	cases := []struct {
		name string
		body string
		want int
	}{
		{"empty", "", 0},
		{"whitespace", "   \n", 0},
		{"non-json", "<html>", 0},
		{"empty list", "[]", 0},
		{"single", `[{"livestream_id":5,"viewers":1044}]`, 1044},
		{"missing viewers", `[{"livestream_id":5}]`, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := parseViewerCount([]byte(c.body)); got != c.want {
				t.Fatalf("parseViewerCount(%q) = %d; want %d", c.body, got, c.want)
			}
		})
	}
}

func TestParseBatchViewers(t *testing.T) {
	out := parseBatchViewers([]byte(`[{"livestream_id":1,"viewers":10},{"livestream_id":2,"viewers":20},{"viewers":99}]`))
	if len(out) != 2 || out[1] != 10 || out[2] != 20 {
		t.Fatalf("parseBatchViewers = %v; want {1:10, 2:20}", out)
	}
	if got := parseBatchViewers([]byte("")); len(got) != 0 {
		t.Fatalf("empty body should yield empty map, got %v", got)
	}
}

func TestMergeTypesenseHits(t *testing.T) {
	data := map[string]any{
		"results": []any{
			map[string]any{"hits": []any{
				map[string]any{"document": map[string]any{"slug": "alice", "username": "Alice", "followers_count": float64(100), "is_live": true, "verified": true}},
				map[string]any{"document": map[string]any{"slug": "alice"}}, // duplicate slug → skipped
			}},
			map[string]any{"hits": []any{
				map[string]any{"document": map[string]any{"slug": "bob"}}, // username falls back to slug
				map[string]any{"document": map[string]any{"slug": ""}},    // empty slug → skipped
			}},
		},
	}
	got := mergeTypesenseHits(data)
	if len(got) != 2 {
		t.Fatalf("want 2 merged rows, got %d: %v", len(got), got)
	}
	if got[0]["slug"] != "alice" || got[0]["username"] != "Alice" || got[0]["is_live"] != true {
		t.Fatalf("row 0 wrong: %v", got[0])
	}
	if got[1]["slug"] != "bob" || got[1]["username"] != "bob" {
		t.Fatalf("row 1 wrong (username should fall back to slug): %v", got[1])
	}
	if got[0]["profile_picture"] != nil {
		t.Fatalf("profile_picture should be nil, got %v", got[0]["profile_picture"])
	}
}

func TestChunkRankOrdering(t *testing.T) {
	// app/webpack chunks rank before numbered chunks before the rest.
	if chunkRank("/_next/static/chunks/webpack-abc.js") != 0 {
		t.Fatal("webpack chunk should rank 0")
	}
	if chunkRank("/_next/static/chunks/123-abc.js") != 1 {
		t.Fatal("numbered chunk should rank 1")
	}
	if chunkRank("/_next/static/chunks/main-abc.js") != 2 {
		t.Fatal("other chunk should rank 2")
	}
}
