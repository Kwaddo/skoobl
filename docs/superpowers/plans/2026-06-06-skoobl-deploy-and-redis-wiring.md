# skoobl Deploy Infra + Redis Wiring + Origin Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make skoobl deployable to a single Dilmune Cloud VPS (Docker Compose + edge-nginx server block) and wire Redis snapshot persistence + restore-on-miss into the Go backend, with same-origin-by-default origin hardening.

**Architecture:** Dilmune's edge nginx terminates TLS, serves the static SPA from `/var/www/skoobl`, and reverse-proxies `/games`, `/ws`, `/healthz` to a loopback-published Go backend container. The backend persists each room's state to Redis after every broadcast and rehydrates rooms from Redis on a registry miss, so rooms survive restarts and clients can reconnect. CORS and WebSocket origin checks are driven by a single `ALLOWED_ORIGINS` env var, locked to same-origin when empty.

**Tech Stack:** Go 1.26, go-chi/chi v5, coder/websocket v1.8, go-redis v9, miniredis v2 (tests); Docker Compose, nginx; Vite + React SPA.

---

## File Structure

**Backend (modify):**
- `backend/internal/game/room.go` — add `Snapshotter` interface, `snap` field, `persist()`, new constructors.
- `backend/internal/game/room_test.go` — snapshot behavior tests.
- `backend/internal/hub/hub.go` — `Store` interface, functional options, store-aware `Create`, restore-on-miss `Lookup`.
- `backend/internal/hub/hub_test.go` — restore tests with a fake store.
- `backend/internal/router/router.go` — env-driven CORS.
- `backend/internal/ws/handler.go` — env-driven WS origin check.
- `backend/internal/ws/handler_test.go` — update `Handler` call; origin test.
- `backend/internal/httpapi/handlers_test.go` — update `hub.New` call only if signature breaks (it won't — options are variadic).
- `backend/cmd/server/main.go` — Redis client + config wiring.
- `frontend/src/hooks/use-game-socket.ts` — runtime-derived WS URL.

**Infra (create):**
- `backend/Dockerfile`, `backend/.dockerignore`
- `infra/compose.yaml`
- `infra/nginx/skoobl.conf`
- `infra/.env.example`
- `infra/README.md`

---

## Task 1: game — Snapshotter interface, persist-on-broadcast, constructors

**Files:**
- Modify: `backend/internal/game/room.go`
- Test: `backend/internal/game/room_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/internal/game/room_test.go`:

```go
// fakeSnap records every SaveSnapshot call. Safe for single-room tests because
// the room goroutine is the only caller.
type fakeSnap struct {
	mu    sync.Mutex
	saves map[string][]byte
}

func newFakeSnap() *fakeSnap { return &fakeSnap{saves: map[string][]byte{}} }

func (f *fakeSnap) SaveSnapshot(_ context.Context, code string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.saves[code] = data
	return nil
}

func (f *fakeSnap) last(code string) ([]byte, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.saves[code]
	return b, ok
}

func TestRoomPersistsAfterStateChange(t *testing.T) {
	snap := newFakeSnap()
	r := NewRoomWithStore("persist1", snap)
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 8)
	r.Submit(Command{Kind: CmdJoin, Player: "alice", Subscribe: sub})
	nextState(t, sub)

	// Poll briefly: persist happens inside the room goroutine after broadcast.
	var data []byte
	for i := 0; i < 20; i++ {
		if b, ok := snap.last("persist1"); ok {
			data = b
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if data == nil {
		t.Fatal("no snapshot saved after join")
	}
	var gs GameState
	if err := json.Unmarshal(data, &gs); err != nil {
		t.Fatalf("snapshot not valid GameState json: %v", err)
	}
	if gs.Host != "alice" {
		t.Fatalf("snapshot host = %q, want alice", gs.Host)
	}
}

func TestNewRoomFromSnapshotRestoresState(t *testing.T) {
	original := GameState{Code: "restore1", Phase: PhaseInRound, Host: "bob",
		Players: []Player{{Name: "bob"}, {Name: "carol"}}}
	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	r, err := NewRoomFromSnapshot("restore1", data, nil)
	if err != nil {
		t.Fatalf("NewRoomFromSnapshot: %v", err)
	}
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 8)
	// Joining a brand-new player triggers a broadcast carrying restored state.
	r.Submit(Command{Kind: CmdJoin, Player: "dave", Subscribe: sub})
	s := nextState(t, sub)
	if s.Host != "bob" || s.Phase != PhaseInRound {
		t.Fatalf("restored state lost: host=%q phase=%q", s.Host, s.Phase)
	}
	if len(s.Players) != 3 {
		t.Fatalf("players = %d, want 3 (2 restored + dave)", len(s.Players))
	}
}

func TestNilSnapshotterDoesNotPanic(t *testing.T) {
	r := NewRoom("nilsnap") // snap is nil
	go r.Run()
	defer r.Stop()
	sub := make(chan GameState, 8)
	r.Submit(Command{Kind: CmdJoin, Player: "alice", Subscribe: sub})
	nextState(t, sub) // would panic on persist if nil not guarded
}
```

Add imports to the test file's import block: `"context"`, `"encoding/json"`, `"sync"` (alongside existing `"testing"`, `"time"`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'Persist|FromSnapshot|NilSnap' -v`
Expected: FAIL — `undefined: NewRoomWithStore`, `undefined: NewRoomFromSnapshot`.

- [ ] **Step 3: Implement in `backend/internal/game/room.go`**

Add `context`, `encoding/json`, `time` to the import block:

```go
import (
	"context"
	"encoding/json"
	"log"
	"time"
)
```

Add the interface above the `Room` type:

```go
// Snapshotter persists a room's serialized state. Implemented by
// store.RedisStore. A nil Snapshotter disables persistence (in-memory mode).
type Snapshotter interface {
	SaveSnapshot(ctx context.Context, code string, data []byte) error
}
```

Add a `snap` field to `Room`:

```go
type Room struct {
	state GameState
	cmds  chan Command
	done  chan struct{}
	subs  []chan GameState
	snap  Snapshotter
}
```

Replace `NewRoom` and add the two new constructors:

```go
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
```

In `Run`, persist after broadcast. Change the command branch:

```go
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
```

Add the `persist` method at the end of the file:

```go
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/game/ -v`
Expected: PASS (new tests + existing room tests).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/game/room.go backend/internal/game/room_test.go
git commit -m "feat(game): persist room state to Snapshotter + restore constructor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: hub — Store interface, functional options, restore-on-miss

**Files:**
- Modify: `backend/internal/hub/hub.go`
- Test: `backend/internal/hub/hub_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `backend/internal/hub/hub_test.go`:

```go
// fakeStore is an in-memory hub.Store for tests.
type fakeStore struct {
	mu   sync.Mutex
	data map[string][]byte
}

func newFakeStore() *fakeStore { return &fakeStore{data: map[string][]byte{}} }

func (f *fakeStore) SaveSnapshot(_ context.Context, code string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.data[code] = data
	return nil
}

func (f *fakeStore) LoadSnapshot(_ context.Context, code string) ([]byte, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.data[code]
	return b, ok, nil
}

func TestLookupRestoresFromStoreOnMiss(t *testing.T) {
	store := newFakeStore()
	// Seed a snapshot for a code the registry has never seen.
	snap := []byte(`{"code":"seed01","phase":"inRound","host":"alice","players":[{"name":"alice"}]}`)
	store.data["seed01"] = snap

	h := New(WithStore(store))
	room, ok := h.Lookup("seed01")
	if !ok || room == nil {
		t.Fatal("Lookup did not restore room from store snapshot")
	}
	// Restored room is running and serves the restored state.
	sub := make(chan game.GameState, 8)
	room.Submit(game.Command{Kind: game.CmdJoin, Player: "bob", Subscribe: sub})
	select {
	case s := <-sub:
		if s.Host != "alice" {
			t.Fatalf("restored host = %q, want alice", s.Host)
		}
	case <-time.After(time.Second):
		t.Fatal("restored room did not broadcast")
	}
}

func TestLookupMissWithoutSnapshotReturnsFalse(t *testing.T) {
	h := New(WithStore(newFakeStore()))
	if _, ok := h.Lookup("nope99"); ok {
		t.Fatal("Lookup returned a room for an unknown code")
	}
}

func TestCreatedRoomsPersist(t *testing.T) {
	store := newFakeStore()
	h := New(WithStore(store))
	code, room := h.Create()
	room.Submit(game.Command{Kind: game.CmdJoin, Player: "alice", Subscribe: make(chan game.GameState, 8)})
	for i := 0; i < 20; i++ {
		store.mu.Lock()
		_, ok := store.data[code]
		store.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("created room never persisted a snapshot")
}
```

Add imports to the test file: `"context"`, `"time"`, and `"skoobl/internal/game"` (alongside existing `"sync"`, `"testing"`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/hub/ -run 'Restore|MissWithout|Persist' -v`
Expected: FAIL — `undefined: WithStore`.

- [ ] **Step 3: Implement in `backend/internal/hub/hub.go`**

Add `context` to the import block:

```go
import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"

	"skoobl/internal/game"
)
```

Add the `Store` interface and option type above `Hub`:

```go
// Store is the persistence the hub needs to restore rooms after a restart.
// Satisfied by store.RedisStore.
type Store interface {
	SaveSnapshot(ctx context.Context, code string, data []byte) error
	LoadSnapshot(ctx context.Context, code string) (data []byte, ok bool, err error)
}

// Option configures a Hub.
type Option func(*Hub)

// WithStore enables Redis-backed persistence and restore-on-miss.
func WithStore(s Store) Option { return func(h *Hub) { h.store = s } }
```

Add the `store` field and update `New`:

```go
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]*game.Room
	store Store
}

func New(opts ...Option) *Hub {
	h := &Hub{rooms: make(map[string]*game.Room)}
	for _, opt := range opts {
		opt(h)
	}
	return h
}
```

Update `Create` to give rooms the store:

```go
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
	var r *game.Room
	if h.store != nil {
		r = game.NewRoomWithStore(code, h.store)
	} else {
		r = game.NewRoom(code)
	}
	go r.Run()
	h.rooms[code] = r
	return code, r
}
```

Replace `Lookup` with the restore-on-miss version:

```go
// Lookup returns the room for a code, rehydrating it from the store if the
// registry has no live room but a snapshot exists.
func (h *Hub) Lookup(code string) (*game.Room, bool) {
	h.mu.RLock()
	r, ok := h.rooms[code]
	h.mu.RUnlock()
	if ok {
		return r, true
	}
	if h.store == nil {
		return nil, false
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	data, found, err := h.store.LoadSnapshot(ctx, code)
	if err != nil || !found {
		return nil, false
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	if r, ok := h.rooms[code]; ok { // another goroutine restored it first
		return r, true
	}
	restored, err := game.NewRoomFromSnapshot(code, data, h.store)
	if err != nil {
		return nil, false
	}
	go restored.Run()
	h.rooms[code] = restored
	return restored, true
}
```

Add `"time"` to the import block (used by the context timeout). Final import block:

```go
import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"skoobl/internal/game"
)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/hub/ -v`
Expected: PASS (new tests + existing `TestCreateLookupDelete`, `TestConcurrentCreate` — both still call `New()` with no options).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/hub/hub.go backend/internal/hub/hub_test.go
git commit -m "feat(hub): Store option + restore rooms from snapshot on lookup miss

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: origin hardening — env-driven CORS + WS origin check

**Files:**
- Modify: `backend/internal/router/router.go`
- Modify: `backend/internal/ws/handler.go`
- Test: `backend/internal/ws/handler_test.go`

- [ ] **Step 1: Write the failing test**

In `backend/internal/ws/handler_test.go`, update the existing call `Handler(h)` to `Handler(h, nil)`. Then append a new test:

```go
func TestWebSocketRejectsDisallowedOriginWhenRestricted(t *testing.T) {
	h := hub.New()
	code, _ := h.Create()

	// Only example.com is allowed; the dial sets a different Origin.
	srv := httptest.NewServer(Handler(h, []string{"example.com"}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?code=" + code

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: map[string][]string{"Origin": {"http://evil.test"}},
	})
	if err == nil {
		t.Fatal("dial with disallowed origin succeeded, want rejection")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/ws/ -run 'RejectsDisallowed' -v`
Expected: FAIL — `too many arguments in call to Handler` (signature not updated yet).

- [ ] **Step 3: Implement**

Replace `backend/internal/ws/handler.go` `Handler`:

```go
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
			return
		}
		defer conn.CloseNow()
		serve(r.Context(), conn, room, code)
	}
}
```

Replace `backend/internal/router/router.go` to make CORS env-driven. New `New` signature and middleware:

```go
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
```

Add `"strings"` to the `router.go` import block (used by `hostsOf`). Final import block:

```go
import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"skoobl/internal/httpapi"
	"skoobl/internal/hub"
	"skoobl/internal/ws"
)
```

Note: `ws` OriginPatterns match the Origin **host**, while CORS matches the full Origin URL. `router.New` keeps the full origins for CORS and feeds the host-stripped form (`hostsOf`) to `ws.Handler`. `main.go` (Task 4) passes one `ALLOWED_ORIGINS` list in full origin form (e.g. `http://localhost:5173`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/ws/ ./internal/router/ -v`
Expected: PASS — disallowed-origin dial is rejected; the existing same-origin `TestWebSocketJoinBroadcastsState` (now `Handler(h, nil)`) still connects (Dial sets no Origin → accepted).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/ws/handler.go backend/internal/router/router.go backend/internal/ws/handler_test.go
git commit -m "feat(http): env-driven CORS + WS origin check, same-origin by default

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: main.go — wire Redis client + config

**Files:**
- Modify: `backend/cmd/server/main.go`

- [ ] **Step 1: Implement the wiring**

Replace `backend/cmd/server/main.go` with the following. This includes the
`-healthcheck` subcommand used by the compose healthcheck (Task 6) so `main.go`
is only written once. `router.New` (Task 3) receives the full origin list and
does its own host-stripping for the WS check, so `main.go` only needs `splitEnv`.

```go
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"skoobl/internal/hub"
	"skoobl/internal/router"
	"skoobl/internal/store"
)

func main() {
	// Container healthcheck: exec the same binary with -healthcheck. Works in a
	// distroless image with no shell or curl.
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		resp, err := http.Get("http://127.0.0.1:8080/healthz")
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}

	allowedOrigins := splitEnv(os.Getenv("ALLOWED_ORIGINS"))

	var (
		h           *hub.Hub
		redisClient *redis.Client
	)
	if addr := os.Getenv("REDIS_ADDR"); addr != "" {
		redisClient = redis.NewClient(&redis.Options{Addr: addr})
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := redisClient.Ping(ctx).Err(); err != nil {
			cancel()
			log.Fatalf("redis ping %s: %v", addr, err)
		}
		cancel()
		h = hub.New(hub.WithStore(store.NewRedisStore(redisClient, snapshotTTL())))
		log.Printf("redis persistence enabled at %s (ttl %s)", addr, snapshotTTL())
	} else {
		h = hub.New()
		log.Print("redis not configured; running in-memory")
	}

	srv := &http.Server{
		Addr:    ":8080",
		Handler: router.New(h, allowedOrigins),
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
	if redisClient != nil {
		if err := redisClient.Close(); err != nil {
			log.Printf("redis close failed: %v", err)
		}
	}
	log.Println("server stopped")
}

// snapshotTTL reads SNAPSHOT_TTL (Go duration), defaulting to 1h.
func snapshotTTL() time.Duration {
	if v := os.Getenv("SNAPSHOT_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		log.Printf("invalid SNAPSHOT_TTL %q; using 1h", v)
	}
	return time.Hour
}

// splitEnv parses a comma-separated list, trimming spaces and empties.
func splitEnv(v string) []string {
	if v == "" {
		return nil
	}
	var out []string
	for _, p := range strings.Split(v, ",") {
		if s := strings.TrimSpace(p); s != "" {
			out = append(out, s)
		}
	}
	return out
}
```

- [ ] **Step 2: Verify build + full test suite**

Run: `cd backend && go build ./... && go test ./...`
Expected: build OK; all packages PASS. `go-redis` already in `go.mod`.

- [ ] **Step 3: Manual smoke (in-memory path)**

Run:
```bash
cd backend && go run ./cmd/server &
sleep 1
curl -s -X POST localhost:8080/games
curl -s localhost:8080/healthz
kill %1
```
Expected: `{"code":"..."}` then `ok`. Log shows "redis not configured; running in-memory".

- [ ] **Step 4: Commit**

```bash
git add backend/cmd/server/main.go backend/internal/router/router.go
git commit -m "feat(server): wire Redis store + SNAPSHOT_TTL + ALLOWED_ORIGINS config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: backend Dockerfile + .dockerignore

**Files:**
- Create: `backend/Dockerfile`
- Create: `backend/.dockerignore`

- [ ] **Step 1: Create `backend/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /server
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/server"]
```

- [ ] **Step 2: Create `backend/.dockerignore`**

```
.git
*_test.go
Dockerfile
.dockerignore
README.md
```

- [ ] **Step 3: Verify the image builds**

Run: `cd backend && docker build -t skoobl-backend:dev .`
Expected: build succeeds; final image is the distroless binary. (If `golang:1.26-alpine` is unavailable, fall back to `golang:1.25-alpine` — the `go.mod` `go 1.26` directive needs a toolchain ≥ that; with the `toolchain` auto-download this still works on 1.25 base.)

- [ ] **Step 4: Commit**

```bash
git add backend/Dockerfile backend/.dockerignore
git commit -m "build(backend): multi-stage distroless Dockerfile

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: infra compose.yaml

**Files:**
- Create: `infra/compose.yaml`

- [ ] **Step 1: Create `infra/compose.yaml`**

```yaml
name: skoobl

services:
  backend:
    build:
      context: ../backend
    environment:
      REDIS_ADDR: redis:6379
      SNAPSHOT_TTL: ${SNAPSHOT_TTL:-1h}
      ALLOWED_ORIGINS: ${ALLOWED_ORIGINS:-}
    ports:
      - "127.0.0.1:8080:8080"   # loopback only; Dilmune nginx proxies to this
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "/server", "-healthcheck"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 5s

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--save", "60", "1", "--appendonly", "no"]
    volumes:
      - redis-data:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

volumes:
  redis-data:
```

Note: the backend healthcheck execs the binary with `-healthcheck`, which the
distroless image can run without a shell or curl. That subcommand was already
added to `main.go` in Task 4 — no further `main.go` change is needed here.

- [ ] **Step 2: Validate compose**

Run: `cd infra && docker compose config`
Expected: parses and prints the resolved config with no errors.

- [ ] **Step 3: Commit**

```bash
git add infra/compose.yaml
git commit -m "build(infra): docker compose for backend + redis, loopback-published

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: infra nginx server block

**Files:**
- Create: `infra/nginx/skoobl.conf`

- [ ] **Step 1: Create `infra/nginx/skoobl.conf`**

```nginx
# Dilmune edge nginx server block for skoobl.
# TLS is terminated here by Dilmune. The SPA is static; /games, /ws, /healthz
# proxy to the loopback-published Go backend container.

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name skoobl.example.com;   # replace with the real Dilmune hostname

    # ssl_certificate / ssl_certificate_key are managed by Dilmune's TLS setup.

    root /var/www/skoobl;
    index index.html;

    # Static SPA with client-side routing fallback.
    location / {
        try_files $uri $uri/ /index.html;
    }

    # REST: create a game.
    location = /games {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Liveness probe passthrough.
    location = /healthz {
        proxy_pass http://127.0.0.1:8080;
    }

    # WebSocket upgrade + long-lived connection timeouts.
    location = /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

# Redirect plain HTTP to HTTPS (Dilmune may already handle this; harmless if so).
server {
    listen 80;
    listen [::]:80;
    server_name skoobl.example.com;
    return 301 https://$host$request_uri;
}
```

- [ ] **Step 2: Validate syntax**

Run (throwaway nginx in Docker, syntax test only):
```bash
docker run --rm -v "$PWD/infra/nginx/skoobl.conf:/etc/nginx/conf.d/skoobl.conf:ro" nginx:alpine nginx -t
```
Expected: `nginx: configuration file /etc/nginx/nginx.conf test is successful`. (An `ssl_certificate` warning is acceptable — Dilmune injects the cert paths; if `nginx -t` fails only on missing cert directives, that confirms syntax is otherwise valid.)

- [ ] **Step 3: Commit**

```bash
git add infra/nginx/skoobl.conf
git commit -m "build(infra): nginx server block for SPA + backend proxy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: frontend — runtime-derived WS URL

**Files:**
- Modify: `frontend/src/hooks/use-game-socket.ts:5`

- [ ] **Step 1: Replace the WS_BASE constant**

Current line 5:
```ts
const WS_BASE = import.meta.env.VITE_WS_BASE ?? "ws://localhost:8080/ws";
```

Replace with:
```ts
// Prefer an explicit override (dev). Otherwise derive from the page origin so
// the static build is host-agnostic: https→wss, http→ws, same host, /ws path.
function defaultWsBase(): string {
  if (typeof window === "undefined") return "ws://localhost:8080/ws";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}
const WS_BASE = import.meta.env.VITE_WS_BASE ?? defaultWsBase();
```

- [ ] **Step 2: Verify typecheck + tests**

Run: `cd frontend && npm run typecheck && npm test`
Expected: typecheck clean; `use-game-socket` tests pass (they set `VITE_WS_BASE` or mock WS, so the override path is exercised). If a test relied on the old default string, update it to set `VITE_WS_BASE` explicitly.

- [ ] **Step 3: Verify API base is relative for prod build**

Confirm `frontend/src/routes/index.tsx:6` uses `import.meta.env.VITE_API_BASE ?? "http://localhost:8080"`. For a prod build run with `VITE_API_BASE=` (empty), `${API}/games` becomes `/games` (same-origin). No code change needed; documented in the README (Task 9).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/use-game-socket.ts
git commit -m "feat(frontend): derive WS URL from page origin for host-agnostic build

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: infra env example + deploy runbook

**Files:**
- Create: `infra/.env.example`
- Create: `infra/README.md`

- [ ] **Step 1: Create `infra/.env.example`**

```bash
# Copy to infra/.env and adjust. docker compose reads it automatically.

# Snapshot TTL for room state in Redis (Go duration). Rooms expire after this.
SNAPSHOT_TTL=1h

# Cross-origin allowlist (comma-separated full origins). LEAVE EMPTY IN PROD:
# the SPA is served same-origin behind Dilmune nginx, so no CORS is needed.
# For local cross-origin dev (Vite on :5173 hitting the backend), set e.g.:
# ALLOWED_ORIGINS=http://localhost:5173
ALLOWED_ORIGINS=
```

- [ ] **Step 2: Create `infra/README.md`**

```markdown
# skoobl Deployment (Dilmune Cloud, single VPS)

Architecture: Dilmune edge nginx terminates TLS, serves the static SPA, and
reverse-proxies `/games`, `/ws`, `/healthz` to the Go backend container
(published on `127.0.0.1:8080`). Redis runs as a sibling container on the
compose-internal network and is never exposed.

```
Dilmune nginx (:443 TLS) ── / ──────────────→ /var/www/skoobl (SPA)
                         └─ /games,/ws,/healthz → 127.0.0.1:8080 (backend)
backend ──→ redis:6379 (compose-internal)
```

## Prerequisites
- Docker + Docker Compose on the VPS.
- Dilmune nginx managing TLS for the chosen hostname.
- Node 20+ to build the SPA (build can also run in CI; only `dist/` ships).

## 1. Build and place the SPA
```bash
cd frontend
VITE_API_BASE= npm ci && VITE_API_BASE= npm run build   # empty API base = same-origin
sudo rm -rf /var/www/skoobl && sudo mkdir -p /var/www/skoobl
sudo cp -r dist/* /var/www/skoobl/
```

## 2. Start backend + Redis
```bash
cd infra
cp .env.example .env        # keep ALLOWED_ORIGINS empty for prod
docker compose up -d --build
docker compose ps           # both services healthy
curl -s localhost:8080/healthz   # -> ok
```

## 3. Install the nginx server block
```bash
sudo cp infra/nginx/skoobl.conf /etc/nginx/conf.d/skoobl.conf
# edit server_name to the real hostname; ensure TLS cert directives match Dilmune
sudo nginx -t && sudo systemctl reload nginx
```

## Updating
```bash
git pull
# frontend changed:
cd frontend && VITE_API_BASE= npm run build && sudo cp -r dist/* /var/www/skoobl/
# backend changed:
cd infra && docker compose up -d --build
```

## Rollback
```bash
cd infra && docker compose down        # stop app (Redis data persists in volume)
git checkout <previous-sha> && docker compose up -d --build
```

## Logs & ops
```bash
cd infra
docker compose logs -f backend
docker compose logs -f redis
docker compose restart backend
```

## Notes
- Room state survives a backend restart (Redis snapshots, TTL `SNAPSHOT_TTL`).
  Clients reconnect with their code and the room is rehydrated on first lookup.
- `docker compose down -v` wipes the Redis volume (all active rooms). Avoid in prod.
```

- [ ] **Step 3: Commit**

```bash
git add infra/.env.example infra/README.md
git commit -m "docs(infra): deploy runbook + env example for Dilmune VPS

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Backend suite + build:** `cd backend && go build ./... && go vet ./... && go test ./...` → all PASS.
- [ ] **Frontend:** `cd frontend && npm run typecheck && npm test` → PASS.
- [ ] **Image:** `cd backend && docker build -t skoobl-backend:dev .` → succeeds.
- [ ] **Compose:** `cd infra && docker compose config` → parses; `docker compose up -d --build` then `curl localhost:8080/healthz` → `ok`; `docker compose down`.
- [ ] **nginx:** server block passes `nginx -t` (modulo Dilmune-injected cert paths).
- [ ] **End-to-end (optional, local):** build SPA with `VITE_API_BASE=`, serve `dist/` via a local nginx using `skoobl.conf` (cert directives stubbed/disabled for local), create a game in the UI, join from a second tab, confirm state syncs; restart `backend` container, reconnect, confirm the room rehydrates.
