package router

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"skoobl/internal/hub"
	"skoobl/internal/realtime"
)

func newRouter() http.Handler {
	h := hub.New()
	return New(h, realtime.NewServer(h, nil), nil, "")
}

func TestHealthzOK(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	newRouter().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("healthz status = %d, want 200", rec.Code)
	}
}

func TestCreateGameReturnsCode(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/games", nil)
	rec := httptest.NewRecorder()
	newRouter().ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /games status = %d, want 201", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct == "" {
		t.Fatalf("POST /games missing Content-Type")
	}
}

func TestSocketIOMounted(t *testing.T) {
	// The Engine.IO handshake rejects a bare GET with 400 (not 404), proving the
	// handler is mounted at /socket.io/.
	req := httptest.NewRequest(http.MethodGet, "/socket.io/", nil)
	rec := httptest.NewRecorder()
	newRouter().ServeHTTP(rec, req)
	if rec.Code == http.StatusNotFound {
		t.Fatalf("/socket.io/ not mounted: got 404")
	}
}

func corsRouter() http.Handler {
	h := hub.New()
	origins := []string{"http://localhost:5173"}
	return New(h, realtime.NewServer(h, origins), origins, "")
}

func TestCORSReflectsAllowedOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/games", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rec := httptest.NewRecorder()
	corsRouter().ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want the request origin", got)
	}
}

func TestCORSPreflightShortCircuits(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/games", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rec := httptest.NewRecorder()
	corsRouter().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", rec.Code)
	}
}

func TestCORSRejectsUnknownOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/games", nil)
	req.Header.Set("Origin", "http://evil.example")
	rec := httptest.NewRecorder()
	corsRouter().ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want empty for non-allowlisted origin", got)
	}
}

func TestNoCORSHeadersWhenSameOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/games", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rec := httptest.NewRecorder()
	newRouter().ServeHTTP(rec, req) // nil allowlist
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want empty when no allowlist configured", got)
	}
}
