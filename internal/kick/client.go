// Package kick is the HTTP client for the Kick.com API and its Typesense
// search backend, porting services/kick_api_service.py.
//
// Cloudflare fingerprints the TLS ClientHello, so a plain net/http client is
// challenged/blocked. We use bogdanfinn/tls-client (utls + fhttp) with a
// current Chrome impersonation profile — the Go analog of the Python
// curl_cffi(impersonate="chrome120") session. See docs/MIGRATION_GO.md §4.
package kick

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

// chromeUA is kept coherent with clientProfile below — Cloudflare in 2026
// cross-checks the User-Agent against the TLS/HTTP2 fingerprint.
const chromeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

var clientProfile = profiles.Chrome_131

// HTTPError signals a non-2xx upstream response. The route layer maps it to a
// client-facing apierr.Error with the per-request safe value.
type HTTPError struct{ Status int }

func (e *HTTPError) Error() string { return fmt.Sprintf("upstream HTTP %d", e.Status) }

// Client talks to Kick and its Typesense search cluster.
type Client struct {
	http              tls_client.HttpClient
	baseURL           string
	featuredURL       string
	allLivestreamsURL string

	// Typesense key cache (process-wide, mirrors the Python class vars).
	tsMu        sync.Mutex
	tsKey       string
	tsFetchedAt time.Time
}

// Config carries the URLs the client needs (from the app config).
type Config struct {
	BaseURL           string
	FeaturedURL       string
	AllLivestreamsURL string
}

// New constructs a Client with a Chrome-impersonating TLS client.
func New(cfg Config) (*Client, error) {
	httpClient, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(),
		tls_client.WithClientProfile(clientProfile),
		tls_client.WithTimeoutSeconds(12),
	)
	if err != nil {
		return nil, fmt.Errorf("init tls client: %w", err)
	}
	return &Client{
		http:              httpClient,
		baseURL:           cfg.BaseURL,
		featuredURL:       cfg.FeaturedURL,
		allLivestreamsURL: cfg.AllLivestreamsURL,
	}, nil
}

// ── low-level HTTP ─────────────────────────────────────────────────────────

// do performs a request with the standard browser-like headers and returns the
// status and body. A non-2xx status is returned as *HTTPError by the callers
// that need it; do itself returns the raw status so tolerant callers (viewer
// counts) can inspect it.
func (c *Client) do(method, rawURL string, body io.Reader, headers map[string]string) (int, []byte, error) {
	req, err := fhttp.NewRequest(method, rawURL, body)
	if err != nil {
		return 0, nil, err
	}
	req.Header = fhttp.Header{
		"User-Agent": {chromeUA},
		"Accept":     {"application/json"},
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, data, nil
}

// getJSON GETs a URL and decodes JSON, returning *HTTPError on a non-2xx status
// and a transport error otherwise.
func (c *Client) getJSON(rawURL string) (any, error) {
	status, body, err := c.do(fhttp.MethodGet, rawURL, nil, nil)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, &HTTPError{Status: status}
	}
	var out any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ── channel / livestream endpoints ──────────────────────────────────────────

// GetChannelData fetches channel + livestream data.
func (c *Client) GetChannelData(slug string) (map[string]any, error) {
	v, err := c.getJSON(c.baseURL + slug)
	if err != nil {
		return nil, err
	}
	m, _ := v.(map[string]any)
	return m, nil
}

// GetChannelVideos fetches the raw VOD list.
func (c *Client) GetChannelVideos(slug string) (any, error) {
	return c.getJSON(c.baseURL + slug + "/videos")
}

// GetChannelClips fetches the raw clips payload.
func (c *Client) GetChannelClips(slug string) (any, error) {
	return c.getJSON(c.baseURL + slug + "/clips")
}

// GetFeaturedLivestreams fetches featured livestreams for a language/page.
func (c *Client) GetFeaturedLivestreams(language string, page int) (any, error) {
	return c.getJSON(fmt.Sprintf("%s%s?page=%d", c.featuredURL, language, page))
}

const allLivestreamsPageSize = 14

// GetAllLivestreams fetches category-filtered livestreams.
func (c *Client) GetAllLivestreams(language string, page int, category, subcategory, subcategories, sort string, strict bool) (any, error) {
	b := strings.Builder{}
	fmt.Fprintf(&b, "%s%s?page=%d&limit=%d", c.allLivestreamsURL, language, page, allLivestreamsPageSize)
	if category != "" {
		fmt.Fprintf(&b, "&category=%s", url.QueryEscape(category))
	}
	if subcategory != "" {
		fmt.Fprintf(&b, "&subcategory=%s", url.QueryEscape(subcategory))
	}
	if subcategories != "" {
		fmt.Fprintf(&b, "&subcategories=%s", url.QueryEscape(subcategories))
	}
	if sort != "" {
		fmt.Fprintf(&b, "&sort=%s", url.QueryEscape(sort))
	}
	if strict {
		b.WriteString("&strict=true")
	}
	return c.getJSON(b.String())
}

// FetchPlaylist fetches the HLS master playlist bytes (for the m3u8 proxy).
func (c *Client) FetchPlaylist(playbackURL string) ([]byte, error) {
	status, body, err := c.do(fhttp.MethodGet, playbackURL, nil, map[string]string{"Origin": "https://kick.com"})
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, &HTTPError{Status: status}
	}
	return body, nil
}

