package game

import (
	"context"
	"encoding/json"
	"log"
	"time"
)

// CmdKind enumerates the mutations a Room accepts.
type CmdKind int

const (
	CmdJoin CmdKind = iota
	CmdLeave
	CmdStart
	CmdSubmitAnswer
	CmdNextPhase
	CmdUnsubscribe
)

// Command is a single mutation request delivered to a Room's goroutine.
// Subscribe, when non-nil, registers a per-client channel that receives every
// future state broadcast (used on join). Unsub, when non-nil, removes that
// exact channel from the subscriber set (used on disconnect).
type Command struct {
	Kind      CmdKind
	Player    string
	Answer    string
	Subscribe chan GameState
	Unsub     chan GameState
}

// Snapshotter persists a room's serialized state. Implemented by
// store.RedisStore. A nil Snapshotter disables persistence (in-memory mode).
type Snapshotter interface {
	SaveSnapshot(ctx context.Context, code string, data []byte) error
}

// Room owns its GameState and is the only goroutine that touches it.
type Room struct {
	state GameState
	cmds  chan Command
	done  chan struct{}
	subs  []chan GameState
	snap  Snapshotter
}

// NewRoom creates an unstarted in-memory room. Call Run in a goroutine.
func NewRoom(code string) *Room {
	return &Room{
		state: newGameState(code),
		cmds:  make(chan Command, 32),
		done:  make(chan struct{}),
	}
}

// NewRoomWithStore is NewRoom plus a Snapshotter for persistence.
func NewRoomWithStore(code string, snap Snapshotter) *Room {
	r := NewRoom(code)
	r.snap = snap
	return r
}

// NewRoomFromSnapshot rebuilds a room from previously persisted state.
func NewRoomFromSnapshot(code string, data []byte, snap Snapshotter) (*Room, error) {
	var gs GameState
	if err := json.Unmarshal(data, &gs); err != nil {
		return nil, err
	}
	gs.Code = code
	if gs.Players == nil {
		gs.Players = []Player{}
	}
	return &Room{
		state: gs,
		cmds:  make(chan Command, 32),
		done:  make(chan struct{}),
		snap:  snap,
	}, nil
}

// Submit enqueues a command. Safe from any goroutine.
func (r *Room) Submit(c Command) {
	select {
	case r.cmds <- c:
	case <-r.done:
	}
}

// Stop tears the room down.
func (r *Room) Stop() { close(r.done) }

// Run is the actor loop. Single-threaded over r.state — no locks needed.
func (r *Room) Run() {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("room %s panic recovered: %v", r.state.Code, rec)
		}
	}()
	for {
		select {
		case <-r.done:
			return
		case c := <-r.cmds:
			if c.Subscribe != nil {
				r.subs = append(r.subs, c.Subscribe)
			}
			if c.Unsub != nil || c.Kind == CmdUnsubscribe {
				r.unsubscribe(c.Unsub)
			}
			r.handle(c)
			r.broadcast()
			r.persist()
		}
	}
}

func (r *Room) handle(c Command) {
	switch c.Kind {
	case CmdJoin:
		if r.state.playerIndex(c.Player) >= 0 {
			return
		}
		if r.state.Host == "" {
			r.state.Host = c.Player
		}
		r.state.Players = append(r.state.Players, Player{Name: c.Player})
	case CmdLeave:
		if i := r.state.playerIndex(c.Player); i >= 0 {
			r.state.Players = append(r.state.Players[:i], r.state.Players[i+1:]...)
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

func (r *Room) advance() {
	switch r.state.Phase {
	case PhaseInRound:
		r.state.Phase = PhaseReveal
	case PhaseReveal:
		r.state.Phase = PhaseEnded
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
