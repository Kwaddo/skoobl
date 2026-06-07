package game

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"
)

// CmdKind enumerates the mutations a Room accepts.
type CmdKind int

const (
	CmdJoin CmdKind = iota
	CmdDisconnect
	CmdStart
	CmdSubmitAnswer
	CmdNextPhase
	CmdPrune
	CmdReapIfEmpty
)

// Tunables.
const (
	// DefaultGrace is how long a disconnected player (or a never-populated room)
	// is kept before being pruned/reaped. Survives refreshes and brief drops.
	DefaultGrace = 60 * time.Second
	// maxPlayers caps a single room.
	maxPlayers = 12
)

// presence is per-player liveness, kept out of the serialized GameState.
type presence struct {
	connected bool
	gen       int // bumped each disconnect; stale prune timers self-cancel
}

// Command is a single mutation request delivered to a Room's goroutine.
type Command struct {
	Kind      CmdKind
	Player    string
	Answer    string
	Subscribe chan GameState // join: per-client broadcast channel
	Unsub     chan GameState // disconnect: channel to drop from the sub set
	Ack       chan string    // join: "" on accept, else a rejection message
	Gen       int            // prune: presence generation captured when armed
}

// Snapshotter persists a room's serialized state. Implemented by
// store.RedisStore. A nil Snapshotter disables persistence (in-memory mode).
type Snapshotter interface {
	SaveSnapshot(ctx context.Context, code string, data []byte) error
}

// Room owns its GameState and is the only goroutine that touches it.
type Room struct {
	state   GameState
	cmds    chan Command
	done    chan struct{}
	subs    []chan GameState
	snap    Snapshotter
	present map[string]*presence

	grace      time.Duration
	onReap     func()
	emptyTimer *time.Timer
	stopOnce   sync.Once
}

// RoomOption configures a Room at construction.
type RoomOption func(*Room)

// WithSnapshotter enables persistence.
func WithSnapshotter(s Snapshotter) RoomOption { return func(r *Room) { r.snap = s } }

// WithReaper sets the callback invoked when the room shuts itself down (empty).
// It runs on the room goroutine, so it must not block or Submit to this room.
func WithReaper(fn func()) RoomOption { return func(r *Room) { r.onReap = fn } }

// WithGrace overrides the disconnect/empty grace period (tests use a tiny value).
func WithGrace(d time.Duration) RoomOption { return func(r *Room) { r.grace = d } }

func newRoom(state GameState, opts ...RoomOption) *Room {
	r := &Room{
		state:   state,
		cmds:    make(chan Command, 32),
		done:    make(chan struct{}),
		present: map[string]*presence{},
		grace:   DefaultGrace,
	}
	for _, opt := range opts {
		opt(r)
	}
	return r
}

// NewRoom creates an unstarted in-memory room. Call Run in a goroutine.
func NewRoom(code string, opts ...RoomOption) *Room {
	return newRoom(newGameState(code), opts...)
}

// NewRoomFromSnapshot rebuilds a room from previously persisted state.
func NewRoomFromSnapshot(code string, data []byte, opts ...RoomOption) (*Room, error) {
	var gs GameState
	if err := json.Unmarshal(data, &gs); err != nil {
		return nil, err
	}
	gs.Code = code
	if gs.Players == nil {
		gs.Players = []Player{}
	}
	return newRoom(gs, opts...), nil
}

// Submit enqueues a command. Safe from any goroutine.
func (r *Room) Submit(c Command) {
	select {
	case r.cmds <- c:
	case <-r.done:
	}
}

// Stop tears the room down. Idempotent.
func (r *Room) Stop() { r.stopOnce.Do(func() { close(r.done) }) }

// Run is the actor loop. Single-threaded over r.state — no locks needed.
func (r *Room) Run() {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("room %s panic recovered: %v", r.state.Code, rec)
		}
	}()
	r.onStart()
	for {
		select {
		case <-r.done:
			return
		case c := <-r.cmds:
			r.handle(c)
			if r.isDone() {
				return // reaped inside handle; skip broadcast/persist
			}
			r.broadcast()
			r.persist()
		}
	}
}

// onStart arms the initial grace timers. A never-populated room gets an empty
// timer; a snapshot-restored room starts everyone disconnected (in grace), so
// abandoned restored rooms reap while reconnecting clients save themselves.
func (r *Room) onStart() {
	if len(r.state.Players) == 0 {
		r.armEmptyTimer()
		return
	}
	for _, p := range r.state.Players {
		pr := &presence{connected: false, gen: 1}
		r.present[p.Name] = pr
		r.armPrune(p.Name, pr.gen)
	}
}

func (r *Room) armEmptyTimer() {
	r.emptyTimer = time.AfterFunc(r.grace, func() {
		r.Submit(Command{Kind: CmdReapIfEmpty})
	})
}

