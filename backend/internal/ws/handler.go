package ws

import (
	"net/http"

	"github.com/coder/websocket"

	"skoobl/internal/hub"
)

// Handler returns an http.Handler that upgrades /ws?code=<code> requests and
// serves them against the matching room. allowedOrigins controls the WebSocket
// origin check: empty ⇒ same-origin only (coder/websocket default); non-empty ⇒
// those host patterns are also accepted (used for cross-origin dev).
func Handler(h *hub.Hub, allowedOrigins []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		room, ok := h.Lookup(code)
		if !ok {
			http.Error(w, "game not found", http.StatusNotFound)
			return
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			OriginPatterns: allowedOrigins,
		})
		if err != nil {
			// Accept already wrote the HTTP error response (e.g. 403 on a
			// rejected origin); writing another would panic on a double-write.
			return
		}
		defer conn.CloseNow()
		serve(r.Context(), conn, room, code)
	}
}
