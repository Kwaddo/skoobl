// Package httpapi holds the non-WebSocket HTTP endpoints.
package httpapi

import (
	"encoding/json"
	"net/http"

	"skoobl/internal/hub"
)

type API struct {
	hub *hub.Hub
}

func New(h *hub.Hub) *API { return &API{hub: h} }

// CreateGame makes a new room and returns its code.
func (a *API) CreateGame(w http.ResponseWriter, r *http.Request) {
	code, _ := a.hub.Create()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"code": code})
}

// Healthz is a liveness probe.
func (a *API) Healthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}
