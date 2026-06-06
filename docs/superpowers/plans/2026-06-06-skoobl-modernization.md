# skoobl Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the race-prone in-memory Go WS backend with a Chi + room-actor + Redis architecture, swap the Next.js frontend for a Vite + React SPA with zustand and a typed WS hook, and add a minimal game loop proving the protocol end-to-end.

**Architecture:** Go backend: Chi router → coder/websocket upgrade → one goroutine per game room owning its state, mutated only via a command channel, snapshotted to Redis. Frontend: Vite React SPA, react-router (home/host/player), zustand store fed by a typed `useGameSocket` hook over a tagged `{type,payload}` protocol shared with Go.

**Tech Stack:** Go 1.26, go-chi/chi v5.2.5, coder/websocket v1.8.14, go-redis v9.20.0, miniredis v2.38.0 (test); Vite 8, React 19.2, react-router-dom 7, Tailwind 4 (`@tailwindcss/vite`), zustand 5, vitest 4 + @testing-library/react.

**Prereqs:** Local Redis running for manual/integration dev (`docker run -p 6379:6379 redis:7` or `brew services start redis`). Unit tests use miniredis — no real Redis needed in CI.

---

## File Structure

```
backend/
  cmd/server/main.go             # wire chi + middleware, graceful shutdown
  internal/
    protocol/protocol.go         # envelope, command + event types, helpers
    protocol/protocol_test.go
    game/state.go                # GameState, Phase, Player
    game/room.go                 # Room actor goroutine + command handling
    game/room_test.go
    hub/hub.go                   # room registry
    hub/hub_test.go
    store/store.go               # Redis snapshot + pub/sub (interface + impl)
    store/store_test.go
    ws/client.go                 # coder/websocket read/write pumps
    ws/handler.go                # HTTP→WS upgrade handler bound to hub
    httpapi/handlers.go          # POST /games, GET /healthz
    httpapi/handlers_test.go
    router/router.go             # chi router + middleware wiring
  go.mod
frontend/                        # NEW Vite SPA (old Next.js files removed)
  index.html
  vite.config.ts
  tsconfig.json
  package.json
  src/
    main.tsx
    App.tsx
    index.css
    lib/protocol.ts              # TS mirror of Go protocol
    lib/store.ts                 # zustand store
    lib/store.test.ts
    lib/utils.ts                 # cn() — ported
    hooks/use-game-socket.ts     # typed WS client hook
    hooks/use-game-socket.test.ts
    pages/Home.tsx
    pages/Host.tsx
    pages/Play.tsx
    components/ui/button.tsx      # ported shadcn, Tailwind 4
    components/ui/input.tsx
```

---

# PHASE 1 — Backend

## Task 1: Reinitialize Go module + dependencies

**Files:**
- Modify: `backend/go.mod`

- [ ] **Step 1: Bump Go directive and add deps**

Run from `backend/`:
```bash
cd backend
go mod edit -go=1.26
go get github.com/go-chi/chi/v5@v5.2.5
go get github.com/coder/websocket@v1.8.14
go get github.com/redis/go-redis/v9@v9.20.0
go get github.com/alicebob/miniredis/v2@v2.38.0
```

- [ ] **Step 2: Remove the old monolith so packages take over**

```bash
git rm backend/main.go
```

- [ ] **Step 3: Tidy and verify it builds (empty for now is fine)**

Run: `cd backend && go mod tidy`
Expected: no errors; gorilla deps dropped from `go.mod`.

- [ ] **Step 4: Commit**

```bash
git add backend/go.mod backend/go.sum
git commit -m "chore(backend): reset module to chi/coder-ws/redis stack, drop gorilla monolith"
```

---

## Task 2: Protocol — tagged envelope + types

**Files:**
- Create: `backend/internal/protocol/protocol.go`
- Test: `backend/internal/protocol/protocol_test.go`

- [ ] **Step 1: Write the failing test**

`backend/internal/protocol/protocol_test.go`:
```go
package protocol

import (
	"encoding/json"
	"testing"
)

func TestDecodeCommand(t *testing.T) {
	raw := []byte(`{"type":"submitAnswer","payload":{"answer":"banana"}}`)
	env, err := DecodeEnvelope(raw)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if env.Type != CmdSubmitAnswer {
		t.Fatalf("type = %q, want %q", env.Type, CmdSubmitAnswer)
	}
	var p SubmitAnswerPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if p.Answer != "banana" {
		t.Fatalf("answer = %q, want banana", p.Answer)
	}
}

func TestEncodeEvent(t *testing.T) {
	b, err := EncodeEvent(EvtError, ErrorPayload{Message: "nope"})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	env, err := DecodeEnvelope(b)
	if err != nil {
		t.Fatalf("roundtrip decode: %v", err)
	}
	if env.Type != EvtError {
		t.Fatalf("type = %q, want %q", env.Type, EvtError)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/protocol/`
Expected: FAIL — undefined `DecodeEnvelope`, etc.

- [ ] **Step 3: Write minimal implementation**

