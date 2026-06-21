// Package realtime bridges Socket.IO connections to game rooms. Each connected
// socket joins exactly one room: it emits "join" {code, name}, then receives a
// "state" event on every room broadcast and may emit "start", "nextPhase", and
// "submitAnswer". Validation failures come back as an "error" {message} event.
package realtime

import (
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/zishang520/socket.io/servers/socket/v3"
	"github.com/zishang520/socket.io/v3/pkg/types"

	"skoobl/internal/game"
	"skoobl/internal/hub"
)

// NewServer builds a Socket.IO server wired to the hub. Mount its handler at
// /socket.io/ (see router). It speaks the modern Socket.IO v4 protocol, so the
// browser uses the standard socket.io-client.
//
// allowedOrigins is the cross-origin allowlist for the WebSocket/polling
// handshake. Leave it empty in production: the SPA is served same-origin behind
// nginx, so no CORS is needed. Set it only for cross-origin dev (e.g. Vite on
// :5173 hitting the backend directly).
func NewServer(h *hub.Hub, allowedOrigins []string) *socket.Server {
	// Pass a literal nil when there are no origins: a typed-nil *ServerOptions
	// becomes a non-nil interface and the library dereferences it on Construct.
	var io *socket.Server
	if len(allowedOrigins) > 0 {
		opts := socket.DefaultServerOptions()
		opts.SetCors(&types.Cors{
			Origin:      allowedOrigins,
			Credentials: true,
		})
		io = socket.NewServer(nil, opts)
	} else {
		io = socket.NewServer(nil, nil)
	}
	io.On("connection", func(clients ...any) {
		bind(h, clients[0].(*socket.Socket))
	})
	return io
}

// conn is the per-socket bridge state. A socket owns at most one room
// subscription; everything mutable is guarded by mu because Socket.IO may
// dispatch events and the disconnect callback from different goroutines.
type conn struct {
	sock *socket.Socket
	mu   sync.Mutex

	room    *game.Room
	player  string
	updates chan game.GameState
	done    chan struct{}
}

func bind(h *hub.Hub, sock *socket.Socket) {
	c := &conn{sock: sock}

	sock.On("join", func(args ...any) { c.join(h, args) })
	sock.On("configure", func(args ...any) { c.configure(args) })
	sock.On("start", func(...any) { c.submit(game.Command{Kind: game.CmdStart}) })
	sock.On("nextPhase", func(...any) { c.submit(game.Command{Kind: game.CmdNextPhase}) })
	sock.On("returnToLobby", func(...any) { c.submit(game.Command{Kind: game.CmdReturnToLobby}) })
	sock.On("submitDrawing", func(args ...any) { c.submitDrawing(args) })
	sock.On("draftDrawing", func(args ...any) { c.draftDrawing(args) })
	sock.On("submitGuess", func(args ...any) {
		c.submit(game.Command{
			Kind:    game.CmdSubmitGuess,
			Guess:   strings.TrimSpace(stringField(args, "artist")),
			GuessID: strings.TrimSpace(stringField(args, "id")),
		})
	})
	sock.On("leave", func(...any) { c.leaveRoom() })
	sock.On("disconnect", func(...any) { c.onDisconnect() })
}

func (c *conn) join(h *hub.Hub, args []any) {
	code := strings.TrimSpace(stringField(args, "code"))
	name := strings.TrimSpace(stringField(args, "name"))
	spectator := boolField(args, "spectator")
	// A playing host joins as both a player and the room owner (play=true). A
	// display host joins as a non-playing spectator. Plain players send neither.
	asHost := boolField(args, "play")

	if name == "" {
		c.emitError("Please enter a name before joining.")
		return
	}
	room, ok := h.Lookup(code)
	if !ok {
		c.emitError("Game \"" + code + "\" doesn't exist. Check the code and try again.")
		return
	}

	c.mu.Lock()
	already := c.room != nil
	c.mu.Unlock()
	if already { // ignore duplicate joins on the same socket
		return
	}

	// Submit the join and wait for the room's verdict before wiring anything up.
	updates := make(chan game.GameState, 16)
	resp := make(chan string, 1)
	room.Submit(game.Command{Kind: game.CmdJoin, Player: name, Spectator: spectator, AsHost: asHost, Subscribe: updates, Ack: resp})

	var msg string
	select {
	case msg = <-resp:
	case <-time.After(5 * time.Second):
		c.emitError("Joining timed out. Try again.")
		return
	}
	if msg != "" { // rejected: full / name taken / ended. Nothing to tear down.
		c.emitError(msg)
		return
	}

	done := make(chan struct{})
	c.mu.Lock()
	c.room, c.player, c.updates, c.done = room, name, updates, done
	c.mu.Unlock()

	// Write pump: forward every room broadcast to this socket until disconnect.
	go func() {
		for {
			select {
			case <-done:
				return
			case s := <-updates:
				_ = c.sock.Emit("state", stateMap(s))
			}
		}
	}()
}