// ── viewer counts ────────────────────────────────────────────────────────────

// GetViewerCount returns the viewer count for one livestream id.
func (c *Client) GetViewerCount(livestreamID int) (int, error) {
	status, body, err := c.do(fhttp.MethodGet, fmt.Sprintf("https://kick.com/current-viewers?ids[]=%d", livestreamID), nil, nil)
	if err != nil {
		return 0, err
	}
	if status < 200 || status >= 300 {
		return 0, &HTTPError{Status: status}
	}
	return parseViewerCount(body), nil
}

const batchViewerMax = 10 // Kick enforces max 10 ids per request

// GetViewerCountsBatch returns {id: viewers} for up to 50 ids, chunked into
// max-10 requests fired in parallel. Chunks that fail are skipped (matching the Python).
func (c *Client) GetViewerCountsBatch(ids []int) (map[int]int, error) {
	if len(ids) == 0 {
		return map[int]int{}, nil
	}
	if len(ids) > 50 {
		ids = ids[:50]
	}
	var chunks [][]int
	for i := 0; i < len(ids); i += batchViewerMax {
		end := i + batchViewerMax
		if end > len(ids) {
			end = len(ids)
		}
		chunks = append(chunks, ids[i:end])
	}

	results := make([]map[int]int, len(chunks))
	var wg sync.WaitGroup
	for i, chunk := range chunks {
		wg.Add(1)
		go func(i int, chunk []int) {
			defer wg.Done()
			parts := make([]string, len(chunk))
			for j, id := range chunk {
				parts[j] = fmt.Sprintf("ids[]=%d", id)
			}
			status, body, err := c.do(fhttp.MethodGet, "https://kick.com/current-viewers?"+strings.Join(parts, "&"), nil, nil)
			if err != nil || status < 200 || status >= 300 {
				return
			}
			results[i] = parseBatchViewers(body)
		}(i, chunk)
	}
	wg.Wait()

	merged := map[int]int{}
	for _, r := range results {
		for k, v := range r {
			merged[k] = v
		}
	}
	return merged, nil
}

// parseViewerCount extracts data[0].viewers from a current-viewers response,
// tolerating empty / non-JSON bodies (returns 0).
func parseViewerCount(body []byte) int {
	if len(bytes.TrimSpace(body)) == 0 {
		return 0
	}
	var data []map[string]any
	if err := json.Unmarshal(body, &data); err != nil || len(data) == 0 {
		return 0
	}
	if v, ok := data[0]["viewers"].(float64); ok {
		return int(v)
	}
	return 0
}

// parseBatchViewers maps livestream_id → viewers from a batch response.
func parseBatchViewers(body []byte) map[int]int {
	out := map[int]int{}
	if len(bytes.TrimSpace(body)) == 0 {
		return out
	}
	var data []map[string]any
	if err := json.Unmarshal(body, &data); err != nil {
		return out
	}
	for _, item := range data {
		id, ok := item["livestream_id"].(float64)
		if !ok {
			continue
		}
		viewers, _ := item["viewers"].(float64)
		out[int(id)] = int(viewers)
	}
	return out
}

// ── Typesense search ─────────────────────────────────────────────────────────

const (
	typesenseURL         = "https://search.kick.com"
	typesenseKeyFallback = "nXIMW0iEN6sMujFYjFuhdrSwVow3pDQu"
	typesenseKeyTTL      = 24 * time.Hour
)

var typesenseKeyPattern = regexp.MustCompile(`(?:TYPESENSE_API_KEY|typesenseApiKey|apiKey)[^\w"']{0,10}["']([A-Za-z0-9]{20,50})["']`)
var nextChunkPattern = regexp.MustCompile(`/_next/static/chunks/[^\s"'<>]+\.js`)

// GetTypesenseKey returns a valid Typesense key: cached (24h) → fresh bundle
// scrape → hard fallback. Concurrency-safe.
//
// The mutex is released before the network scrape so concurrent search
// requests don't serialise behind it (fetchTypesenseKeyFromBundle makes up to
// 26 HTTP round-trips). Two goroutines may scrape simultaneously when the key
// expires — both will write a valid key, and the last write wins, which is
// harmless. This trades one redundant scrape per expiry for no mutex contention.
func (c *Client) GetTypesenseKey(forceRefresh bool) string {
	c.tsMu.Lock()
	if !forceRefresh && c.tsKey != "" && time.Since(c.tsFetchedAt) < typesenseKeyTTL {
		key := c.tsKey
		c.tsMu.Unlock()
		return key
	}
	c.tsMu.Unlock()

	// Fetch outside the lock — this is the slow path (HTTP requests).
	fresh := c.fetchTypesenseKeyFromBundle()

	c.tsMu.Lock()
	defer c.tsMu.Unlock()
	c.tsFetchedAt = time.Now()
	if fresh != "" {
		c.tsKey = fresh
		return fresh
	}
	if c.tsKey != "" {
		return c.tsKey // keep previous valid key on scrape failure
	}
	c.tsKey = typesenseKeyFallback
	return typesenseKeyFallback
}

