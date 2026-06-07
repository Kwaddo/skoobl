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

	"skoobl/internal/game"
	"skoobl/internal/hub"
)

// NewServer builds a Socket.IO server wired to the hub. Mount its handler at
// /socket.io/ (see router). It speaks the modern Socket.IO v4 protocol, so the
// browser uses the standard socket.io-client.
func NewServer(h *hub.Hub) *socket.Server {
	io := socket.NewServer(nil, nil)
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
	sock.On("start", func(...any) { c.submit(game.CmdStart, "") })
	sock.On("nextPhase", func(...any) { c.submit(game.CmdNextPhase, "") })
	sock.On("submitAnswer", func(args ...any) {
		c.submit(game.CmdSubmitAnswer, stringField(args, "answer"))
	})
	sock.On("disconnect", func(...any) { c.leave() })
}

func (c *conn) join(h *hub.Hub, args []any) {
	code := strings.TrimSpace(stringField(args, "code"))
	name := strings.TrimSpace(stringField(args, "name"))

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
	room.Submit(game.Command{Kind: game.CmdJoin, Player: name, Subscribe: updates, Ack: resp})

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

// submit forwards a player command to the joined room. Commands before a
// successful join are dropped.
func (c *conn) submit(kind game.CmdKind, answer string) {
	c.mu.Lock()
	room, player := c.room, c.player
	c.mu.Unlock()
	if room == nil {
		return
	}
	room.Submit(game.Command{Kind: kind, Player: player, Answer: answer})
}

// leave tears down the room subscription on disconnect. A single CmdDisconnect
// both unsubscribes the channel and marks the player not-connected (arming the
// room's grace timer), then we stop the write pump.
func (c *conn) leave() {
	c.mu.Lock()
	room, player, updates, done := c.room, c.player, c.updates, c.done
	c.room, c.player, c.updates, c.done = nil, "", nil, nil
	c.mu.Unlock()
	if room == nil {
		return
	}
	room.Submit(game.Command{Kind: game.CmdDisconnect, Player: player, Unsub: updates})
	close(done)
}

func (c *conn) emitError(msg string) {
	_ = c.sock.Emit("error", map[string]any{"message": msg})
}

// stateMap converts GameState to a map via its JSON tags so the payload keys
// match the frontend protocol exactly, independent of the parser's struct
// encoding.
func stateMap(s game.GameState) map[string]any {
	b, _ := json.Marshal(s)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
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
