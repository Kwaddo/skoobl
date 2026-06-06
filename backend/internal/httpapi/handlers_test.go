package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"skoobl/internal/hub"
)

func TestCreateGameReturnsCode(t *testing.T) {
	h := hub.New()
	api := New(h)

	req := httptest.NewRequest(http.MethodPost, "/games", nil)
	rec := httptest.NewRecorder()
	api.CreateGame(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201", rec.Code)
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Code) != 6 {
		t.Fatalf("code = %q, want 6 hex chars", body.Code)
	}
	if _, ok := h.Lookup(body.Code); !ok {
		t.Fatal("created code not registered in hub")
	}
}

func TestHealthz(t *testing.T) {
	api := New(hub.New())
	rec := httptest.NewRecorder()
	api.Healthz(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}
