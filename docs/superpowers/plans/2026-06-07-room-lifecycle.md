# Room Lifecycle & Connection Handlers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shut down rooms once no users remain, with robust reconnection, host migration, and join-time guards — so room state and resources stay correct across refreshes, drops, and abusive joins.

**Architecture:** The room stays a single-goroutine actor. Liveness lives in a room-side `present` map (kept out of the serialized `GameState`); grace timers (`time.AfterFunc`) submit `prune`/`reap` commands back into that goroutine, so no locks are added. The hub injects a reap callback so the room can tear itself down without importing the hub.

**Tech Stack:** Go (backend: `game`, `hub`, `store`, `realtime`, `cmd/server`), React + TanStack Router (frontend `play.$code.tsx`). Tests: Go `testing`, Vitest.

> **PROJECT RULE — NO COMMITS.** The user commits all work themselves. This plan contains **no `git commit` steps**. Each task ends with a verification checkpoint; stop there and leave staging/committing to the user.

**Spec:** `docs/superpowers/specs/2026-06-07-room-lifecycle-design.md`

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `backend/internal/store/store.go` | Redis snapshot persistence | Add `DeleteSnapshot` |
| `backend/internal/hub/hub.go` | code→room registry, lifecycle | `Store.DeleteSnapshot`, `grace`, `reap`, `StopAll`, reaper injection |
| `backend/internal/hub/hub_test.go` | hub tests | `fakeStore.DeleteSnapshot`; reap + StopAll tests |
| `backend/internal/game/room.go` | room actor + state mutations | presence model, option constructors, new command set, reap, timers |
| `backend/internal/game/room_test.go` | room tests | constructor swaps; reconnect/prune/reap/promote/dup/cap/ended tests |
| `backend/internal/realtime/socket.go` | Socket.IO ↔ room bridge | Ack-based join, `CmdDisconnect` on drop |
| `backend/cmd/server/main.go` | wiring + shutdown | `h.StopAll()` on shutdown |
| `frontend/src/routes/play.$code.tsx` | player view | host controls when `name === host` |

---

## Task 1: `store.DeleteSnapshot` + hub `Store` interface

**Files:**
- Modify: `backend/internal/store/store.go`
- Modify: `backend/internal/hub/hub.go:16-19` (interface)
- Modify: `backend/internal/hub/hub_test.go:51-71` (fakeStore)

- [ ] **Step 1: Add `DeleteSnapshot` to `RedisStore`**

In `backend/internal/store/store.go`, add after `LoadSnapshot`:

```go
// DeleteSnapshot removes a room's stored state (used when a room is reaped so it
// won't be rehydrated on a later Lookup).
func (s *RedisStore) DeleteSnapshot(ctx context.Context, code string) error {
	return s.client.Del(ctx, snapshotKey(code)).Err()
}
```

- [ ] **Step 2: Add it to the hub `Store` interface**

In `backend/internal/hub/hub.go`, extend the interface:

```go
type Store interface {
	SaveSnapshot(ctx context.Context, code string, data []byte) error
	LoadSnapshot(ctx context.Context, code string) (data []byte, ok bool, err error)
	DeleteSnapshot(ctx context.Context, code string) error
}
```

- [ ] **Step 3: Make the test `fakeStore` satisfy the interface and record deletes**

In `backend/internal/hub/hub_test.go`, replace the `fakeStore` block (struct + constructor) and add `DeleteSnapshot`:

```go
type fakeStore struct {
	mu      sync.Mutex
	data    map[string][]byte
	deletes map[string]bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{data: map[string][]byte{}, deletes: map[string]bool{}}
}

func (f *fakeStore) DeleteSnapshot(_ context.Context, code string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.data, code)
	f.deletes[code] = true
	return nil
}

func (f *fakeStore) deleted(code string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.deletes[code]
}
```

(Keep the existing `SaveSnapshot` and `LoadSnapshot` methods.)

- [ ] **Step 4: Verify it builds and existing tests pass**

Run: `cd backend && go build ./... && go test ./internal/hub/ ./internal/store/ -v`
Expected: build succeeds; existing hub tests `ok`.

---