func (r *Room) cancelEmptyTimer() {
	if r.emptyTimer != nil {
		r.emptyTimer.Stop()
		r.emptyTimer = nil
	}
}

func (r *Room) armPrune(name string, gen int) {
	time.AfterFunc(r.grace, func() {
		r.Submit(Command{Kind: CmdPrune, Player: name, Gen: gen})
	})
}

func (r *Room) isDone() bool {
	select {
	case <-r.done:
		return true
	default:
		return false
	}
}

func (r *Room) handle(c Command) {
	switch c.Kind {
	case CmdJoin:
		r.join(c)
	case CmdDisconnect:
		r.disconnect(c)
	case CmdPrune:
		r.prune(c)
	case CmdReapIfEmpty:
		if len(r.state.Players) == 0 {
			r.reap()
		}
	case CmdStart:
		if c.Player == r.state.Host && r.state.Phase == PhaseLobby {
			r.state.Phase = PhaseInRound
		}
	case CmdSubmitAnswer:
		if r.state.Phase != PhaseInRound {
			return
		}
		if i := r.state.playerIndex(c.Player); i >= 0 {
			r.state.Players[i].Answer = c.Answer
		}
	case CmdNextPhase:
		if c.Player != r.state.Host {
			return
		}
		r.advance()
	}
}

func (r *Room) join(c Command) {
	name := c.Player
	if r.state.Phase == PhaseEnded {
		ack(c, "This game has already ended.")
		return
	}
	if p, ok := r.present[name]; ok {
		if p.connected {
			ack(c, "That name's already taken in this room.")
			return
		}
		// Reconnect: same name returning while marked disconnected.
		p.connected = true
		p.gen++ // invalidate the pending prune
		r.addSub(c.Subscribe)
		ack(c, "")
		return
	}
	if len(r.state.Players) >= maxPlayers {
		ack(c, "This room is full.")
		return
	}
	if r.state.Host == "" {
		r.state.Host = name
	}
	r.state.Players = append(r.state.Players, Player{Name: name})
	r.present[name] = &presence{connected: true}
	r.addSub(c.Subscribe)
	r.cancelEmptyTimer()
	ack(c, "")
}

func (r *Room) disconnect(c Command) {
	r.unsubscribe(c.Unsub)
	p, ok := r.present[c.Player]
	if !ok || !p.connected {
		return
	}
	p.connected = false
	p.gen++
	r.armPrune(c.Player, p.gen)
}

func (r *Room) prune(c Command) {
	p, ok := r.present[c.Player]
	if !ok || p.connected || p.gen != c.Gen {
		return // reconnected, already gone, or a stale timer
	}
	delete(r.present, c.Player)
	if i := r.state.playerIndex(c.Player); i >= 0 {
		wasHost := r.state.Host == c.Player
		r.state.Players = append(r.state.Players[:i], r.state.Players[i+1:]...)
		if wasHost {
			if len(r.state.Players) > 0 {
				r.state.Host = r.state.Players[0].Name // promote longest-present
			} else {
				r.state.Host = ""
			}
		}
	}
	if len(r.state.Players) == 0 {
		r.reap()
	}
}

// reap shuts the room down: tell the hub to drop it, then stop the loop.
func (r *Room) reap() {
	if r.onReap != nil {
		r.onReap()
	}
	r.Stop()
}

func (r *Room) advance() {
	switch r.state.Phase {
	case PhaseInRound:
		r.state.Phase = PhaseReveal
	case PhaseReveal:
		r.state.Phase = PhaseEnded
	}
}

func (r *Room) addSub(ch chan GameState) {
	if ch != nil {
		r.subs = append(r.subs, ch)
	}
}

// ack sends the join outcome on c.Ack if present (buffered, never blocks).
func ack(c Command, msg string) {
	if c.Ack != nil {
		c.Ack <- msg
	}
}

// unsubscribe removes ch from the subscriber set by channel identity. Runs in
// the room goroutine, so r.subs is touched by nothing else and stays race-free.
func (r *Room) unsubscribe(ch chan GameState) {
	if ch == nil {
		return
	}
	for i, s := range r.subs {
		if s == ch {
			r.subs = append(r.subs[:i], r.subs[i+1:]...)
			return
		}
	}
}

func (r *Room) broadcast() {
	for _, s := range r.subs {
		select {
		case s <- r.state:
		default: // drop for a slow/closed subscriber rather than block the room
		}
	}
}

// persist writes the current state to the Snapshotter. Nil-safe; save errors
// are logged but never take the room down.
func (r *Room) persist() {
	if r.snap == nil {
		return
	}
	data, err := json.Marshal(r.state)
	if err != nil {
		log.Printf("room %s marshal snapshot: %v", r.state.Code, err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := r.snap.SaveSnapshot(ctx, r.state.Code, data); err != nil {
		log.Printf("room %s save snapshot: %v", r.state.Code, err)
	}
}