`backend/internal/protocol/protocol.go`:
```go
// Package protocol defines the tagged {type,payload} envelope and the
// command (client→server) and event (server→client) message types.
package protocol

import "encoding/json"

type MsgType string

// Commands (client → server).
const (
	CmdJoin         MsgType = "join"
	CmdLeave        MsgType = "leave"
	CmdStart        MsgType = "start"
	CmdSubmitAnswer MsgType = "submitAnswer"
	CmdNextPhase    MsgType = "nextPhase"
)

// Events (server → client).
const (
	EvtState     MsgType = "state"
	EvtError     MsgType = "error"
	EvtGameEnded MsgType = "gameEnded"
)

// Envelope is the wire format for every message in both directions.
type Envelope struct {
	Type    MsgType         `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Command payloads.
type JoinPayload struct {
	Player string `json:"player"`
}
type SubmitAnswerPayload struct {
	Answer string `json:"answer"`
}

// Event payloads.
type ErrorPayload struct {
	Message string `json:"message"`
}

// DecodeEnvelope parses raw bytes into an Envelope.
func DecodeEnvelope(b []byte) (Envelope, error) {
	var e Envelope
	err := json.Unmarshal(b, &e)
	return e, err
}

// EncodeEvent marshals a typed event into envelope bytes.
func EncodeEvent(t MsgType, payload any) ([]byte, error) {
	p, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Envelope{Type: t, Payload: p})
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/protocol/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/protocol/
git commit -m "feat(backend): typed protocol envelope with commands and events"
```

---

## Task 3: Game state types

**Files:**
- Create: `backend/internal/game/state.go`

- [ ] **Step 1: Write the state types (no test — pure data, exercised in Task 4)**

`backend/internal/game/state.go`:
```go
package game

// Phase is the room's lifecycle stage.
type Phase string

const (
	PhaseLobby   Phase = "lobby"
	PhaseInRound Phase = "inRound"
	PhaseReveal  Phase = "reveal"
	PhaseEnded   Phase = "ended"
)

// Player is one participant.
type Player struct {
	Name   string `json:"name"`
	Answer string `json:"answer,omitempty"`
}

// GameState is the full, serializable room state broadcast to clients.
type GameState struct {
	Code    string   `json:"code"`
	Phase   Phase    `json:"phase"`
	Host    string   `json:"host"`
	Players []Player `json:"players"`
}

func newGameState(code string) GameState {
	return GameState{Code: code, Phase: PhaseLobby, Players: []Player{}}
}

