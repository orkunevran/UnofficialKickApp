package httpapi

import (
	"bytes"
	"testing"

	"github.com/klauspost/compress/gzip"
)

// What one viewer's changed-playlist refresh costs the server today: rewrite the
// cached recording for that rendition, then compress the result. Both happen per
// request, so N viewers pay it N times for identical bytes.
func BenchmarkPlaylistResponsePerRequest(b *testing.B) {
	body := benchRecordingPlaylist(benchSegments)
	url := dvrBase + "720p60/playlist.m3u8"
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		out := rewriteDVRPlaylist(url, body, true)
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, 5) // gzhttp's default level
		_, _ = zw.Write(out)
		_ = zw.Close()
		if buf.Len() == 0 {
			b.Fatal("empty")
		}
	}
}

// The same response served from a pre-compressed copy: what it should cost.
func BenchmarkPlaylistResponsePreCompressed(b *testing.B) {
	body := benchRecordingPlaylist(benchSegments)
	out := rewriteDVRPlaylist(dvrBase+"720p60/playlist.m3u8", body, true)
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, 5)
	_, _ = zw.Write(out)
	_ = zw.Close()
	cached := buf.Bytes()

	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		sink := make([]byte, len(cached))
		copy(sink, cached)
	}
}

func TestPlaylistCompressedSize(t *testing.T) {
	body := benchRecordingPlaylist(benchSegments)
	out := rewriteDVRPlaylist(dvrBase+"720p60/playlist.m3u8", body, true)
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, 5)
	_, _ = zw.Write(out)
	_ = zw.Close()
	t.Logf("upstream=%dKB  rewritten=%dKB  gzipped=%dKB", len(body)/1024, len(out)/1024, buf.Len()/1024)
}
