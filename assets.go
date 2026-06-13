// Package kickapi exposes the embedded web assets (static files and HTML
// templates) so the Go server runs as a single self-contained binary,
// mirroring the directories the Python app serves from disk.
package kickapi

import "embed"

// Assets holds the static/ and templates/ directories, embedded at build time.
//
//go:embed static templates
var Assets embed.FS