func (g *GameState) playerIndex(name string) int {
	for i, p := range g.Players {
		if p.Name == name {
			return i
		}
	}
	return -1
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd backend && go build ./internal/game/`
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add backend/internal/game/state.go
git commit -m "feat(backend): game state and phase types"
```

---

## Task 4: Room actor — command handling + state machine

**Files:**
- Create: `backend/internal/game/room.go`
- Test: `backend/internal/game/room_test.go`

- [ ] **Step 1: Write the failing test**

`backend/internal/game/room_test.go`:
```go
package game

import (
	"testing"
	"time"
)

// drain returns the next broadcast GameState within a timeout.
func nextState(t *testing.T, ch <-chan GameState) GameState {
	t.Helper()
	select {
	case s := <-ch:
		return s
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for state broadcast")
		return GameState{}
	}
}

func TestRoomJoinAndStart(t *testing.T) {
	r := NewRoom("abc123")
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 8)
	r.Submit(Command{Kind: CmdJoin, Player: "alice", Subscribe: sub})
	s := nextState(t, sub)
	if s.Host != "alice" {
		t.Fatalf("host = %q, want alice (first joiner)", s.Host)
	}
	if len(s.Players) != 1 {
		t.Fatalf("players = %d, want 1", len(s.Players))
	}

	r.Submit(Command{Kind: CmdJoin, Player: "bob", Subscribe: make(chan GameState, 8)})
	s = nextState(t, sub)
	if len(s.Players) != 2 {
		t.Fatalf("players = %d, want 2", len(s.Players))
	}

	// Non-host cannot start.
	r.Submit(Command{Kind: CmdStart, Player: "bob"})
	r.Submit(Command{Kind: CmdStart, Player: "alice"})
	// Drain to the inRound state.
	var phase Phase
	for i := 0; i < 4; i++ {
		s = nextState(t, sub)
		phase = s.Phase
		if phase == PhaseInRound {
			break
		}
	}
	if phase != PhaseInRound {
		t.Fatalf("phase = %q, want inRound after host start", phase)
	}
}

func TestRoomSubmitAnswerOnlyInRound(t *testing.T) {
	r := NewRoom("xyz789")
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 16)
	r.Submit(Command{Kind: CmdJoin, Player: "alice", Subscribe: sub})
	nextState(t, sub)

	// Answer in lobby is ignored (no state change beyond what we assert).
	r.Submit(Command{Kind: CmdSubmitAnswer, Player: "alice", Answer: "early"})
	r.Submit(Command{Kind: CmdStart, Player: "alice"})

	var got GameState
	for i := 0; i < 4; i++ {
		got = nextState(t, sub)
		if got.Phase == PhaseInRound {
			break
		}
	}
	r.Submit(Command{Kind: CmdSubmitAnswer, Player: "alice", Answer: "banana"})
	got = nextState(t, sub)
	if idx := got.playerIndex("alice"); idx < 0 || got.Players[idx].Answer != "banana" {
		t.Fatalf("answer not recorded in round: %+v", got.Players)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/game/`
Expected: FAIL — undefined `NewRoom`, `Command`, etc.

- [ ] **Step 3: Write minimal implementation**

`backend/internal/game/room.go`:
```go
package game

import "log"

// CmdKind enumerates the mutations a Room accepts.
type CmdKind int

const (
	CmdJoin CmdKind = iota
	CmdLeave
	CmdStart
	CmdSubmitAnswer
	CmdNextPhase
)

// Command is a single mutation request delivered to a Room's goroutine.
// Subscribe, when non-nil, registers a per-client channel that receives every
// future state broadcast (used on join).
type Command struct {
	Kind      CmdKind
	Player    string
	Answer    string
	Subscribe chan GameState
}

// Room owns its GameState and is the only goroutine that touches it.
type Room struct {
	state   GameState
	cmds    chan Command
	done    chan struct{}
	subs    []chan GameState
}

// NewRoom creates an unstarted room. Call Run in a goroutine.
func NewRoom(code string) *Room {
	return &Room{
		state: newGameState(code),
		cmds:  make(chan Command, 32),
		done:  make(chan struct{}),
	}
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
			r.handle(c)
			r.broadcast()
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

func (r *Room) broadcast() {
	for _, s := range r.subs {
		select {
		case s <- r.state:
		default: // drop for a slow/closed subscriber rather than block the room
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/game/`
Expected: PASS (both tests).

- [ ] **Step 5: Run the race detector**

Run: `cd backend && go test -race ./internal/game/`
Expected: PASS, no data races.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/game/room.go backend/internal/game/room_test.go
git commit -m "feat(backend): room actor with command channel and phase state machine"
```

---

## Task 5: Hub — room registry

**Files:**
- Create: `backend/internal/hub/hub.go`
- Test: `backend/internal/hub/hub_test.go`

- [ ] **Step 1: Write the failing test**

`backend/internal/hub/hub_test.go`:
```go
package hub

import (
	"sync"
	"testing"
)

func TestCreateLookupDelete(t *testing.T) {
	h := New()
	code, room := h.Create()
	if len(code) == 0 || room == nil {
		t.Fatal("Create returned empty code or nil room")
	}
	got, ok := h.Lookup(code)
	if !ok || got != room {
		t.Fatal("Lookup did not return the created room")
	}
	h.Delete(code)
	if _, ok := h.Lookup(code); ok {
		t.Fatal("room still present after Delete")
	}
}

func TestConcurrentCreate(t *testing.T) {
	h := New()
	var wg sync.WaitGroup
	codes := make(chan string, 100)
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, _ := h.Create()
			codes <- c
		}()
	}
	wg.Wait()
	close(codes)
	seen := map[string]bool{}
	for c := range codes {
		if seen[c] {
			t.Fatalf("duplicate code generated: %s", c)
		}
		seen[c] = true
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/hub/`
Expected: FAIL — undefined `New`.

- [ ] **Step 3: Write minimal implementation**

`backend/internal/hub/hub.go`:
```go
// Package hub maintains the registry of active game rooms.
package hub

import (
	"crypto/rand"
	"encoding/hex"
	"sync"

	"skoobl/internal/game"
)

// Hub owns the code→Room map. Lookups are read-mostly; the only
// read-modify-write paths (create/delete) are guarded by a mutex.
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]*game.Room
}

func New() *Hub {
	return &Hub{rooms: make(map[string]*game.Room)}
}

func generateCode() string {
	b := make([]byte, 3)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b) // 6 hex chars
}

// Create makes a new started room and registers it under a unique code.
func (h *Hub) Create() (string, *game.Room) {
	h.mu.Lock()
	defer h.mu.Unlock()
	var code string
	for {
		code = generateCode()
		if _, exists := h.rooms[code]; !exists {
			break
		}
	}
	r := game.NewRoom(code)
	go r.Run()
	h.rooms[code] = r
	return code, r
}

// Lookup returns the room for a code.
func (h *Hub) Lookup(code string) (*game.Room, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	r, ok := h.rooms[code]
	return r, ok
}

// Delete stops and unregisters a room.
func (h *Hub) Delete(code string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r, ok := h.rooms[code]; ok {
		r.Stop()
		delete(h.rooms, code)
	}
}
```

- [ ] **Step 4: Run tests (with race detector) to verify they pass**

Run: `cd backend && go test -race ./internal/hub/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/hub/
git commit -m "feat(backend): hub room registry with unique code generation"
```

---

## Task 6: Store — Redis snapshot + pub/sub

**Files:**
- Create: `backend/internal/store/store.go`
- Test: `backend/internal/store/store_test.go`

- [ ] **Step 1: Write the failing test (uses miniredis)**

`backend/internal/store/store_test.go`:
```go
package store

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newTestStore(t *testing.T) *RedisStore {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	return NewRedisStore(client, time.Hour)
}

func TestSnapshotRoundTrip(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	if err := s.SaveSnapshot(ctx, "abc123", []byte(`{"phase":"lobby"}`)); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, ok, err := s.LoadSnapshot(ctx, "abc123")
	if err != nil || !ok {
		t.Fatalf("load: ok=%v err=%v", ok, err)
	}
	if string(got) != `{"phase":"lobby"}` {
		t.Fatalf("snapshot = %s", got)
	}
}

