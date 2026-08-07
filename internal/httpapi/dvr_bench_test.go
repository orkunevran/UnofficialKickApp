package httpapi

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// benchRecordingPlaylist builds a media playlist the size Kick serves for a long
// broadcast: one 12.5s segment per line, bare relative URIs, a per-segment
// EXT-X-PROGRAM-DATE-TIME, and the ENDLIST tag Kick writes mid-broadcast.
func benchRecordingPlaylist(segments int) []byte {
	var b strings.Builder
	b.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:13\n")
	fmt.Fprintf(&b, "#ID3-EQUIV-TDTG:%s\n", time.Now().UTC().Format("2006-01-02T15:04:05"))
	b.WriteString("#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MEDIA-SEQUENCE:0\n")
	start := time.Date(2026, 7, 27, 9, 0, 1, 0, time.UTC)
	for i := 0; i < segments; i++ {
		fmt.Fprintf(&b, "#EXT-X-PROGRAM-DATE-TIME:%s\n#EXTINF:12.500,\n%d.ts\n",
			start.Add(time.Duration(i)*12500*time.Millisecond).Format("2006-01-02T15:04:05.000Z"), i)
	}
	b.WriteString("#EXT-X-ENDLIST\n")
	return []byte(b.String())
}

// 1800 segments ≈ 6¼ hours, an ordinary Kick broadcast length.
const benchSegments = 1800

func BenchmarkRewriteDVRPlaylist(b *testing.B) {
	body := benchRecordingPlaylist(benchSegments)
	url := dvrBase + "720p60/playlist.m3u8"
	b.ReportAllocs()
	b.SetBytes(int64(len(body)))
	for i := 0; i < b.N; i++ {
		out := rewriteDVRPlaylist(url, body, true)
		if len(out) == 0 {
			b.Fatal("empty rewrite")
		}
	}
}

func TestRewriteDVRPlaylistSize(t *testing.T) {
	body := benchRecordingPlaylist(benchSegments)
	out := rewriteDVRPlaylist(dvrBase+"720p60/playlist.m3u8", body, true)
	t.Logf("upstream=%dKB  rewritten=%dKB  (%.1fx)",
		len(body)/1024, len(out)/1024, float64(len(out))/float64(len(body)))
}
