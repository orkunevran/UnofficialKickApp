package httpapi

import (
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// The index template uses two Jinja constructs only (verified against
// templates/index.html): url_for('static', filename='X') for hash-busted asset
// URLs, and a single {% for _ in range(N) %}...{% endfor %} loop. We reproduce
// both exactly rather than pulling in a templating engine, so the one
// index.html stays shared with the Python app during the migration.
var (
	urlForRe = regexp.MustCompile(`\{\{\s*url_for\(\s*'static'\s*,\s*filename\s*=\s*'([^']*)'\s*,?\s*\)\s*\}\}`)
	rangeRe  = regexp.MustCompile(`(?s)\{%\s*for\s+_\s+in\s+range\((\d+)\)\s*%\}(.*?)\{%\s*endfor\s*%\}`)
)

// computeStaticHashes walks the embedded static tree and returns
// relative-path → 8-char MD5, for .js/.css/.svg files. Mirrors
// _compute_static_hashes in app.py.
func computeStaticHashes(staticFS fs.FS) (map[string]string, error) {
	hashes := make(map[string]string)
	err := fs.WalkDir(staticFS, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		switch path.Ext(p) {
		case ".js", ".css", ".svg":
			b, err := fs.ReadFile(staticFS, p)
			if err != nil {
				return err
			}
			sum := md5.Sum(b)
			hashes[p] = hex.EncodeToString(sum[:])[:8]
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return hashes, nil
}

// renderIndex reproduces the Jinja output of index.html: expands the range
// loop and rewrites url_for('static', ...) into /static/<file>?h=<hash> URLs.
func renderIndex(tmpl string, hashes map[string]string) string {
	out := rangeRe.ReplaceAllStringFunc(tmpl, func(m string) string {
		sub := rangeRe.FindStringSubmatch(m)
		n, _ := strconv.Atoi(sub[1])
		return strings.Repeat(sub[2], n)
	})
	out = urlForRe.ReplaceAllStringFunc(out, func(m string) string {
		sub := urlForRe.FindStringSubmatch(m)
		file := sub[1]
		url := "/static/" + file
		if h, ok := hashes[file]; ok {
			url = fmt.Sprintf("%s?h=%s", url, h)
		}
		return url
	})
	return out
}