func TestLoadMissingSnapshot(t *testing.T) {
	s := newTestStore(t)
	if _, ok, err := s.LoadSnapshot(context.Background(), "missing"); ok || err != nil {
		t.Fatalf("expected (false,nil) for missing, got ok=%v err=%v", ok, err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/store/`
Expected: FAIL — undefined `NewRedisStore`.

- [ ] **Step 3: Write minimal implementation**

`backend/internal/store/store.go`:
```go
// Package store persists room snapshots to Redis and provides per-room
// pub/sub so multiple server instances can share state.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisStore implements snapshot persistence and pub/sub over Redis.
type RedisStore struct {
	client *redis.Client
	ttl    time.Duration
}

func NewRedisStore(client *redis.Client, ttl time.Duration) *RedisStore {
	return &RedisStore{client: client, ttl: ttl}
}

func snapshotKey(code string) string { return "room:" + code }
func roomChannel(code string) string { return "room-events:" + code }

// SaveSnapshot stores serialized room state with the configured TTL.
func (s *RedisStore) SaveSnapshot(ctx context.Context, code string, data []byte) error {
	return s.client.Set(ctx, snapshotKey(code), data, s.ttl).Err()
}

// LoadSnapshot returns stored state. ok is false when no snapshot exists.
func (s *RedisStore) LoadSnapshot(ctx context.Context, code string) (data []byte, ok bool, err error) {
	b, err := s.client.Get(ctx, snapshotKey(code)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

// Publish broadcasts an event to other instances watching this room.
func (s *RedisStore) Publish(ctx context.Context, code string, data []byte) error {
	return s.client.Publish(ctx, roomChannel(code), data).Err()
}

// Subscribe returns a go-redis subscription for a room's channel.
func (s *RedisStore) Subscribe(ctx context.Context, code string) *redis.PubSub {
	return s.client.Subscribe(ctx, roomChannel(code))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/store/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/store/
git commit -m "feat(backend): redis store for room snapshots and pub/sub"
```

---

## Task 7: HTTP API — create game + healthz

**Files:**
- Create: `backend/internal/httpapi/handlers.go`
- Test: `backend/internal/httpapi/handlers_test.go`

- [ ] **Step 1: Write the failing test**

`backend/internal/httpapi/handlers_test.go`:
```go
package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"skoobl/internal/hub"
)

func TestCreateGameReturnsCode(t *testing.T) {
	h := hub.New()
	api := New(h)

	req := httptest.NewRequest(http.MethodPost, "/games", nil)
	rec := httptest.NewRecorder()
	api.CreateGame(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201", rec.Code)
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Code) != 6 {
		t.Fatalf("code = %q, want 6 hex chars", body.Code)
	}
	if _, ok := h.Lookup(body.Code); !ok {
		t.Fatal("created code not registered in hub")
	}
}

func TestHealthz(t *testing.T) {
	api := New(hub.New())
	rec := httptest.NewRecorder()
	api.Healthz(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/httpapi/`
Expected: FAIL — undefined `New`.

- [ ] **Step 3: Write minimal implementation**

`backend/internal/httpapi/handlers.go`:
```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/httpapi/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/httpapi/
git commit -m "feat(backend): http api for create-game and healthz"
```

---

## Task 8: WebSocket client + upgrade handler

**Files:**
- Create: `backend/internal/ws/client.go`
- Create: `backend/internal/ws/handler.go`
- Test: `backend/internal/ws/handler_test.go`

- [ ] **Step 1: Write the failing integration test (real loopback WS)**

`backend/internal/ws/handler_test.go`:
```go
package ws

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"skoobl/internal/hub"
	"skoobl/internal/protocol"
)

func TestWebSocketJoinBroadcastsState(t *testing.T) {
	h := hub.New()
	code, _ := h.Create()

	srv := httptest.NewServer(Handler(h))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?code=" + code

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Send a join command.
	join, _ := protocol.EncodeEvent(protocol.CmdJoin, protocol.JoinPayload{Player: "alice"})
	if err := conn.Write(ctx, websocket.MessageText, join); err != nil {
		t.Fatalf("write join: %v", err)
	}

	// Expect a state event naming alice as host.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		env, err := protocol.DecodeEnvelope(data)
		if err != nil || env.Type != protocol.EvtState {
			continue
		}
		if strings.Contains(string(env.Payload), `"host":"alice"`) {
			return // success
		}
	}
	t.Fatal("did not receive state with host=alice")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/ws/`
Expected: FAIL — undefined `Handler`.

- [ ] **Step 3: Write the client pumps**

`backend/internal/ws/client.go`:
```go
// Package ws bridges coder/websocket connections to a game room: it parses
// incoming commands into room Commands and writes broadcast state back out.
package ws

import (
	"context"
	"encoding/json"
	"log"

	"github.com/coder/websocket"

	"skoobl/internal/game"
	"skoobl/internal/protocol"
)

// serve runs the read and write pumps for one connection until it closes.
func serve(ctx context.Context, conn *websocket.Conn, room *game.Room, code string) {
	updates := make(chan game.GameState, 16)
	var player string

	// Write pump: drain state updates to the socket.
	go func() {
		for s := range updates {
			b, err := protocol.EncodeEvent(protocol.EvtState, s)
			if err != nil {
				continue
			}
			if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
				return
			}
		}
	}()

	// Read pump: parse commands; first join registers the subscriber channel.
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			break
		}
		env, err := protocol.DecodeEnvelope(data)
		if err != nil {
			writeError(ctx, conn, "malformed message")
			continue
		}
		cmd, name, ok := toCommand(env, updates, &player)
		if !ok {
			writeError(ctx, conn, "unknown or invalid command")
			continue
		}
		if name != "" {
			player = name
		}
		room.Submit(cmd)
	}

	// Disconnect: tell the room the player left.
	if player != "" {
		room.Submit(game.Command{Kind: game.CmdLeave, Player: player})
	}
	close(updates)
}

// toCommand maps a protocol envelope to a room Command. On a join it attaches
// the per-client subscribe channel. Returns ok=false for unknown commands.
func toCommand(env protocol.Envelope, sub chan game.GameState, player *string) (game.Command, string, bool) {
	switch env.Type {
	case protocol.CmdJoin:
		var p protocol.JoinPayload
		if json.Unmarshal(env.Payload, &p) != nil || p.Player == "" {
			return game.Command{}, "", false
		}
		return game.Command{Kind: game.CmdJoin, Player: p.Player, Subscribe: sub}, p.Player, true
	case protocol.CmdStart:
		return game.Command{Kind: game.CmdStart, Player: *player}, "", true
	case protocol.CmdNextPhase:
		return game.Command{Kind: game.CmdNextPhase, Player: *player}, "", true
	case protocol.CmdSubmitAnswer:
		var p protocol.SubmitAnswerPayload
		if json.Unmarshal(env.Payload, &p) != nil {
			return game.Command{}, "", false
		}
		return game.Command{Kind: game.CmdSubmitAnswer, Player: *player, Answer: p.Answer}, "", true
	default:
		return game.Command{}, "", false
	}
}

func writeError(ctx context.Context, conn *websocket.Conn, msg string) {
	b, err := protocol.EncodeEvent(protocol.EvtError, protocol.ErrorPayload{Message: msg})
	if err != nil {
		return
	}
	if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
		log.Printf("ws write error: %v", err)
	}
}
```

- [ ] **Step 4: Write the upgrade handler**

`backend/internal/ws/handler.go`:
```go
package ws

import (
	"net/http"

	"github.com/coder/websocket"

	"skoobl/internal/hub"
)

// Handler returns an http.Handler that upgrades /ws?code=<code> requests and
// serves them against the matching room.
func Handler(h *hub.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		room, ok := h.Lookup(code)
		if !ok {
			http.Error(w, "game not found", http.StatusNotFound)
			return
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true, // tighten with OriginPatterns in production
		})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		serve(r.Context(), conn, room, code)
	}
}
```

- [ ] **Step 5: Run the integration test (with race detector)**

Run: `cd backend && go test -race ./internal/ws/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/ws/
git commit -m "feat(backend): coder/websocket client pumps and upgrade handler"
```

---

## Task 9: Router + main + graceful shutdown

**Files:**
- Create: `backend/internal/router/router.go`
- Create: `backend/cmd/server/main.go`

- [ ] **Step 1: Write the router**

`backend/internal/router/router.go`:
```go
// Package router wires the chi router, middleware, and all handlers.
package router

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"skoobl/internal/httpapi"
	"skoobl/internal/hub"
	"skoobl/internal/ws"
)