// invalidateTypesenseKey clears the cached key (on 401/403).
func (c *Client) invalidateTypesenseKey() {
	c.tsMu.Lock()
	c.tsKey = ""
	c.tsMu.Unlock()
}

// fetchTypesenseKeyFromBundle scrapes Kick's Next.js JS chunks for the key.
func (c *Client) fetchTypesenseKeyFromBundle() string {
	status, body, err := c.do(fhttp.MethodGet, "https://kick.com/", nil, map[string]string{"Accept": "text/html"})
	if err != nil || status < 200 || status >= 300 {
		return ""
	}
	paths := dedupe(nextChunkPattern.FindAllString(string(body), -1))
	// Prioritise app/webpack chunks, then numbered chunks, then the rest.
	sort.SliceStable(paths, func(i, j int) bool { return chunkRank(paths[i]) < chunkRank(paths[j]) })
	if len(paths) > 25 {
		paths = paths[:25]
	}
	for _, p := range paths {
		st, b, err := c.do(fhttp.MethodGet, "https://kick.com"+p, nil, map[string]string{"Accept": "*/*"})
		if err != nil || st < 200 || st >= 300 {
			continue
		}
		if m := typesenseKeyPattern.FindSubmatch(b); m != nil {
			return string(m[1])
		}
	}
	return ""
}

func chunkRank(p string) int {
	if strings.Contains(p, "pages/_app") || strings.Contains(p, "webpack") {
		return 0
	}
	if regexp.MustCompile(`/\d{3}-`).MatchString(p) {
		return 1
	}
	return 2
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := in[:0:0]
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// SearchChannelsTypesense searches channels, live first then offline, retrying
// once with a fresh key on 401/403.
func (c *Client) SearchChannelsTypesense(query string) ([]map[string]any, error) {
	payload := map[string]any{"searches": []map[string]any{
		{"q": query, "collection": "channel", "query_by": "username", "filter_by": "is_live:true", "sort_by": "followers_count:desc", "per_page": 8},
		{"q": query, "collection": "channel", "query_by": "username", "sort_by": "followers_count:desc", "per_page": 8},
	}}
	bodyBytes, _ := json.Marshal(payload)

	for attempt := 0; attempt < 2; attempt++ {
		key := c.GetTypesenseKey(attempt > 0)
		headers := map[string]string{
			"x-typesense-api-key": key,
			"Content-Type":        "application/json",
			"Accept":              "application/json",
			"Referer":             "https://kick.com/",
			"Origin":              "https://kick.com",
		}
		status, body, err := c.do(fhttp.MethodPost, typesenseURL+"/multi_search", bytes.NewReader(bodyBytes), headers)
		if err != nil {
			return nil, err
		}
		if status == 401 || status == 403 {
			c.invalidateTypesenseKey()
			if attempt == 0 {
				continue
			}
			return nil, &HTTPError{Status: status}
		}
		if status < 200 || status >= 300 {
			return nil, &HTTPError{Status: status}
		}
		var data map[string]any
		if err := json.Unmarshal(body, &data); err != nil {
			return nil, err
		}
		return mergeTypesenseHits(data), nil
	}
	return []map[string]any{}, nil
}

// mergeTypesenseHits flattens results into deduped channel rows (max 8).
func mergeTypesenseHits(data map[string]any) []map[string]any {
	seen := map[string]bool{}
	merged := []map[string]any{}
	results, _ := data["results"].([]any)
	for _, res := range results {
		rm, _ := res.(map[string]any)
		hits, _ := rm["hits"].([]any)
		for _, h := range hits {
			hm, _ := h.(map[string]any)
			doc, _ := hm["document"].(map[string]any)
			slug, _ := doc["slug"].(string)
			if slug == "" || seen[slug] {
				continue
			}
			seen[slug] = true
			username := slug
			if u, ok := doc["username"].(string); ok && u != "" {
				username = u
			}
			pic := doc["profile_picture"]
			if pic == nil {
				pic = doc["profile_pic"]
			}
			merged = append(merged, map[string]any{
				"slug":            slug,
				"username":        username,
				"followers_count": orDefault(doc["followers_count"], float64(0)),
				"is_live":         orDefault(doc["is_live"], false),
				"verified":        orDefault(doc["verified"], false),
				"profile_picture": pic,
			})
			if len(merged) >= 8 {
				return merged
			}
		}
	}
	return merged
}

func orDefault(v any, def any) any {
	if v == nil {
		return def
	}
	return v
}
