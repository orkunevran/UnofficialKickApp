// Package buildinfo exposes metadata injected into production binaries with
// -ldflags. Development builds retain explicit, useful defaults.
package buildinfo

var (
	Version = "dev"
	Commit  = "unknown"
	BuiltAt = "unknown"
)

// Snapshot returns a stable JSON-ready representation of the running binary.
func Snapshot() map[string]string {
	return map[string]string{
		"version":  Version,
		"commit":   Commit,
		"built_at": BuiltAt,
	}
}
