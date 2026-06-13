package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// envelope is the uniform response body: {status, message, data}, matching
// success_json / error_json in api/errors.py.
type envelope struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	Data    any    `json:"data"`
}

// writeJSON serialises v as JSON with the given status code.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("failed to encode JSON response", "error", err)
	}
}

// successJSON writes the success envelope. A nil data becomes {} for parity
// with the Python helper.
func successJSON(w http.ResponseWriter, data any, message string, status int) {
	if data == nil {
		data = map[string]any{}
	}
	writeJSON(w, status, envelope{Status: "success", Message: message, Data: data})
}

// errorJSON writes the error envelope with an empty data object.
func errorJSON(w http.ResponseWriter, message string, status int) {
	writeJSON(w, status, envelope{Status: "error", Message: message, Data: map[string]any{}})
}