// submit forwards a player command to the joined room, stamping it with this
// socket's player name. Commands before a successful join are dropped.
func (c *conn) submit(cmd game.Command) {
	c.mu.Lock()
	room, player := c.room, c.player
	c.mu.Unlock()
	if room == nil {
		return
	}
	cmd.Player = player
	room.Submit(cmd)
}

// configure forwards a host's lobby settings. The room ignores it unless the
// sender is the host and the game is still in the lobby, and clamps every value.
func (c *conn) configure(args []any) {
	var cfg game.Config
	if !decodeArg(args, &cfg) {
		return
	}
	c.submit(game.Command{Kind: game.CmdConfigure, Config: &cfg})
}

// submitDrawing forwards a player's strokes. The room sanitizes and bounds them.
func (c *conn) submitDrawing(args []any) {
	var payload struct {
		Strokes []game.Stroke `json:"strokes"`
	}
	if !decodeArg(args, &payload) {
		return
	}
	c.submit(game.Command{Kind: game.CmdSubmitDrawing, Strokes: payload.Strokes})
}

// draftDrawing forwards a player's in-progress strokes during the drawing phase.
// Same shape as submitDrawing, but does not lock the drawing in.
func (c *conn) draftDrawing(args []any) {
	var payload struct {
		Strokes []game.Stroke `json:"strokes"`
	}
	if !decodeArg(args, &payload) {
		return
	}
	c.submit(game.Command{Kind: game.CmdDraftDrawing, Strokes: payload.Strokes})
}

// onDisconnect tears down the room subscription when the socket drops. A single
// CmdDisconnect both unsubscribes the channel and marks the player
// not-connected (arming the room's grace timer), so a refresh or brief network
// blip doesn't eject them. Then we stop the write pump.
func (c *conn) onDisconnect() {
	c.detach(game.CmdDisconnect)
}

// leaveRoom handles an explicit Leave: the player is removed from the room
// immediately (no grace), so host promotion / reaping happen right away. The
// later socket disconnect then finds nothing attached and is a no-op.
func (c *conn) leaveRoom() {
	c.detach(game.CmdLeave)
}

// detach clears this socket's room binding and submits the given teardown
// command (CmdDisconnect for a drop, CmdLeave for an explicit leave).
func (c *conn) detach(kind game.CmdKind) {
	c.mu.Lock()
	room, player, updates, done := c.room, c.player, c.updates, c.done
	c.room, c.player, c.updates, c.done = nil, "", nil, nil
	c.mu.Unlock()
	if room == nil {
		return
	}
	room.Submit(game.Command{Kind: kind, Player: player, Unsub: updates})
	close(done)
}

func (c *conn) emitError(msg string) {
	_ = c.sock.Emit("error", map[string]any{"message": msg})
}

// stateMap converts GameState to a map via its JSON tags so the payload keys
// match the frontend protocol exactly, independent of the parser's struct
// encoding. It stamps serverNow (the server's clock at emit time) so clients can
// correct for device clock skew when rendering the phaseEndsAt countdown —
// otherwise a host whose clock differs from a player's shows a different timer.
func stateMap(s game.GameState) map[string]any {
	b, _ := json.Marshal(s)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	m["serverNow"] = time.Now().UnixMilli()
	return m
}

// decodeArg re-marshals the first event argument (a decoded JSON object) into a
// typed struct. Returns false when there's no argument to decode. This keeps the
// nested-payload parsing (strokes, config) declarative rather than groping
// through map[string]any.
func decodeArg(args []any, target any) bool {
	if len(args) == 0 {
		return false
	}
	b, err := json.Marshal(args[0])
	if err != nil {
		return false
	}
	return json.Unmarshal(b, target) == nil
}

// stringField pulls a string field from the first event argument, which the
// client sends as a JSON object (decoded to map[string]any).
func stringField(args []any, key string) string {
	if len(args) == 0 {
		return ""
	}
	m, ok := args[0].(map[string]any)
	if !ok {
		return ""
	}
	s, _ := m[key].(string)
	return s
}

// boolField pulls a bool field from the first event argument (a JSON object).
func boolField(args []any, key string) bool {
	if len(args) == 0 {
		return false
	}
	m, ok := args[0].(map[string]any)
	if !ok {
		return false
	}
	b, _ := m[key].(bool)
	return b
}
