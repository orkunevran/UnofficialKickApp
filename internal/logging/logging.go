// Package logging configures the structured logger. It mirrors the Python
// behaviour: human-readable text by default, single-line JSON when
// LOG_FORMAT_JSON is set (config.LogFormatJSON), with the level taken from
// LOG_LEVEL.
package logging

import (
	"log/slog"
	"os"
	"strings"
)

// Setup builds a slog.Logger for the given level and format and installs it as
// the process default.
func Setup(level string, jsonFormat bool) *slog.Logger {
	opts := &slog.HandlerOptions{Level: parseLevel(level)}
	var handler slog.Handler
	if jsonFormat {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	} else {
		handler = slog.NewTextHandler(os.Stdout, opts)
	}
	logger := slog.New(handler)
	slog.SetDefault(logger)
	return logger
}

func parseLevel(level string) slog.Level {
	switch strings.ToUpper(strings.TrimSpace(level)) {
	case "DEBUG":
		return slog.LevelDebug
	case "WARNING", "WARN":
		return slog.LevelWarn
	case "ERROR", "CRITICAL":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
