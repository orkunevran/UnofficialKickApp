// Package apierr defines the API error type and the upstream-status mapping,
// porting api/errors.py (ApiError + requests_exception_to_api_error).
package apierr

import "fmt"

// Error carries a client-facing message and the HTTP status to return.
type Error struct {
	Message string
	Status  int
}

func (e *Error) Error() string { return e.Message }

// New builds an Error.
func New(message string, status int) *Error {
	return &Error{Message: message, Status: status}
}

// FromUpstreamStatus maps an upstream HTTP status to a client-facing Error,
// matching the HTTPError branch of requests_exception_to_api_error.
func FromUpstreamStatus(status int, safeValue string) *Error {
	switch status {
	case 404:
		return &Error{Message: fmt.Sprintf("Kick channel '%s' not found.", safeValue), Status: 404}
	case 429:
		return &Error{Message: "Rate limited by upstream service. Try again shortly.", Status: 429}
	default:
		return &Error{Message: "Failed to fetch data from streaming service.", Status: status}
	}
}

// Transport maps a connection/timeout error (no HTTP response) to a 500,
// matching the ConnectionError/Timeout branch.
func Transport() *Error {
	return &Error{Message: "Error communicating with streaming service.", Status: 500}
}
