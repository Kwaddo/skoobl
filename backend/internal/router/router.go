// Package router wires the chi router, middleware, and all handlers.
package router

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"skoobl/internal/httpapi"
	"skoobl/internal/hub"
	"skoobl/internal/ws"
)

// New builds the application router. allowedOrigins controls CORS: empty ⇒ no
// CORS headers (same-origin prod behind a reverse proxy); non-empty ⇒ a matching
// Origin is reflected (cross-origin dev).
func New(h *hub.Hub, allowedOrigins []string) http.Handler {
	api := httpapi.New(h)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Logger)
	r.Use(corsMiddleware(allowedOrigins))

	r.Get("/healthz", api.Healthz)
	r.Post("/games", api.CreateGame)
	r.Handle("/ws", ws.Handler(h, hostsOf(allowedOrigins)))
	return r
}

// corsMiddleware reflects an allowed Origin. With an empty list it is a no-op,
// leaving same-origin requests untouched.
func corsMiddleware(allowed []string) func(http.Handler) http.Handler {
	allowedSet := make(map[string]bool, len(allowed))
	for _, o := range allowed {
		allowedSet[o] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && allowedSet[origin] {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
				w.Header().Set("Vary", "Origin")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// hostsOf strips the scheme from full origins so they can be used as WS
// OriginPatterns, which match the Origin host rather than the full URL.
// CORS keeps the full origins; the WS check gets the host form.
func hostsOf(origins []string) []string {
	if len(origins) == 0 {
		return nil
	}
	out := make([]string, 0, len(origins))
	for _, o := range origins {
		host := o
		if i := strings.Index(host, "://"); i >= 0 {
			host = host[i+3:]
		}
		out = append(out, host)
	}
	return out
}
