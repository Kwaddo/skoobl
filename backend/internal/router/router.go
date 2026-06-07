// Package router wires the chi router, middleware, and all handlers.
package router

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/zishang520/socket.io/servers/socket/v3"

	"skoobl/internal/httpapi"
	"skoobl/internal/hub"
)

// New builds the application router. The Socket.IO server is mounted at
// /socket.io/; REST lives alongside it. The app is served same-origin in dev
// (Vite proxy) and prod (nginx), so no CORS handling is needed here.
func New(h *hub.Hub, io *socket.Server) http.Handler {
	api := httpapi.New(h)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Logger)

	r.Get("/healthz", api.Healthz)
	r.Post("/games", api.CreateGame)
	r.Handle("/socket.io/*", io.ServeHandler(nil))
	return r
}
