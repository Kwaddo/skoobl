// Package router wires the chi router, middleware, and all handlers.
package router

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/zishang520/socket.io/servers/socket/v3"

	"skoobl/internal/httpapi"
	"skoobl/internal/hub"
)

// New builds the application router. The Socket.IO server is mounted at
// /socket.io/; REST lives alongside it. The app is served same-origin in dev
// (Vite proxy) and prod (nginx), so allowedOrigins is normally empty and no
// CORS headers are emitted. Set it only for cross-origin dev; Socket.IO CORS is
// configured separately on the server (see realtime.NewServer).
func New(h *hub.Hub, io *socket.Server, allowedOrigins []string) http.Handler {
	api := httpapi.New(h)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Logger)

	// CORS for REST when an allowlist is set. Installed top-level (not in a
	// route group) so it also runs for preflight OPTIONS, which chi otherwise
	// answers with 405 before any route-scoped middleware. The middleware skips
	// /socket.io/, which does its own CORS (see realtime.NewServer).
	if len(allowedOrigins) > 0 {
		r.Use(corsMiddleware(allowedOrigins))
	}

	r.Get("/healthz", api.Healthz)
	r.Post("/games", api.CreateGame)
	r.Handle("/socket.io/*", io.ServeHandler(nil))
	return r
}

// corsMiddleware reflects the request Origin when it is in the allowlist and
// answers preflight OPTIONS requests. Requests under /socket.io/ pass straight
// through — the Socket.IO server sets its own CORS headers. Same-origin deploys
// pass no allowlist and never install this.
func corsMiddleware(allowed []string) func(http.Handler) http.Handler {
	set := make(map[string]struct{}, len(allowed))
	for _, o := range allowed {
		set[o] = struct{}{}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/socket.io/") {
				next.ServeHTTP(w, r)
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				if _, ok := set[origin]; ok {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Add("Vary", "Origin")
					w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
					w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
				}
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