## Task 2: `game` constructors → functional options (no behavior change)

Pure refactor: swap the three `NewRoom*` constructors for option-based ones and add the scaffolding fields the later tasks need. The command model is unchanged here, so the suite stays green.

**Files:**
- Modify: `backend/internal/game/room.go`
- Modify: `backend/internal/hub/hub.go` (call sites)
- Modify: `backend/internal/game/room_test.go` (call sites)

- [ ] **Step 1: Replace imports + add tunables + presence/option scaffolding in `room.go`**

Set the import block to include `sync`:

```go
import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"
)
```

Add after the `CmdKind` const block:

```go
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
```

- [ ] **Step 2: Replace the `Room` struct + constructors + `Stop`**

Replace the `Room` struct and the `NewRoom`/`NewRoomWithStore`/`NewRoomFromSnapshot`/`Stop` definitions with:

```go
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

// Stop tears the room down. Idempotent.
func (r *Room) Stop() { r.stopOnce.Do(func() { close(r.done) }) }
```

(Leave `Run`, `handle`, `advance`, `unsubscribe`, `broadcast`, `persist`, and the `Command`/`Snapshotter` types exactly as they are for this task.)

- [ ] **Step 3: Update hub call sites to options**

In `backend/internal/hub/hub.go`, in `Create` replace the room construction:

```go
	var r *game.Room
	if h.store != nil {
		r = game.NewRoom(code, game.WithSnapshotter(h.store))
	} else {
		r = game.NewRoom(code)
	}
```

In `Lookup`, replace the restore construction:

```go
	restored, err := game.NewRoomFromSnapshot(code, data, game.WithSnapshotter(h.store))
```

- [ ] **Step 4: Update room_test call sites**

In `backend/internal/game/room_test.go`:
- `TestRoomPersistsAfterStateChange`: change `r := NewRoomWithStore("persist1", snap)` to `r := NewRoom("persist1", WithSnapshotter(snap))`.
- `TestNewRoomFromSnapshotRestoresState`: change `r, err := NewRoomFromSnapshot("restore1", data, nil)` to `r, err := NewRoomFromSnapshot("restore1", data)`.

- [ ] **Step 5: Verify the whole backend still builds and passes**

Run: `cd backend && go build ./... && go test ./... `
Expected: all packages `ok` (behavior unchanged; only constructors moved to options).

---

## Task 3: `game` new command model — reconnection, prune, reap, promotion, join guards

The behavioral core. Replace the command set and the actor loop; add presence-driven join/disconnect/prune/reap.

**Files:**
- Modify: `backend/internal/game/room.go`
- Modify: `backend/internal/game/room_test.go`

- [ ] **Step 1: Write the new tests first**

In `backend/internal/game/room_test.go`: (a) add `"fmt"` to imports; (b) **delete** `TestRoomUnsubscribeStopsBroadcasts` (it uses the removed `CmdUnsubscribe`); (c) add these helpers and tests:

```go
// joinOK submits a join and asserts the room accepts it (empty ack).
func joinOK(t *testing.T, r *Room, name string, sub chan GameState) {
	t.Helper()
	ack := make(chan string, 1)
	r.Submit(Command{Kind: CmdJoin, Player: name, Subscribe: sub, Ack: ack})
	select {
	case msg := <-ack:
		if msg != "" {
			t.Fatalf("join %q rejected: %q", name, msg)
		}
	case <-time.After(time.Second):
		t.Fatalf("join %q: no ack", name)
	}
}

// joinErr submits a join and returns the rejection message ("" means accepted).
func joinErr(t *testing.T, r *Room, name string, sub chan GameState) string {
	t.Helper()
	ack := make(chan string, 1)
	r.Submit(Command{Kind: CmdJoin, Player: name, Subscribe: sub, Ack: ack})
	select {
	case msg := <-ack:
		return msg
	case <-time.After(time.Second):
		t.Fatal("join: no ack")
		return ""
	}
}

// poke forces a broadcast (a no-op command still broadcasts) and returns state.
func poke(t *testing.T, r *Room, sub chan GameState) GameState {
	t.Helper()
	drain(sub)
	r.Submit(Command{Kind: CmdStart, Player: "\x00nobody"}) // not host → no change
	return nextState(t, sub)
}

func TestReconnectKeepsPlayer(t *testing.T) {
	r := NewRoom("recon1", WithGrace(20*time.Millisecond))
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 16)
	joinOK(t, r, "alice", sub)
	joinOK(t, r, "bob", make(chan GameState, 16)) // keep room non-empty

	r.Submit(Command{Kind: CmdDisconnect, Player: "alice", Unsub: sub})
	sub2 := make(chan GameState, 16)
	joinOK(t, r, "alice", sub2) // reconnect before grace
	time.Sleep(50 * time.Millisecond)

	s := poke(t, r, sub2)
	if s.playerIndex("alice") < 0 {
		t.Fatalf("alice pruned despite reconnect: %+v", s.Players)
	}
}

func TestPruneAfterGrace(t *testing.T) {
	r := NewRoom("prune1", WithGrace(20*time.Millisecond))
	go r.Run()
	defer r.Stop()

	subA := make(chan GameState, 16)
	joinOK(t, r, "alice", subA)
	subB := make(chan GameState, 16)
	joinOK(t, r, "bob", subB)

	r.Submit(Command{Kind: CmdDisconnect, Player: "bob", Unsub: subB})
	time.Sleep(60 * time.Millisecond)

	s := poke(t, r, subA)
	if s.playerIndex("bob") >= 0 {
		t.Fatalf("bob not pruned after grace: %+v", s.Players)
	}
	if s.playerIndex("alice") < 0 {
		t.Fatal("alice wrongly removed")
	}
}

func TestHostPromotionOnPrune(t *testing.T) {
	r := NewRoom("promo1", WithGrace(20*time.Millisecond))
	go r.Run()
	defer r.Stop()

	subA := make(chan GameState, 16)
	joinOK(t, r, "alice", subA) // alice becomes host
	subB := make(chan GameState, 16)
	joinOK(t, r, "bob", subB)

	r.Submit(Command{Kind: CmdDisconnect, Player: "alice", Unsub: subA})
	time.Sleep(60 * time.Millisecond)

	s := poke(t, r, subB)
	if s.Host != "bob" {
		t.Fatalf("host = %q, want bob after alice pruned", s.Host)
	}
}

func TestDuplicateNameRejected(t *testing.T) {
	r := NewRoom("dup1", WithGrace(time.Second))
	go r.Run()
	defer r.Stop()

	joinOK(t, r, "alice", make(chan GameState, 16))
	if msg := joinErr(t, r, "alice", make(chan GameState, 16)); msg == "" {
		t.Fatal("duplicate connected name was accepted")
	}
}

func TestRoomCap(t *testing.T) {
	r := NewRoom("cap1", WithGrace(time.Second))
	go r.Run()
	defer r.Stop()

	for i := 0; i < maxPlayers; i++ {
		joinOK(t, r, fmt.Sprintf("p%d", i), make(chan GameState, 16))
	}
	if msg := joinErr(t, r, "overflow", make(chan GameState, 16)); msg == "" {
		t.Fatalf("join past cap of %d was accepted", maxPlayers)
	}
}

func TestJoinRejectedWhenEnded(t *testing.T) {
	data, _ := json.Marshal(GameState{Code: "end1", Phase: PhaseEnded,
		Host: "alice", Players: []Player{{Name: "alice"}}})
	r, err := NewRoomFromSnapshot("end1", data, WithGrace(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	go r.Run()
	defer r.Stop()

	if msg := joinErr(t, r, "bob", make(chan GameState, 16)); msg == "" {
		t.Fatal("join into an ended game was accepted")
	}
}

func TestEmptyRoomReapedOnCreationGrace(t *testing.T) {
	reaped := make(chan struct{}, 1)
	r := NewRoom("empty1", WithGrace(20*time.Millisecond),
		WithReaper(func() { reaped <- struct{}{} }))
	go r.Run()
	defer r.Stop()

	select {
	case <-reaped:
	case <-time.After(time.Second):
		t.Fatal("never-populated room was not reaped")
	}
}

func TestRoomReapedAfterLastPlayerLeaves(t *testing.T) {
	reaped := make(chan struct{}, 1)
	r := NewRoom("empty2", WithGrace(20*time.Millisecond),
		WithReaper(func() { reaped <- struct{}{} }))
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 16)
	joinOK(t, r, "alice", sub) // cancels the creation timer
	r.Submit(Command{Kind: CmdDisconnect, Player: "alice", Unsub: sub})

	select {
	case <-reaped:
	case <-time.After(time.Second):
		t.Fatal("room not reaped after last player left + grace")
	}
}

func TestDisconnectStopsBroadcasts(t *testing.T) {
	r := NewRoom("unsub01", WithGrace(time.Second))
	go r.Run()
	defer r.Stop()

	stay := make(chan GameState, 16)
	joinOK(t, r, "alice", stay)
	gone := make(chan GameState, 16)
	joinOK(t, r, "bob", gone)
	drain(stay)
	drain(gone)

	// bob drops: gone is unsubscribed (bob stays present during the 1s grace).
	r.Submit(Command{Kind: CmdDisconnect, Player: "bob", Unsub: gone})
	joinOK(t, r, "carol", nil)

	var s GameState
	for i := 0; i < 5; i++ {
		s = nextState(t, stay)
		if s.playerIndex("carol") >= 0 {
			break
		}
	}
	if s.playerIndex("carol") < 0 {
		t.Fatal("remaining channel did not receive carol join")
	}
	select {
	case x := <-gone:
		t.Fatalf("unsubscribed channel still received: %+v", x)
	case <-time.After(150 * time.Millisecond):
	}
}
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `cd backend && go test ./internal/game/ -run 'Reconnect|Prune|HostPromotion|Duplicate|RoomCap|Ended|Empty|Reaped|DisconnectStops' -v`
Expected: **compile failure** — `CmdDisconnect`, `CmdPrune`, `Ack`, `Gen` undefined. (That's the red state for this task.)

- [ ] **Step 3: Replace the command set, `Command`, actor loop, and handlers**

In `backend/internal/game/room.go`, replace the `CmdKind` const block:

```go
const (
	CmdJoin CmdKind = iota
	CmdDisconnect
	CmdStart
	CmdSubmitAnswer
	CmdNextPhase
	CmdPrune
	CmdReapIfEmpty
)
```

Replace the `Command` struct:

```go
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
```

Replace `Run` and `handle` and add the new helpers (replace the whole region from `func (r *Room) Run()` through `func (r *Room) advance()`):

```go
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
```

The old `Run` pre-handle block that appended `c.Subscribe`/handled `CmdUnsubscribe` is gone — subscription is now owned by `join`/`disconnect`. Keep `unsubscribe`, `broadcast`, and `persist` as they are.

- [ ] **Step 4: Run the game suite to confirm green**

Run: `cd backend && go test ./internal/game/ -v`
Expected: all tests `PASS`, including the legacy `TestRoomJoinAndStart`, `TestRoomSubmitAnswerOnlyInRound`, persistence, restore, and the new lifecycle tests. `ok  	skoobl/internal/game`.

- [ ] **Step 5: Run with the race detector**

Run: `cd backend && go test ./internal/game/ -race`
Expected: `ok` — no data races (timers submit commands; state stays single-goroutine).

---

## Task 4: `hub` reap + StopAll + reaper injection

**Files:**
- Modify: `backend/internal/hub/hub.go`
- Modify: `backend/internal/hub/hub_test.go`

- [ ] **Step 1: Write the failing tests**

In `backend/internal/hub/hub_test.go`, add:

```go
func TestEmptyRoomReaped(t *testing.T) {
	store := newFakeStore()
	h := New(WithStore(store), WithGrace(20*time.Millisecond))
	code, _ := h.Create() // nobody ever joins

	// After the creation grace, the room reaps itself: gone from the map and its
	// snapshot deleted so Lookup can't rehydrate it.
	deadline := time.After(time.Second)
	for {
		if _, ok := h.Lookup(code); !ok && store.deleted(code) {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("room %s not reaped (lookup or delete missing)", code)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestStopAllStopsRooms(t *testing.T) {
	h := New(WithGrace(time.Second))
	c1, _ := h.Create()
	c2, _ := h.Create()
	h.StopAll()
	if _, ok := h.Lookup(c1); ok {
		t.Fatal("room 1 still present after StopAll")
	}
	if _, ok := h.Lookup(c2); ok {
		t.Fatal("room 2 still present after StopAll")
	}
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd backend && go test ./internal/hub/ -run 'EmptyRoomReaped|StopAll' -v`
Expected: **compile failure** — `WithGrace`, `StopAll` undefined.

- [ ] **Step 3: Implement grace, reaper injection, reap, StopAll**

In `backend/internal/hub/hub.go`, add `"log"` to imports. Add the option + `grace` field:

```go
// WithGrace overrides the room grace period (tests use a tiny value).
func WithGrace(d time.Duration) Option { return func(h *Hub) { h.grace = d } }

type Hub struct {
	mu    sync.RWMutex
	rooms map[string]*game.Room
	store Store
	grace time.Duration
}

func New(opts ...Option) *Hub {
	h := &Hub{rooms: make(map[string]*game.Room), grace: game.DefaultGrace}
	for _, opt := range opts {
		opt(h)
	}
	return h
}
```

Add a shared options builder and use it in `Create` and `Lookup`:

```go
func (h *Hub) roomOpts(code string) []game.RoomOption {
	opts := []game.RoomOption{
		game.WithReaper(func() { h.reap(code) }),
		game.WithGrace(h.grace),
	}
	if h.store != nil {
		opts = append(opts, game.WithSnapshotter(h.store))
	}
	return opts
}
```

In `Create`, replace the construction block from Task 2 with:

```go
	r := game.NewRoom(code, h.roomOpts(code)...)
	go r.Run()
	h.rooms[code] = r
	return code, r
```

In `Lookup`, replace the restore construction with:

```go
	restored, err := game.NewRoomFromSnapshot(code, data, h.roomOpts(code)...)
```

Add `reap` and `StopAll` at the end of the file:

```go
// reap drops a self-terminated (empty) room and deletes its snapshot so Lookup
// won't rehydrate it. Called from the room goroutine via the injected reaper.
func (h *Hub) reap(code string) {
	h.mu.Lock()
	delete(h.rooms, code)
	h.mu.Unlock()
	if h.store == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := h.store.DeleteSnapshot(ctx, code); err != nil {
		log.Printf("hub reap %s: delete snapshot: %v", code, err)
	}
}

// StopAll stops every room. Used on graceful server shutdown.
func (h *Hub) StopAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for code, r := range h.rooms {
		r.Stop()
		delete(h.rooms, code)
	}
}
```

- [ ] **Step 4: Run the hub suite (with race detector)**

Run: `cd backend && go test ./internal/hub/ -race -v`
Expected: all `PASS`, including `TestEmptyRoomReaped`, `TestStopAllStopsRooms`, and the existing create/lookup/restore/persist tests. `ok  	skoobl/internal/hub`.

---

## Task 5: `realtime/socket.go` — ack-based join, disconnect grace

**Files:**
- Modify: `backend/internal/realtime/socket.go`

- [ ] **Step 1: Add `time` import**

Set the import block to include `"time"`:

```go
import (
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/zishang520/socket.io/servers/socket/v3"

	"skoobl/internal/game"
	"skoobl/internal/hub"
)
```

- [ ] **Step 2: Replace `join` with the ack-waiting version**

Replace the `func (c *conn) join(...)` body:

```go
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
```

- [ ] **Step 3: Replace `leave` to send `CmdDisconnect`**

Replace the `func (c *conn) leave()` body:

```go
// leave runs on socket disconnect. It hands the room a CmdDisconnect (which
// unsubscribes this channel and starts the player's reconnect grace) rather than
// removing the player outright, so a refresh or brief drop doesn't eject them.
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
```

- [ ] **Step 4: Build + full backend suite**

Run: `cd backend && go build ./... && go test ./... -race`
Expected: builds; all packages `ok`.

- [ ] **Step 5: Manual smoke — real Socket.IO client through the running server**

Start the backend, create a room, and confirm join acks + state flow and that a reconnect doesn't duplicate the player:

```bash
cd backend && go run ./cmd/server &   # listens on :8080
CODE=$(curl -s -XPOST localhost:8080/games | grep -oE '[a-f0-9]{6}')
cd ../frontend && cat > sioprobe.mjs <<EOF
import { io } from "socket.io-client";
const s = io("http://localhost:8080", { transports: ["websocket"] });
s.on("connect", () => { console.log("connect"); s.emit("join", { code: "$CODE", name: "alice" }); });
s.on("state", (st) => console.log("state players=", st.players.map(p=>p.name)));
s.on("error", (e) => console.log("error", e.message));
setTimeout(() => { s.disconnect(); process.exit(0); }, 1500);
EOF
node sioprobe.mjs; rm -f sioprobe.mjs
kill %1 2>/dev/null
```
Expected: `connect` then `state players= [ 'alice' ]`. No error. (A second run within 60s with the same code/name reconnects to the same single player.)

---

## Task 6: `main.go` — stop rooms on shutdown

**Files:**
- Modify: `backend/cmd/server/main.go`

- [ ] **Step 1: Call `StopAll` during graceful shutdown**

In `backend/cmd/server/main.go`, in the shutdown sequence, add `h.StopAll()` right after the HTTP server stops:

```go
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
	h.StopAll()
	io.Close(nil)
```

- [ ] **Step 2: Build + verify shutdown**

Run: `cd backend && go build ./... && (go run ./cmd/server & sleep 1; kill -TERM %1; wait)`
Expected: builds; logs show `listening on :8080` then `server stopped` with no panic.

---

## Task 7: frontend `play.$code.tsx` — host controls when promoted

A promoted player sits on `/play`; give them the host controls so the game stays drivable.

**Files:**
- Modify: `frontend/src/routes/play.$code.tsx`

- [ ] **Step 1: Pull `start`/`nextPhase` from the hook and read `host`**

Change the hook destructure:

```tsx
  const { start, nextPhase, submitAnswer } = useGameSocket(code, name);
```

Add a `host` selector next to the existing store selectors (after the `error` selector):

```tsx
  const host = useGameStore((s) => s.host);
```

And derive (place it just before the `if (!name)` guard, after the `useState` calls):

```tsx
  const isHost = name === host;
```

- [ ] **Step 2: Render host controls**

Inside the returned `<main>`, immediately before its closing `</main>`, add a footer shown only to the host:

```tsx
      {isHost && (
        <footer className="mt-auto flex flex-col gap-3 pt-2">
          {phase === "lobby" && (
            <button
              type="button"
              className="btn-key w-full px-6 py-4 text-lg"
              onClick={start}
              disabled={players.length === 0}
            >
              {players.length === 0 ? "Waiting for players…" : "Start the game →"}
            </button>
          )}
          {(phase === "inRound" || phase === "reveal") && (
            <button
              type="button"
              className="btn-key btn-key--pink w-full px-6 py-4 text-lg"
              onClick={nextPhase}
            >
              {phase === "inRound" ? "Reveal answers →" : "Next round →"}
            </button>
          )}
        </footer>
      )}
```

- [ ] **Step 3: Typecheck + build + existing tests**

Run: `cd frontend && npx tsc --noEmit && npx vite build && npx vitest run`
Expected: no type errors; build succeeds; existing Vitest suite passes.

- [ ] **Step 4: Manual verification — promotion gives controls**

Run `npm run dev` (frontend) with the backend up. In two tabs:
1. Tab A: host a game (you're the host on `/host`).
2. Tab B: join the same code (player on `/play`) — confirm no host controls.
3. Close Tab A and wait ~60s (host grace). Tab B's player is promoted: the host control button (`Start the game →` in lobby, or `Reveal answers →`/`Next round →` mid-game) now appears on `/play`, and clicking it advances the game.

Expected: Tab B shows host controls only after promotion and can drive the game.

---

## Final verification

- [ ] **Backend, full suite with race detector**

Run: `cd backend && go test ./... -race`
Expected: every package `ok`.

- [ ] **Frontend**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: no type errors; tests pass.

- [ ] **Hand off**

Stop here. Do **not** commit — the user reviews and commits.