// New builds the application router.
func New(h *hub.Hub) http.Handler {
	api := httpapi.New(h)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Logger)
	r.Use(corsMiddleware)

	r.Get("/healthz", api.Healthz)
	r.Post("/games", api.CreateGame)
	r.Handle("/ws", ws.Handler(h))
	return r
}

// corsMiddleware allows the SPA dev origin. Tighten the allowed origin for prod.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
```

- [ ] **Step 2: Write main with graceful shutdown**

`backend/cmd/server/main.go`:
```go
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"skoobl/internal/hub"
	"skoobl/internal/router"
)

func main() {
	h := hub.New()
	srv := &http.Server{
		Addr:    ":8080",
		Handler: router.New(h),
	}

	go func() {
		log.Printf("listening on %s", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
	log.Println("server stopped")
}
```

- [ ] **Step 3: Build the whole backend**

Run: `cd backend && go build ./...`
Expected: no output (success).

- [ ] **Step 4: Run the full test suite with race detector**

Run: `cd backend && go test -race ./...`
Expected: all PASS.

- [ ] **Step 5: Manual smoke test**

```bash
cd backend && go run ./cmd/server &
curl -s -X POST localhost:8080/games   # -> {"code":"xxxxxx"}
curl -s localhost:8080/healthz          # -> ok
kill %1
```
Expected: a 6-char code, then `ok`.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/router/ backend/cmd/
git commit -m "feat(backend): chi router, middleware, and graceful shutdown server"
```

---

# PHASE 2 — Frontend scaffold (Vite)

## Task 10: Replace Next.js with a Vite + React + TS scaffold

**Files:**
- Delete: `frontend/next.config.ts`, `frontend/app/`, `frontend/eslint.config.mjs`, `frontend/postcss.config.mjs`, `frontend/tailwind.config.ts`
- Create: `frontend/index.html`, `frontend/vite.config.ts`, `frontend/tsconfig.json`, `frontend/src/main.tsx`, `frontend/src/index.css`
- Modify: `frontend/package.json`

- [ ] **Step 1: Remove Next.js files**

```bash
cd frontend
git rm -r app next.config.ts eslint.config.mjs postcss.config.mjs tailwind.config.ts
rm -rf .next node_modules package-lock.json
```

- [ ] **Step 2: Write the new package.json**

`frontend/package.json`:
```json
{
  "name": "skoobl-frontend",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "@radix-ui/react-slot": "^1.1.1",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^1.17.0",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "react-router-dom": "^7.17.0",
    "tailwind-merge": "^2.6.0",
    "tw-animate-css": "^1.4.0",
    "zustand": "^5.0.14"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.0",
    "@testing-library/react": "^16.3.2",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^6.0.2",
    "jsdom": "^25.0.0",
    "tailwindcss": "^4.3.0",
    "typescript": "^5.7.0",
    "vite": "^8.0.16",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **Step 3: Write the Vite config (React + Tailwind 4 plugin + vitest)**

`frontend/vite.config.ts`:
```ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
```

- [ ] **Step 4: Write tsconfig.json**

`frontend/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] },
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Write index.html, entry, and Tailwind 4 CSS**

