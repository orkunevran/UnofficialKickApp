package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func serveRequest(app *App, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, req)
	return rec
}

func TestChromecastControlAuthentication(t *testing.T) {
	app := newParityApp(t)
	app.cfg.ControlToken = "production-secret"

	req := httptest.NewRequest(http.MethodGet, "/api/chromecast/devices", nil)
	if rec := serveRequest(app, req); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d; want 401", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/chromecast/devices", nil)
	req.Header.Set("Authorization", "Bearer production-secret")
	req.Header.Set("Origin", "http://evil.example")
	if rec := serveRequest(app, req); rec.Code != http.StatusForbidden {
		t.Fatalf("cross-origin status = %d; want 403", rec.Code)
	}
}

func TestChromecastControlSession(t *testing.T) {
	app := newParityApp(t)
	app.cfg.ControlToken = "production-secret"

	login := httptest.NewRequest(http.MethodPost, "/api/control/session", strings.NewReader(`{"token":"production-secret"}`))
	login.Host = "kick.local:8081"
	login.Header.Set("Origin", "http://kick.local:8081")
	login.Header.Set("Content-Type", "application/json")
	loginRec := serveRequest(app, login)
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login status = %d; body=%s", loginRec.Code, loginRec.Body.String())
	}
	cookies := loginRec.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("unexpected control cookie: %#v", cookies)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/chromecast/devices", nil)
	req.AddCookie(cookies[0])
	if rec := serveRequest(app, req); rec.Code != http.StatusOK {
		t.Fatalf("cookie-authenticated status = %d; want 200", rec.Code)
	}
}

func TestChromecastControlRequestValidation(t *testing.T) {
	app := newParityApp(t)
	app.cfg.ControlToken = "production-secret"

	t.Run("content type", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/chromecast/select", strings.NewReader(`{"uuid":"device-1"}`))
		req.Header.Set("Authorization", "Bearer production-secret")
		req.Header.Set("Content-Type", "text/plain")
		if rec := serveRequest(app, req); rec.Code != http.StatusUnsupportedMediaType {
			t.Fatalf("status = %d; want 415", rec.Code)
		}
	})

	t.Run("oversized", func(t *testing.T) {
		app.cfg.MaxJSONBodyBytes = 32
		body := `{"uuid":"` + strings.Repeat("x", 64) + `"}`
		req := httptest.NewRequest(http.MethodPost, "/api/chromecast/select", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer production-secret")
		req.Header.Set("Content-Type", "application/json")
		if rec := serveRequest(app, req); rec.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d; want 413; body=%s", rec.Code, rec.Body.String())
		}
	})

	t.Run("trailing JSON", func(t *testing.T) {
		app.cfg.MaxJSONBodyBytes = 16384
		req := httptest.NewRequest(http.MethodPost, "/api/chromecast/select", bytes.NewBufferString(`{"uuid":"device-1"} {}`))
		req.Header.Set("Authorization", "Bearer production-secret")
		req.Header.Set("Content-Type", "application/json")
		if rec := serveRequest(app, req); rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d; want 400", rec.Code)
		}
	})
}

func TestNormalizedCacheKeys(t *testing.T) {
	app := newParityApp(t)
	first := doReq(app, http.MethodGet, "/streams/featured-livestreams?language=en&page=1&unused=one", nil)
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d", first.Code)
	}
	before := app.cache.Stats().HitCount
	second := doReq(app, http.MethodGet, "/streams/featured-livestreams?unused=two&page=1&language=en", nil)
	if second.Code != http.StatusOK {
		t.Fatalf("second status = %d", second.Code)
	}
	if after := app.cache.Stats().HitCount; after <= before {
		t.Fatalf("semantically equivalent query did not hit cache: before=%d after=%d", before, after)
	}
}

func TestIPRateLimiter(t *testing.T) {
	limiter := newIPRateLimiter(1, 2)
	now := time.Now()
	if !limiter.allow("192.0.2.1", now) || !limiter.allow("192.0.2.1", now) {
		t.Fatal("initial burst should be allowed")
	}
	if limiter.allow("192.0.2.1", now) {
		t.Fatal("request beyond burst should be rejected")
	}
	if !limiter.allow("192.0.2.1", now.Add(time.Second)) {
		t.Fatal("token should refill")
	}
}