`frontend/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>skoobl</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`frontend/src/index.css`:
```css
@import "tailwindcss";
@import "tw-animate-css";

@theme {
  --color-background: #ffffff;
  --color-foreground: #0a0a0a;
  --color-primary: #4f46e5;
  --color-primary-foreground: #ffffff;
  --radius: 0.5rem;
}

body {
  background-color: var(--color-background);
  color: var(--color-foreground);
}
```

`frontend/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

- [ ] **Step 6: Install and verify dev server boots**

```bash
cd frontend && npm install
npm run build
```
Expected: build succeeds (App created in Task 13; if running before then, create a stub `src/App.tsx` returning `null`).

- [ ] **Step 7: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): replace Next.js with Vite + React + Tailwind 4 scaffold"
```

---

## Task 11: Port utils + shadcn button/input to Tailwind 4

**Files:**
- Create: `frontend/src/lib/utils.ts`, `frontend/src/components/ui/button.tsx`, `frontend/src/components/ui/input.tsx`

- [ ] **Step 1: Port the cn helper**

`frontend/src/lib/utils.ts`:
```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 2: Port the button (Tailwind 4 utility classes)**

`frontend/src/components/ui/button.tsx`:
```tsx
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-90",
        outline: "border border-foreground/20 hover:bg-foreground/5",
      },
      size: {
        default: "h-10 px-4 py-2",
        lg: "h-12 px-8 text-base",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
```

- [ ] **Step 3: Port the input**

`frontend/src/components/ui/input.tsx`:
```tsx
import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "flex h-10 w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
```

- [ ] **Step 4: Type-check**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/utils.ts frontend/src/components/ui/
git commit -m "feat(frontend): port cn, button, input to Tailwind 4"
```

---

# PHASE 3 — Frontend integration

## Task 12: Protocol types + zustand store (TDD)

**Files:**
- Create: `frontend/src/lib/protocol.ts`, `frontend/src/lib/store.ts`
- Test: `frontend/src/lib/store.test.ts`

- [ ] **Step 1: Write the protocol types (mirror of Go)**

`frontend/src/lib/protocol.ts`:
```ts
// Mirrors backend/internal/protocol and internal/game state types.
export type Phase = "lobby" | "inRound" | "reveal" | "ended";

export interface Player {
  name: string;
  answer?: string;
}

export interface GameState {
  code: string;
  phase: Phase;
  host: string;
  players: Player[];
}

export type CommandType =
  | "join"
  | "leave"
  | "start"
  | "submitAnswer"
  | "nextPhase";

export type EventType = "state" | "error" | "gameEnded";

export interface Envelope<T = unknown> {
  type: CommandType | EventType;
  payload?: T;
}

export const cmd = {
  join: (player: string): Envelope => ({ type: "join", payload: { player } }),
  start: (): Envelope => ({ type: "start" }),
  nextPhase: (): Envelope => ({ type: "nextPhase" }),
  submitAnswer: (answer: string): Envelope => ({
    type: "submitAnswer",
    payload: { answer },
  }),
};
```

- [ ] **Step 2: Write the failing store test**

`frontend/src/lib/store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useGameStore } from "./store";
import type { GameState } from "./protocol";

const sample: GameState = {
  code: "abc123",
  phase: "lobby",
  host: "alice",
  players: [{ name: "alice" }],
};

describe("useGameStore", () => {
  beforeEach(() => useGameStore.getState().reset());

  it("applies a state event", () => {
    useGameStore.getState().applyState(sample);
    const s = useGameStore.getState();
    expect(s.host).toBe("alice");
    expect(s.players).toHaveLength(1);
    expect(s.phase).toBe("lobby");
  });

  it("records an error and clears it", () => {
    useGameStore.getState().setError("nope");
    expect(useGameStore.getState().error).toBe("nope");
    useGameStore.getState().setError(null);
    expect(useGameStore.getState().error).toBeNull();
  });

  it("reset clears state", () => {
    useGameStore.getState().applyState(sample);
    useGameStore.getState().reset();
    expect(useGameStore.getState().players).toHaveLength(0);
    expect(useGameStore.getState().code).toBe("");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/store.test.ts`
Expected: FAIL — cannot find `./store`.

- [ ] **Step 4: Write the store**

`frontend/src/lib/store.ts`:
```ts
import { create } from "zustand";
import type { GameState, Phase, Player } from "./protocol";

interface GameStore {
  code: string;
  phase: Phase;
  host: string;
  players: Player[];
  self: string;
  error: string | null;
  setSelf: (name: string) => void;
  applyState: (s: GameState) => void;
  setError: (msg: string | null) => void;
  reset: () => void;
}

const initial = {
  code: "",
  phase: "lobby" as Phase,
  host: "",
  players: [] as Player[],
  self: "",
  error: null as string | null,
};

export const useGameStore = create<GameStore>((set) => ({
  ...initial,
  setSelf: (name) => set({ self: name }),
  applyState: (s) =>
    set({ code: s.code, phase: s.phase, host: s.host, players: s.players }),
  setError: (msg) => set({ error: msg }),
  reset: () => set({ ...initial }),
}));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/protocol.ts frontend/src/lib/store.ts frontend/src/lib/store.test.ts
git commit -m "feat(frontend): protocol types and zustand game store"
```

---

## Task 13: useGameSocket hook (TDD with mock WS) + App routes

**Files:**
- Create: `frontend/src/hooks/use-game-socket.ts`, `frontend/src/App.tsx`
- Create: `frontend/src/pages/Home.tsx`, `frontend/src/pages/Host.tsx`, `frontend/src/pages/Play.tsx`
- Test: `frontend/src/hooks/use-game-socket.test.ts`

- [ ] **Step 1: Write the failing hook test (mock WebSocket)**

`frontend/src/hooks/use-game-socket.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useGameSocket } from "./use-game-socket";
import { useGameStore } from "@/lib/store";

class MockWS {
  static last: MockWS;
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    MockWS.last = this;
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe("useGameSocket", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", MockWS as unknown as typeof WebSocket);
    useGameStore.getState().reset();
  });

  it("sends join on open and applies state events", async () => {
    const { result } = renderHook(() => useGameSocket("abc123", "alice"));
    act(() => MockWS.last.open());

    // join command sent on open
    expect(MockWS.last.sent.some((m) => m.includes('"join"'))).toBe(true);

    act(() =>
      MockWS.last.emit({
        type: "state",
        payload: {
          code: "abc123",
          phase: "lobby",
          host: "alice",
          players: [{ name: "alice" }],
        },
      }),
    );
    await waitFor(() =>
      expect(useGameStore.getState().host).toBe("alice"),
    );

    // send() forwards a command
    act(() => result.current.send({ type: "start" }));
    expect(MockWS.last.sent.some((m) => m.includes('"start"'))).toBe(true);
  });

  it("applies error events", async () => {
    renderHook(() => useGameSocket("abc123", "alice"));
    act(() => MockWS.last.open());
    act(() =>
      MockWS.last.emit({ type: "error", payload: { message: "nope" } }),
    );
    await waitFor(() =>
      expect(useGameStore.getState().error).toBe("nope"),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/hooks/use-game-socket.test.ts`
Expected: FAIL — cannot find `./use-game-socket`.

- [ ] **Step 3: Write the hook**

`frontend/src/hooks/use-game-socket.ts`:
```ts
import { useCallback, useEffect, useRef } from "react";
import { useGameStore } from "@/lib/store";
import { cmd, type Envelope, type GameState } from "@/lib/protocol";

const WS_BASE =
  import.meta.env.VITE_WS_BASE ?? "ws://localhost:8080/ws";
const MAX_BACKOFF = 5000;

export function useGameSocket(code: string, player: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const backoff = useRef(500);
  const closedRef = useRef(false);

  const send = useCallback((env: Envelope) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(env));
    }
  }, []);

  useEffect(() => {
    if (!code || !player) return;
    closedRef.current = false;
    useGameStore.getState().setSelf(player);

    const connect = () => {
      const ws = new WebSocket(`${WS_BASE}?code=${encodeURIComponent(code)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        backoff.current = 500;
        ws.send(JSON.stringify(cmd.join(player))); // resync on every (re)connect
      };
      ws.onmessage = (e) => {
        const env = JSON.parse(e.data) as Envelope;
        if (env.type === "state") {
          useGameStore.getState().applyState(env.payload as GameState);
        } else if (env.type === "error") {
          useGameStore.getState().setError(
            (env.payload as { message: string }).message,
          );
        }
      };
      ws.onclose = () => {
        if (closedRef.current) return;
        const delay = backoff.current;
        backoff.current = Math.min(delay * 2, MAX_BACKOFF);
        setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closedRef.current = true;
      wsRef.current?.close();
    };
  }, [code, player]);

  return { send };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/hooks/use-game-socket.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write minimal pages + App routes**

`frontend/src/pages/Home.tsx`:
```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const API = import.meta.env.VITE_API_BASE ?? "http://localhost:8080";

export default function Home() {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const nav = useNavigate();

  const host = async () => {
    const res = await fetch(`${API}/games`, { method: "POST" });
    const { code } = (await res.json()) as { code: string };
    nav(`/host/${code}?name=${encodeURIComponent(name || "host")}`);
  };
  const join = () =>
    nav(`/play/${code}?name=${encodeURIComponent(name)}`);

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-8">
      <h1 className="text-3xl font-bold">skoobl</h1>
      <Input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
      <Button size="lg" onClick={host}>Host a game</Button>
      <div className="flex gap-2">
        <Input placeholder="Game code" value={code} onChange={(e) => setCode(e.target.value)} />
        <Button variant="outline" onClick={join}>Join</Button>
      </div>
    </main>
  );
}
```

`frontend/src/pages/Host.tsx`:
```tsx
import { useParams, useSearchParams } from "react-router-dom";
import { useGameSocket } from "@/hooks/use-game-socket";
import { useGameStore } from "@/lib/store";
import { cmd } from "@/lib/protocol";
import { Button } from "@/components/ui/button";

export default function Host() {
  const { code = "" } = useParams();
  const [params] = useSearchParams();
  const name = params.get("name") ?? "host";
  const { send } = useGameSocket(code, name);
  const { phase, players } = useGameStore();

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 p-8">
      <h1 className="text-2xl font-bold">Room {code}</h1>
      <p className="text-sm opacity-70">Phase: {phase}</p>
      <ul className="flex flex-col gap-1">
        {players.map((p) => (
          <li key={p.name} className="rounded bg-foreground/5 px-3 py-2">{p.name}</li>
        ))}
      </ul>
      {phase === "lobby" && <Button onClick={() => send(cmd.start())}>Start</Button>}
      {(phase === "inRound" || phase === "reveal") && (
        <Button onClick={() => send(cmd.nextPhase())}>Next</Button>
      )}
    </main>
  );
}
```

`frontend/src/pages/Play.tsx`:
```tsx
import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useGameSocket } from "@/hooks/use-game-socket";
import { useGameStore } from "@/lib/store";
import { cmd } from "@/lib/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function Play() {
  const { code = "" } = useParams();
  const [params] = useSearchParams();
  const name = params.get("name") ?? "player";
  const { send } = useGameSocket(code, name);
  const { phase, error } = useGameStore();
  const [answer, setAnswer] = useState("");

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-8">
      <h1 className="text-xl font-bold">{name}</h1>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <p className="text-sm opacity-70">Phase: {phase}</p>
      {phase === "inRound" && (
        <div className="flex gap-2">
          <Input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer" />
          <Button onClick={() => send(cmd.submitAnswer(answer))}>Submit</Button>
        </div>
      )}
      {phase === "lobby" && <p>Waiting for host to start…</p>}
    </main>
  );
}
```

`frontend/src/App.tsx`:
```tsx
import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Host from "./pages/Host";
import Play from "./pages/Play";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/host/:code" element={<Host />} />
      <Route path="/play/:code" element={<Play />} />
    </Routes>
  );
}
```

- [ ] **Step 6: Type-check, test, and build everything**

Run: `cd frontend && npx tsc -b && npx vitest run && npm run build`
Expected: type-check clean, all tests PASS, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/
git commit -m "feat(frontend): typed useGameSocket hook, routed pages, game UI"
```

---

## Task 14: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Start Redis, backend, frontend**

```bash
docker run -d -p 6379:6379 --name skoobl-redis redis:7   # if not already running
(cd backend && go run ./cmd/server &)
(cd frontend && npm run dev)
```

- [ ] **Step 2: Drive the flow in two browser tabs**

1. Tab A → `http://localhost:5173/` → enter name "alice" → Host a game → lands on `/host/<code>`.
2. Tab B → `http://localhost:5173/` → name "bob", paste `<code>`, Join → `/play/<code>`.
3. Confirm Tab A player list shows alice + bob live.
4. Tab A → Start → both tabs show phase `inRound`.
5. Tab B → type answer, Submit → Tab A reflects state.
6. Tab A → Next → phase `reveal`; Next again → `ended`.

Expected: all transitions propagate over WS in real time; closing/reopening Tab B reconnects and resyncs.

- [ ] **Step 3: Final full-suite check**

```bash
(cd backend && go test -race ./...)
(cd frontend && npx vitest run && npm run build)
```
Expected: all green.

---

## Self-Review notes

- **Spec coverage:** versions table (Task 1, 10), Chi router + middleware (Task 9), room-actor (Task 4), hub (Task 5), Redis snapshot/pubsub (Task 6), typed protocol both sides (Task 2, 12), coder/websocket pumps + keepalive/close (Task 8), basic phase machine `lobby→inRound→reveal→ended` (Task 4), Vite migration (Task 10), Tailwind 4 (Task 10–11), zustand store (Task 12), useGameSocket with backoff + resync (Task 13), routing home/host/play (Task 13), TDD across all logic tasks. Graphify intentionally absent (out of scope).
- **Type consistency:** Go `Command{Kind,Player,Answer,Subscribe}`, `GameState{Code,Phase,Host,Players}`, `protocol.Envelope{Type,Payload}` used consistently across Tasks 2/4/8. TS `cmd.*` builders and `applyState` match the hook in Task 13.
- **Known follow-ups (not in this plan):** wiring `store` into the room broadcast path for cross-instance pub/sub and reconnect-from-snapshot is scaffolded but single-instance for v1 (per spec out-of-scope). Add when scaling past one instance.
