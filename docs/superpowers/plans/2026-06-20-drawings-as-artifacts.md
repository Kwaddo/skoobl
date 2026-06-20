# Drawings as First-Class Artifacts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make drawings first-class artifacts — reliably captured (server draft-sync auto-lock), shown to everyone (host-TV reveal gallery), richer to make (flood-fill bucket + hex picker), and exportable (players view + download their own art).

**Architecture:** The backend already stores every player's strokes for the round in `GameState.Drawings`; the round-end discard is mostly a *view* (redaction) and a *race* (strokes live client-side until lock). We close the race with a `draftDrawing` event that streams strokes to the server continuously, gate early-advance on a new `Locked` set, stop redacting all-but-featured at reveal for the host, and add a replayable `fill` stroke primitive. Players accumulate their own strokes client-side for a downloadable game-end gallery.

**Tech Stack:** Go (backend game room + Socket.IO bridge), React + TypeScript + Zustand + Vite/Vitest (frontend), HTML Canvas 2D.

## Global Constraints

- **Never run `git commit` / `git push`.** The user performs all commits. End each task at green tests; leave changes in the working tree for the user. (Each task's final step says "Stop — do not commit.")
- **Canvas resolution is fixed at 1000×750** and MUST match on both sides: frontend `CANVAS_W=1000`/`CANVAS_H=750` (`frontend/src/lib/canvas.ts:6-7`) and backend `canvasW=1000`/`canvasH=750` (`backend/internal/game/room.go:72-73`). Do not change these.
- **Stroke colors are hex-validated server-side** by `hexColor` / `sanitizeColor` (`room.go:86`, `:971`). The new hex picker relies on this — never bypass `sanitizeStrokes`.
- **Jackbox split is preserved:** host (`screen="host"`) is the spectator TV (shows galleries + leaderboard); player (`screen="player"`) is the phone (canvas, own-drawing, downloads). The host is never in `Players`.
- **TDD:** write the failing test first, watch it fail, implement minimally, watch it pass.
- Test commands: backend `cd backend && go test ./internal/game/` (and `./internal/realtime/` where noted); frontend `cd frontend && npx vitest run <file>` and `npm run typecheck`.

---

## Task 1: Backend — `Stroke.Fill` field survives sanitization

**Files:**
- Modify: `backend/internal/game/state.go:44-49` (Stroke struct)
- Modify: `backend/internal/game/room.go:934-969` (`sanitizeStrokes`)
- Test: `backend/internal/game/room_test.go` (append)

**Interfaces:**
- Produces: `Stroke{ Color string; Width float64; Points []Point; Fill bool }` with JSON tag `fill,omitempty`. `sanitizeStrokes([]Stroke) []Stroke` preserves `Fill` and still hex-validates `Color`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/internal/game/room_test.go`:

```go
func TestSanitizePreservesFill(t *testing.T) {
	in := []Stroke{{Color: "#ff0000", Width: 4, Points: []Point{{X: 5, Y: 5}}, Fill: true}}
	out := sanitizeStrokes(in)
	if len(out) != 1 {
		t.Fatalf("got %d strokes, want 1", len(out))
	}
	if !out[0].Fill {
		t.Fatal("fill flag dropped by sanitizeStrokes")
	}
	if out[0].Color != "#ff0000" {
		t.Fatalf("color = %q, want #ff0000", out[0].Color)
	}
}

func TestSanitizeRejectsBadFillColor(t *testing.T) {
	in := []Stroke{{Color: "javascript:alert(1)", Width: 4, Points: []Point{{X: 5, Y: 5}}, Fill: true}}
	out := sanitizeStrokes(in)
	if len(out) != 1 || out[0].Color != defaultStrokeColor {
		t.Fatalf("color = %q, want sanitized default", out[0].Color)
	}
	if !out[0].Fill {
		t.Fatal("fill flag dropped while sanitizing a bad color")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'TestSanitize' -v`
Expected: compile error — `Stroke` has no field `Fill`.

- [ ] **Step 3: Add the `Fill` field**

In `backend/internal/game/state.go`, change the `Stroke` struct (currently lines 44-49):

```go
type Stroke struct {
	Color  string  `json:"color"`
	Width  float64 `json:"width"`
	Points []Point `json:"points"`
	// Fill marks a flood-fill op: Points[0] is the seed, Color is the fill
	// color, Width is ignored. Replayed deterministically at render time.
	Fill bool `json:"fill,omitempty"`
}
```

- [ ] **Step 4: Preserve `Fill` in `sanitizeStrokes`**

In `backend/internal/game/room.go`, the rebuilt stroke (currently lines 959-963) must copy `Fill`:

```go
		out = append(out, Stroke{
			Color:  sanitizeColor(s.Color),
			Width:  clampF(s.Width, minStrokeWidth, maxStrokeWidth),
			Points: clean,
			Fill:   s.Fill,
		})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/game/ -run 'TestSanitize' -v`
Expected: PASS (both tests).

- [ ] **Step 6: Stop — do not commit.** Report tests green; leave changes for the user.

---

## Task 2: Backend — draft-sync, lock set, and auto-lock-on-expiry

**Files:**
- Modify: `backend/internal/game/state.go:85-105` (add `GameState.Locked`)
- Modify: `backend/internal/game/room.go` — CmdKind (`:19-33`), `beginRound` (`:546-555`), `endGame` (`:702-713`), `returnToLobby` (`:718-733`), `handle` (`:286-335`), `submitDrawing` (`:749-759`), `allDrawn`→`allLocked` (`:785-796`), plus new `draftDrawing`
- Modify: `backend/internal/realtime/socket.go:61-75` (bind) + new `draftDrawing` method
- Test: `backend/internal/game/room_test.go` (append)

**Interfaces:**
- Consumes: `Stroke.Fill` (Task 1) — unrelated here but same struct.
- Produces:
  - `GameState.Locked map[string]bool` (server-only, `json:"locked,omitempty"`).
  - `CmdDraftDrawing CmdKind` — stores strokes, never early-advances.
  - `(*Room).draftDrawing(Command)`, `(*Room).allLocked() bool`.
  - `submitDrawing` sets `Locked[player]=true` and early-advances only when `allLocked()`.
  - Socket event `draftDrawing` with `{strokes}` payload.

- [ ] **Step 1: Write the failing tests**

Append to `backend/internal/game/room_test.go`. These drive the room **synchronously** via `r.handle` / `r.advance` (no `Run` goroutine) so the timer path is deterministic — sound because nothing else touches `r.state`.

```go
// syncRoom builds a room and joins a host + the given players by calling handle
// directly (no Run goroutine), then starts the game. Returns the room in the
// drawing phase.
func syncRoom(t *testing.T, players ...string) *Room {
	t.Helper()
	r := NewRoom("sync1")
	r.handle(Command{Kind: CmdJoin, Player: "tv", Spectator: true,
		Subscribe: make(chan GameState, 64), Ack: make(chan string, 1)})
	for _, n := range players {
		r.handle(Command{Kind: CmdJoin, Player: n,
			Subscribe: make(chan GameState, 64), Ack: make(chan string, 1)})
	}
	r.handle(Command{Kind: CmdStart, Player: "tv"})
	if r.state.Phase != PhaseDrawing {
		t.Fatalf("phase = %q, want drawing after start", r.state.Phase)
	}
	return r
}

func draft(r *Room, name string) {
	r.handle(Command{Kind: CmdDraftDrawing, Player: name, Strokes: []Stroke{
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}, {X: 2, Y: 2}}},
	}})
}

func TestDraftStoresWithoutAdvancing(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	for _, n := range []string{"alice", "bob", "carol", "dave"} {
		draft(r, n)
	}
	if r.state.Phase != PhaseDrawing {
		t.Fatalf("phase = %q, want drawing (drafts must not early-advance)", r.state.Phase)
	}
	if len(r.state.Drawings["alice"]) == 0 {
		t.Fatal("alice's draft was not stored server-side")
	}
	if r.state.Locked["alice"] {
		t.Fatal("a draft must not set the lock")
	}
}

func TestAllLockedAdvancesToGuessing(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	for _, n := range []string{"alice", "bob", "carol", "dave"} {
		r.handle(Command{Kind: CmdSubmitDrawing, Player: n, Strokes: []Stroke{
			{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}, {X: 2, Y: 2}}},
		}})
	}
	if r.state.Phase != PhaseGuessing {
		t.Fatalf("phase = %q, want guessing once everyone locked", r.state.Phase)
	}
}

func TestTimerExpiryKeepsUnlockedDrafts(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	// Only drafts — nobody locks in. Then the drawing timer fires.
	for _, n := range []string{"alice", "bob", "carol", "dave"} {
		draft(r, n)
	}
	r.advance() // simulates the drawing-phase timer expiring
	if r.state.Phase != PhaseGuessing {
		t.Fatalf("phase = %q, want guessing after expiry", r.state.Phase)
	}
	if r.state.Featured == "" {
		t.Fatal("no artist featured — an unlocked draft was discarded")
	}
	if len(r.state.Drawings[r.state.Featured]) == 0 {
		t.Fatal("featured artist's draft strokes were lost")
	}
}

func TestEmptyDraftNotFeatured(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	draft(r, "alice") // only alice draws anything
	r.advance()
	if r.state.Featured != "alice" {
		t.Fatalf("featured = %q, want alice (the only non-empty draft)", r.state.Featured)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'TestDraft|TestAllLocked|TestTimerExpiry|TestEmptyDraft' -v`
Expected: compile error — `CmdDraftDrawing` and `r.state.Locked` undefined.

- [ ] **Step 3: Add `CmdDraftDrawing` and the `Locked` field**

In `backend/internal/game/room.go`, add to the `CmdKind` block right after `CmdSubmitDrawing` (line 25):

```go
	CmdSubmitDrawing // player: lock in strokes during the drawing phase
	CmdDraftDrawing  // player: stream in-progress strokes (no lock, no advance)
```

In `backend/internal/game/state.go`, add to the authoritative round data block (after `Drawings` at line 100):

```go
	Drawings     map[string][]Stroke `json:"drawings,omitempty"`     // player → latest strokes this round (draft or locked)
	Locked       map[string]bool     `json:"locked,omitempty"`       // player → locked in (gates early-advance)
```

- [ ] **Step 4: Add the `draftDrawing` handler, lock on submit, and `allLocked`**

In `backend/internal/game/room.go`, add the dispatch case in `handle` after `CmdSubmitDrawing` (line 313):

```go
	case CmdSubmitDrawing:
		r.submitDrawing(c)
	case CmdDraftDrawing:
		r.draftDrawing(c)
```

Replace `submitDrawing` (currently lines 749-759) with:

```go
// submitDrawing locks in a player's drawing: stores the strokes and marks them
// locked. When every connected player has locked, the round advances early
// rather than waiting out the timer.
func (r *Room) submitDrawing(c Command) {
	if r.state.Phase != PhaseDrawing || r.state.playerIndex(c.Player) < 0 {
		return
	}
	if r.state.Drawings == nil {
		r.state.Drawings = map[string][]Stroke{}
	}
	if r.state.Locked == nil {
		r.state.Locked = map[string]bool{}
	}
	r.state.Drawings[c.Player] = sanitizeStrokes(c.Strokes)
	r.state.Locked[c.Player] = true
	if r.allLocked() {
		r.beginGuessing() // everyone's in — don't wait out the timer
	}
}

// draftDrawing stores a player's in-progress strokes without locking them in.
// The server always holds the latest draft, so when the drawing timer expires
// nothing is lost — whatever was drawn is kept and treated as the drawing.
func (r *Room) draftDrawing(c Command) {
	if r.state.Phase != PhaseDrawing || r.state.playerIndex(c.Player) < 0 {
		return
	}
	if r.state.Drawings == nil {
		r.state.Drawings = map[string][]Stroke{}
	}
	r.state.Drawings[c.Player] = sanitizeStrokes(c.Strokes)
}
```

Replace `allDrawn` (currently lines 785-796) with `allLocked`:

```go
// allLocked reports whether every connected player has locked in their drawing.
// Disconnected players (in their grace window) don't block the round.
func (r *Room) allLocked() bool {
	for _, p := range r.state.Players {
		if pr, ok := r.present[p.Name]; ok && pr.connected {
			if !r.state.Locked[p.Name] {
				return false
			}
		}
	}
	return true
}
```

- [ ] **Step 5: Clear `Locked` with the other round data**

In `beginRound` (after `r.state.Drawings = map[string][]Stroke{}`, line 548):

```go
	r.state.Drawings = map[string][]Stroke{}
	r.state.Locked = map[string]bool{}
```

In `endGame` (after `r.state.Drawings = nil`, line 708) and in `returnToLobby` (after `r.state.Drawings = nil`, line 724), add in both:

```go
	r.state.Drawings = nil
	r.state.Locked = nil
```

- [ ] **Step 6: Wire the `draftDrawing` socket event**

In `backend/internal/realtime/socket.go`, add to `bind` after the `submitDrawing` line (line 69):

```go
	sock.On("submitDrawing", func(args ...any) { c.submitDrawing(args) })
	sock.On("draftDrawing", func(args ...any) { c.draftDrawing(args) })
```

Add the method after `submitDrawing` (after line 166):

```go
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
```

- [ ] **Step 7: Run the full backend suite**

Run: `cd backend && go test ./internal/game/ ./internal/realtime/`
Expected: PASS (new tests pass; existing tests — which lock in via `CmdSubmitDrawing` — still advance correctly).

- [ ] **Step 8: Stop — do not commit.** Report tests green.

---

## Task 3: Backend — `Player.Locked` view flag + host-only reveal `Gallery`

**Files:**
- Modify: `backend/internal/game/state.go` — `Player` struct (`:54-64`), `GameState` view fields (`:107-118`), `viewFor` (`:145-198`)
- Test: `backend/internal/game/room_test.go` (append)

**Interfaces:**
- Produces:
  - `Player.Locked bool` (`json:"locked,omitempty"`) — view-only, set from `g.Locked[name]`.
  - `GameState.Gallery map[string][]Stroke` (`json:"gallery,omitempty"`) — view-only, populated in the reveal case **only when `name == g.Host`**, a copy of `g.Drawings`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/internal/game/room_test.go` (reuses `syncRoom`/`draft` from Task 2):

```go
func TestHostRevealCarriesGallery(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	for _, n := range []string{"alice", "bob", "carol", "dave"} {
		draft(r, n)
	}
	r.advance()         // → guessing, picks a featured artist
	r.beginReveal()     // → reveal
	if r.state.Phase != PhaseReveal {
		t.Fatalf("phase = %q, want reveal", r.state.Phase)
	}
	host := r.state.viewFor("tv", r.present)
	if len(host.Gallery) != 4 {
		t.Fatalf("host gallery has %d drawings, want 4", len(host.Gallery))
	}
	player := r.state.viewFor("alice", r.present)
	if player.Gallery != nil {
		t.Fatalf("player view leaked a gallery: %+v", player.Gallery)
	}
}

func TestLockedFlagInView(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	r.handle(Command{Kind: CmdSubmitDrawing, Player: "alice", Strokes: []Stroke{
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}}},
	}})
	v := r.state.viewFor("tv", r.present)
	var aliceLocked, bobLocked bool
	for _, p := range v.Players {
		if p.Name == "alice" {
			aliceLocked = p.Locked
		}
		if p.Name == "bob" {
			bobLocked = p.Locked
		}
	}
	if !aliceLocked {
		t.Fatal("alice locked in but view shows Locked=false")
	}
	if bobLocked {
		t.Fatal("bob never locked but view shows Locked=true")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'TestHostRevealCarriesGallery|TestLockedFlagInView' -v`
Expected: compile error — `Player.Locked` and `GameState.Gallery` undefined.

- [ ] **Step 3: Add the view fields**

In `backend/internal/game/state.go`, add to the `Player` view-only block (after `RoundScore`, line 63):

```go
	RoundScore int  `json:"roundScore,omitempty"` // reveal: points earned this round
	Locked     bool `json:"locked,omitempty"`     // drawing: locked in (TV "finished ✓")
```

Add to the `GameState` view-only block (after `CurrentDrawing`, line 111):

```go
	CurrentDrawing []Stroke            `json:"currentDrawing,omitempty"`
	Gallery        map[string][]Stroke `json:"gallery,omitempty"` // reveal, host only: every player's drawing
```

- [ ] **Step 4: Populate the flags in `viewFor`**

In `backend/internal/game/state.go`, inside the per-player loop, after the `HasDrawn` block (after line 171):

```go
		if len(g.Drawings[p.Name]) > 0 {
			pub.HasDrawn = true
		}
		if g.Locked[p.Name] {
			pub.Locked = true
		}
```

In the `PhaseReveal` case of the phase switch (after line 196, `v.Reveal = ...`):

```go
	case PhaseReveal:
		v.CurrentDrawing = g.Drawings[g.Featured]
		v.YourGuess = g.Guesses[name]
		v.Reveal = &Reveal{Artist: g.Featured, Prompt: g.Prompt}
		if name == g.Host {
			v.Gallery = make(map[string][]Stroke, len(g.Drawings))
			for artist, strokes := range g.Drawings {
				v.Gallery[artist] = strokes
			}
		}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/game/`
Expected: PASS.

- [ ] **Step 6: Stop — do not commit.** Report tests green. Backend is complete.

---

## Task 4: Frontend — protocol/store types, `gallery`, and `myDrawings` accumulation

**Files:**
- Modify: `frontend/src/lib/protocol.ts:22-66` (Stroke, Player, GameState)
- Modify: `frontend/src/lib/store.ts` (interface, initial, applyState, new action)
- Test: `frontend/src/lib/store.test.ts` (append)

**Interfaces:**
- Produces:
  - `Stroke.fill?: boolean`, `Player.locked?: boolean`, `GameState.gallery?: Record<string, Stroke[]>`.
  - Store fields `gallery: Record<string, Stroke[]>`, `myDrawings: Record<number, Stroke[]>`.
  - Action `recordDrawing(round: number, strokes: Stroke[]): void` — accumulates the player's own art; cleared when the phase returns to `lobby`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/store.test.ts`:

```ts
it("records own drawings and clears them in the lobby", () => {
  const s = useGameStore.getState();
  s.recordDrawing(1, [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }]);
  s.recordDrawing(2, [{ color: "#f00", width: 4, points: [{ x: 2, y: 2 }] }]);
  expect(Object.keys(useGameStore.getState().myDrawings)).toHaveLength(2);

  // A broadcast that lands back in the lobby (play again) wipes them.
  useGameStore.getState().applyState({ ...sample, phase: "lobby" });
  expect(useGameStore.getState().myDrawings).toEqual({});
});

it("keeps own drawings across in-game broadcasts", () => {
  const s = useGameStore.getState();
  s.recordDrawing(1, [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }]);
  useGameStore.getState().applyState({ ...sample, phase: "reveal" });
  expect(useGameStore.getState().myDrawings[1]).toHaveLength(1);
});

it("applies the host gallery", () => {
  useGameStore.getState().applyState({
    ...sample,
    phase: "reveal",
    gallery: { ann: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }] },
  });
  expect(useGameStore.getState().gallery.ann).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/store.test.ts`
Expected: FAIL — `recordDrawing` / `myDrawings` / `gallery` not on the store.

- [ ] **Step 3: Extend the protocol types**

In `frontend/src/lib/protocol.ts`:

```ts
export interface Stroke {
  color: string;
  width: number;
  points: Point[];
  // A flood-fill op: points[0] is the seed, color is the fill color.
  fill?: boolean;
}
```

Add `locked` to `Player` (after `roundScore`, line 35):

```ts
  roundScore?: number;
  locked?: boolean;
```

Add `gallery` to `GameState` (after `currentDrawing`, line 60):

```ts
  currentDrawing?: Stroke[];
  // Reveal phase, host only: every player's drawing keyed by name.
  gallery?: Record<string, Stroke[]>;
```

- [ ] **Step 4: Extend the store**

In `frontend/src/lib/store.ts`, add to the `GameStore` interface (after `currentDrawing`, line 39):

```ts
  currentDrawing: Stroke[];
  gallery: Record<string, Stroke[]>;
  // The player's own drawings this game, keyed by round (for the game-end
  // gallery + download). Accumulated client-side; cleared back in the lobby.
  myDrawings: Record<number, Stroke[]>;
```

Add the action to the interface (after `applyState`, line 48):

```ts
  applyState: (s: GameState) => void;
  recordDrawing: (round: number, strokes: Stroke[]) => void;
```

Add to `initial` (after `currentDrawing`, line 66):

```ts
  currentDrawing: [] as Stroke[],
  gallery: {} as Record<string, Stroke[]>,
  myDrawings: {} as Record<number, Stroke[]>,
```

In `applyState`, add to the returned object (after `currentDrawing`, line 119):

```ts
        currentDrawing: s.currentDrawing ?? [],
        gallery: s.gallery ?? {},
        // Wipe the player's own gallery when a new game starts (back in lobby).
        myDrawings: s.phase === "lobby" ? {} : prev.myDrawings,
```

Add the action implementation (after `setSelf`, line 78):

```ts
  setSelf: (name) => set({ self: name }),
  recordDrawing: (round, strokes) =>
    set((s) => ({ myDrawings: { ...s.myDrawings, [round]: strokes } })),
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/lib/store.test.ts && npm run typecheck`
Expected: store tests PASS; typecheck clean.

- [ ] **Step 6: Stop — do not commit.** Report green.

---

## Task 5: Frontend — flood-fill render + PNG download in `canvas.ts`

**Files:**
- Modify: `frontend/src/lib/canvas.ts`
- Test: `frontend/src/lib/canvas.test.ts` (create)

**Interfaces:**
- Consumes: `Stroke.fill` (Task 4).
- Produces:
  - `hexToRgba(hex: string): [number, number, number, number]`
  - `floodFill(data: Uint8ClampedArray, width: number, height: number, sx: number, sy: number, fill: [number, number, number, number], tolerance: number): void`
  - `pngFilename(round: number): string`
  - `downloadStrokesPng(strokes: Stroke[], filename: string): void`
  - `drawStrokes` renders `fill` strokes via `floodFill`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/canvas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { floodFill, hexToRgba, pngFilename } from "./canvas";

describe("hexToRgba", () => {
  it("parses #rrggbb", () => {
    expect(hexToRgba("#ff0000")).toEqual([255, 0, 0, 255]);
  });
  it("parses #rgb shorthand", () => {
    expect(hexToRgba("#0f0")).toEqual([0, 255, 0, 255]);
  });
});

describe("floodFill", () => {
  // 3×1 row: [bg][barrier][bg]. A fill from the left must stop at the barrier.
  it("stops at a differing-color barrier", () => {
    const bg = 0;
    const barrier = 255;
    // RGBA per pixel.
    const data = new Uint8ClampedArray([
      bg, bg, bg, 255, // x=0
      barrier, barrier, barrier, 255, // x=1 (barrier)
      bg, bg, bg, 255, // x=2
    ]);
    floodFill(data, 3, 1, 0, 0, [10, 20, 30, 255], 0);
    expect([data[0], data[1], data[2]]).toEqual([10, 20, 30]); // filled
    expect([data[4], data[5], data[6]]).toEqual([255, 255, 255]); // barrier intact
    expect([data[8], data[9], data[10]]).toEqual([0, 0, 0]); // unreached
  });

  it("fills a contiguous region", () => {
    const data = new Uint8ClampedArray([
      0, 0, 0, 255,
      0, 0, 0, 255,
    ]);
    floodFill(data, 2, 1, 0, 0, [9, 9, 9, 255], 0);
    expect([data[0], data[4]]).toEqual([9, 9]);
  });
});

describe("pngFilename", () => {
  it("names by round", () => {
    expect(pngFilename(2)).toBe("skoobl-round-2.png");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/canvas.test.ts`
Expected: FAIL — `floodFill` / `hexToRgba` / `pngFilename` not exported.

- [ ] **Step 3: Implement the helpers**

In `frontend/src/lib/canvas.ts`, after the `BRUSHES` line (line 26), add:

```ts
// How close a pixel's color must be to the seed to be filled (sum of |Δ| across
// RGBA, max 1020). Loose enough to flow under anti-aliased stroke edges, tight
// enough to stop at a drawn line of a different color.
export const FILL_TOLERANCE = 100;

// hexToRgba parses #rgb / #rrggbb / #rrggbbaa into an [r,g,b,a] tuple (0-255).
export function hexToRgba(hex: string): [number, number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const n = Number.parseInt(h.slice(0, 6), 16);
  const a = h.length >= 8 ? Number.parseInt(h.slice(6, 8), 16) : 255;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

// floodFill paints the 4-connected region of pixels matching the seed color
// (within tolerance) with `fill`. Operates in place on an RGBA buffer; a visited
// mask guarantees termination regardless of tolerance.
export function floodFill(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  sx: number,
  sy: number,
  fill: [number, number, number, number],
  tolerance: number,
): void {
  sx = Math.round(sx);
  sy = Math.round(sy);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return;
  const at = (x: number, y: number) => (y * width + x) * 4;
  const seed = at(sx, sy);
  const target = [data[seed], data[seed + 1], data[seed + 2], data[seed + 3]];
  // Nothing to do if the seed already is the fill color (avoids needless work).
  if (
    target[0] === fill[0] &&
    target[1] === fill[1] &&
    target[2] === fill[2] &&
    target[3] === fill[3]
  ) {
    return;
  }
  const matches = (i: number) =>
    Math.abs(data[i] - target[0]) +
      Math.abs(data[i + 1] - target[1]) +
      Math.abs(data[i + 2] - target[2]) +
      Math.abs(data[i + 3] - target[3]) <=
    tolerance;
  const visited = new Uint8Array(width * height);
  const stack: Array<[number, number]> = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop() as [number, number];
    const p = y * width + x;
    if (visited[p]) continue;
    visited[p] = 1;
    const i = at(x, y);
    if (!matches(i)) continue;
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill[3];
    if (x > 0) stack.push([x - 1, y]);
    if (x < width - 1) stack.push([x + 1, y]);
    if (y > 0) stack.push([x, y - 1]);
    if (y < height - 1) stack.push([x, y + 1]);
  }
}

// pngFilename is the download name for a round's drawing.
export function pngFilename(round: number): string {
  return `skoobl-round-${round}.png`;
}
```

- [ ] **Step 4: Render `fill` strokes in `drawStrokes`**

In `frontend/src/lib/canvas.ts`, in the `for (const s of strokes)` loop, add a fill branch at the very top of the loop body (before the existing `if (!s.points.length) continue;`):

```ts
  for (const s of strokes) {
    if (s.fill) {
      const seed = s.points[0];
      if (!seed) continue;
      const img = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
      floodFill(
        img.data,
        CANVAS_W,
        CANVAS_H,
        seed.x,
        seed.y,
        hexToRgba(s.color),
        FILL_TOLERANCE,
      );
      ctx.putImageData(img, 0, 0);
      continue;
    }
    if (!s.points.length) continue;
```

- [ ] **Step 5: Add `downloadStrokesPng`**

Append to `frontend/src/lib/canvas.ts`:

```ts
// downloadStrokesPng renders strokes to an offscreen canvas at full resolution
// and triggers a PNG download. No-ops where the 2D context is unavailable
// (e.g. jsdom in tests).
export function downloadStrokesPng(strokes: Stroke[], filename: string): void {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  drawStrokes(ctx, strokes);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/lib/canvas.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Stop — do not commit.** Report green.

---

## Task 6: Frontend — `draftDrawing` socket action

**Files:**
- Modify: `frontend/src/hooks/use-game-socket.ts:71-79`
- Test: `frontend/src/hooks/use-game-socket.test.ts` (append an assertion)

**Interfaces:**
- Produces: `actions.draftDrawing(strokes: Stroke[]): void` → emits `draftDrawing` with `{ strokes }`. `GameActions` type gains the method automatically.

- [ ] **Step 1: Write the failing test**

In `frontend/src/hooks/use-game-socket.test.ts`, inside the `"forwards player actions as named events"` test, after the `submitDrawing` block (line 63), add:

```ts
    act(() =>
      result.current.draftDrawing([
        { color: "#0f0", width: 4, points: [{ x: 3, y: 4 }] },
      ]),
    );
```

and after the existing `submitDrawing` expectation (line 75), add:

```ts
    expect(MockSocket.last.emitted).toContainEqual({
      event: "draftDrawing",
      payload: {
        strokes: [{ color: "#0f0", width: 4, points: [{ x: 3, y: 4 }] }],
      },
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/hooks/use-game-socket.test.ts`
Expected: FAIL — `result.current.draftDrawing` is not a function.

- [ ] **Step 3: Add the action**

In `frontend/src/hooks/use-game-socket.ts`, in the returned object after `submitDrawing` (after line 74):

```ts
    submitDrawing: useCallback(
      (strokes: Stroke[]) => emit("submitDrawing", { strokes }),
      [emit],
    ),
    draftDrawing: useCallback(
      (strokes: Stroke[]) => emit("draftDrawing", { strokes }),
      [emit],
    ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/hooks/use-game-socket.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Stop — do not commit.** Report green.

---

## Task 7: Frontend — `DrawingCanvas` Pen/Fill toggle, hex picker, stroke-end hook

**Files:**
- Modify: `frontend/src/components/game/DrawingCanvas.tsx`
- Test: `frontend/src/components/game/DrawingCanvas.test.tsx` (create)

**Interfaces:**
- Consumes: `Stroke.fill` (Task 4).
- Produces: `DrawingCanvas` gains an `onStrokeEnd?: () => void` prop (fired after a pen stroke ends or a fill is placed) and internal Pen/Fill tool + custom-color `<input type="color">`. Fill mode hides brush buttons; a fill click appends `{ color, width, points: [seed], fill: true }`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/game/DrawingCanvas.test.tsx`:

```tsx
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DrawingCanvas } from "./DrawingCanvas";

describe("DrawingCanvas tools", () => {
  it("offers pen and fill tools plus a custom color input", () => {
    const { getByLabelText } = render(<DrawingCanvas />);
    expect(getByLabelText(/pen tool/i)).toBeTruthy();
    expect(getByLabelText(/fill tool/i)).toBeTruthy();
    expect(getByLabelText(/custom color/i)).toBeTruthy();
  });

  it("hides brush sizes while the fill tool is active", () => {
    const { getByLabelText, queryByLabelText } = render(<DrawingCanvas />);
    expect(queryByLabelText("brush 5")).not.toBeNull();
    fireEvent.click(getByLabelText(/fill tool/i));
    expect(queryByLabelText("brush 5")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/game/DrawingCanvas.test.tsx`
Expected: FAIL — no pen/fill/custom-color controls.

- [ ] **Step 3: Add tool state, the stroke-end hook, and fill placement**

In `frontend/src/components/game/DrawingCanvas.tsx`, extend the props (lines 23-31):

```tsx
export function DrawingCanvas({
  disabled = false,
  onChange,
  onStrokeEnd,
  footer,
}: {
  disabled?: boolean;
  onChange?: (strokes: Stroke[]) => void;
  onStrokeEnd?: () => void;
  footer?: React.ReactNode;
}) {
```

Add a `tool` state after `width` (after line 35):

```tsx
  const [width, setWidth] = useState<number>(BRUSHES[1]);
  const [tool, setTool] = useState<"pen" | "fill">("pen");
```

Replace `start` (lines 59-67) and `end` (lines 81-83):

```tsx
  const start = (e: PointerEvent) => {
    if (disabled || !e.isPrimary) return;
    const p = toCanvas(e);
    if (tool === "fill") {
      // A fill is a complete op on press: append the fill stroke and draft it.
      setStrokes((prev) => [...prev, { color, width, points: [p], fill: true }]);
      onStrokeEnd?.();
      return;
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drawingRef.current = true;
    setStrokes((prev) => [...prev, { color, width, points: [p] }]);
  };

  const move = (e: PointerEvent) => {
    if (disabled || !drawingRef.current || !e.isPrimary) return;
    const p = toCanvas(e);
    setStrokes((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      const cur = next[next.length - 1];
      next[next.length - 1] = { ...cur, points: [...cur.points, p] };
      return next;
    });
  };

  const end = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    onStrokeEnd?.();
  };
```

(The `move` body is unchanged — shown for context since it sits between `start` and `end`.)

- [ ] **Step 4: Add the Pen/Fill toggle + custom color input; gate brushes on pen**

In `frontend/src/components/game/DrawingCanvas.tsx`, replace the palette/brush toolbar block. The palette `<div>` (lines 113-128) gets the custom-color input appended, a Pen/Fill toggle is added, and the brush `<div>` (lines 130-151) is wrapped so it only renders for the pen.

Replace the palette container's closing — add the color input right after the `PALETTE.map(...)` block, inside the same `<div className="flex flex-wrap ...">` (after line 127):

```tsx
              ))}
              <input
                type="color"
                aria-label="custom color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-8 w-8 cursor-pointer rounded-full border-2 border-border bg-transparent p-0"
              />
            </div>

            <div className="flex items-center gap-2 short:flex-col short:items-stretch">
              <button
                type="button"
                aria-label="pen tool"
                onClick={() => setTool("pen")}
                className={`btn-ghost px-3 py-2 text-sm ${
                  tool === "pen" ? "border-primary bg-surface-2" : ""
                }`}
              >
                Pen
              </button>
              <button
                type="button"
                aria-label="fill tool"
                onClick={() => setTool("fill")}
                className={`btn-ghost px-3 py-2 text-sm ${
                  tool === "fill" ? "border-primary bg-surface-2" : ""
                }`}
              >
                Fill
              </button>
            </div>
```

Then wrap the brushes so they only show for the pen. Change the opening of the brush row (line 130) from `<div className="flex items-center gap-2 ...">` to render the size buttons only when `tool === "pen"`, keeping Undo/Clear always visible:

```tsx
            <div className="flex items-center gap-2 short:flex-wrap short:justify-center">
              {tool === "pen" &&
                BRUSHES.map((b) => (
                  <button
                    key={b}
                    type="button"
                    aria-label={`brush ${b}`}
                    onClick={() => setWidth(b)}
                    className={`flex h-9 w-9 items-center justify-center rounded-lg border-2 ${
                      width === b
                        ? "border-primary bg-surface-2"
                        : "border-border hover:border-muted"
                    }`}
                  >
                    <span
                      className="rounded-full bg-foreground"
                      style={{
                        width: `${Math.max(4, b / 2)}px`,
                        height: `${Math.max(4, b / 2)}px`,
                      }}
                    />
                  </button>
                ))}
              <button
                type="button"
                className="btn-ghost px-3 py-2 text-sm"
                onClick={() => setStrokes((prev) => prev.slice(0, -1))}
                disabled={strokes.length === 0}
              >
                Undo
              </button>
              <button
                type="button"
                className="btn-ghost px-3 py-2 text-sm"
                onClick={() => setStrokes([])}
                disabled={strokes.length === 0}
              >
                Clear
              </button>
            </div>
```

- [ ] **Step 5: Run tests + typecheck + lint**

Run: `cd frontend && npx vitest run src/components/game/DrawingCanvas.test.tsx && npm run typecheck && npm run lint`
Expected: tests PASS; typecheck clean; lint clean.

- [ ] **Step 6: Stop — do not commit.** Report green.

---

## Task 8: Frontend — `PlayerStage` draft-sync, own-drawing record, reveal download

**Files:**
- Modify: `frontend/src/components/game/PlayerStage.tsx`
- Test: `frontend/src/components/game/stages.test.tsx` (append)

**Interfaces:**
- Consumes: `actions.draftDrawing` (Task 6), `DrawingCanvas` `onStrokeEnd` (Task 7), store `recordDrawing` / `myDrawings` (Task 4), `StrokesView`, `downloadStrokesPng` / `pngFilename` (Task 5).
- Produces: `PlayerDrawing` streams drafts on stroke-end and records its final strokes to the store on unmount; `PlayerReveal` shows the player's own drawing + a Download button.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/components/game/stages.test.tsx` (inside the `describe("stage split", ...)` block):

```tsx
  it("player reveal shows their own drawing with a download button", () => {
    useGameStore.setState({
      phase: "reveal",
      round: 1,
      players: [{ name: "ann" }, { name: "bob" }],
      reveal: { artist: "bob", prompt: "cat" },
      myDrawings: {
        1: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }],
      },
    });
    const { container, getByText } = render(
      <PlayerStage name="ann" actions={noopActions} />,
    );
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(getByText(/download/i)).toBeTruthy();
  });
```

Also add `draftDrawing: () => {}` to the `noopActions` object (line 8-16) so the new action exists in tests:

```tsx
const noopActions = {
  configure: () => {},
  start: () => {},
  nextPhase: () => {},
  returnToLobby: () => {},
  leave: () => {},
  submitDrawing: () => {},
  draftDrawing: () => {},
  submitGuess: () => {},
} as unknown as GameActions;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/game/stages.test.tsx`
Expected: FAIL — player reveal renders no canvas / no Download button.

- [ ] **Step 3: Wire draft-sync + own-drawing recording into `PlayerDrawing`**

In `frontend/src/components/game/PlayerStage.tsx`, update imports (lines 1-8):

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useCountdown } from "@/hooks/use-countdown";
import type { GameActions } from "@/hooks/use-game-socket";
import { downloadStrokesPng, pngFilename } from "@/lib/canvas";
import type { Stroke } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";
import { DrawingCanvas } from "./DrawingCanvas";
import { ArrowUp, Avatar, Brush, Check, Cross, Lock } from "./icons";
import { EndedStage, PlayerGrid, Timer } from "./shared";
import { StrokesView } from "./StrokesView";
```

In `PlayerDrawing` (lines 60-78), pull `round` and `recordDrawing`, add the unmount record and the stroke-end draft:

```tsx
function PlayerDrawing({ actions }: { actions: GameActions }) {
  const prompt = useGameStore((s) => s.yourPrompt);
  const endsAt = useGameStore((s) => s.phaseEndsAt);
  const players = useGameStore((s) => s.players);
  const round = useGameStore((s) => s.round);
  const recordDrawing = useGameStore((s) => s.recordDrawing);
  const remaining = useCountdown(endsAt);
  const [submitted, setSubmitted] = useState(false);
  const strokesRef = useRef<Stroke[]>([]);

  const submit = useCallback(() => {
    setSubmitted((was) => {
      if (!was) actions.submitDrawing(strokesRef.current);
      return true;
    });
  }, [actions]);

  // Auto-submit whatever is on the canvas when the clock runs out.
  useEffect(() => {
    if (remaining === 0 && !submitted) submit();
  }, [remaining, submitted, submit]);

  // Keep this round's final strokes for the player's own gallery + download,
  // even if they never tapped Lock-in (the cleanup fires when the round ends).
  useEffect(() => {
    return () => recordDrawing(round, strokesRef.current);
  }, [round, recordDrawing]);
```

In the `DrawingCanvas` usage (lines 109-122), add the `onStrokeEnd` draft emit:

```tsx
          <DrawingCanvas
            onChange={(s) => {
              strokesRef.current = s;
            }}
            onStrokeEnd={() => actions.draftDrawing(strokesRef.current)}
            footer={
              <button
                type="button"
                className="btn-key w-full px-6 py-4 text-lg short:px-3 short:py-2.5 short:text-sm"
                onClick={submit}
              >
                Lock in my drawing →
              </button>
            }
          />
```

- [ ] **Step 4: Show the player's own drawing + download in `PlayerReveal`**

In `frontend/src/components/game/PlayerStage.tsx`, update `PlayerReveal` (line 194) to read `round` + `myDrawings`, and render the drawing + Download button. Change the signature line and add the lookups:

```tsx
function PlayerReveal({ name }: { name: string }) {
  const reveal = useGameStore((s) => s.reveal);
  const players = useGameStore((s) => s.players);
  const round = useGameStore((s) => s.round);
  const myDrawings = useGameStore((s) => s.myDrawings);
  const mine = myDrawings[round] ?? [];
  const me = players.find((p) => p.name === name);
  const noArtist = !reveal?.artist;
  const youAreArtist = reveal?.artist === name;
  const got = me?.correct ?? false;
```

Then, between the result card `</div>` and the "Waiting for the host" `<p>` (after line 245), insert the own-drawing block:

```tsx
      </div>

      {mine.length > 0 && (
        <div className="card-arcade flex shrink-0 flex-col gap-3 p-4">
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            Your drawing
          </span>
          <StrokesView strokes={mine} />
          <button
            type="button"
            className="btn-ghost w-full px-4 py-2.5 text-sm"
            onClick={() => downloadStrokesPng(mine, pngFilename(round))}
          >
            Download PNG ↓
          </button>
        </div>
      )}

      <p className="text-center text-sm text-muted">
        Waiting for the host to continue
        <span className="live-dot ml-1 text-primary">●</span>
      </p>
```

- [ ] **Step 5: Run tests + typecheck + lint**

Run: `cd frontend && npx vitest run src/components/game/stages.test.tsx && npm run typecheck && npm run lint`
Expected: PASS (including the existing stage-split tests); typecheck + lint clean.

- [ ] **Step 6: Stop — do not commit.** Report green.

---

## Task 9: Frontend — `HostReveal` gallery of every player's drawing

**Files:**
- Modify: `frontend/src/components/game/HostStage.tsx:217-301` (`HostReveal`)
- Test: `frontend/src/components/game/stages.test.tsx` (append)

**Interfaces:**
- Consumes: store `gallery` (Task 4), `StrokesView`, `reveal`.
- Produces: under the big featured drawing, a labeled strip of every drawing ("drawn by X"), featured tile highlighted.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/components/game/stages.test.tsx`:

```tsx
  it("host reveal shows a labeled gallery of every drawing", () => {
    useGameStore.setState({
      phase: "reveal",
      round: 1,
      players: [{ name: "ann" }, { name: "bob" }],
      reveal: { artist: "bob", prompt: "cat" },
      currentDrawing: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }],
      gallery: {
        ann: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }],
        bob: [{ color: "#f00", width: 4, points: [{ x: 2, y: 2 }] }],
      },
    });
    const { container, getByText } = render(
      <HostStage name="tv" actions={noopActions} />,
    );
    // Featured (big) + 2 gallery tiles = at least 3 canvases.
    expect(container.querySelectorAll("canvas").length).toBeGreaterThanOrEqual(3);
    expect(getByText("ann")).toBeTruthy();
    expect(getByText("bob")).toBeTruthy();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/game/stages.test.tsx`
Expected: FAIL — only the featured canvas renders; names `ann`/`bob` not present.

- [ ] **Step 3: Render the gallery strip**

In `frontend/src/components/game/HostStage.tsx`, in `HostReveal` add `gallery` to the selectors (after line 220):

```tsx
  const drawing = useGameStore((s) => s.currentDrawing);
  const reveal = useGameStore((s) => s.reveal);
  const players = useGameStore((s) => s.players);
  const gallery = useGameStore((s) => s.gallery);
  const round = useGameStore((s) => s.round);
```

Replace the left column — the featured drawing box (lines 231-247) — wrapping it in a flex column and appending the gallery strip below it. Replace this:

```tsx
      {noArtist ? (
        <div
          className={`flex flex-col items-center justify-center gap-3 p-8 text-center ${HOST_CANVAS_BOX}`}
        >
          <Brush className="h-12 w-12 text-muted" />
          <p className="font-display text-2xl font-bold">
            Nobody drew anything
          </p>
          <p className="text-sm text-muted">
            Everyone ran out of time or left the canvas blank.
          </p>
        </div>
      ) : (
        <div className={HOST_CANVAS_BOX}>
          <StrokesView strokes={drawing} className={HOST_CANVAS} />
        </div>
      )}
```

with:

```tsx
      {noArtist ? (
        <div
          className={`flex flex-col items-center justify-center gap-3 p-8 text-center ${HOST_CANVAS_BOX}`}
        >
          <Brush className="h-12 w-12 text-muted" />
          <p className="font-display text-2xl font-bold">
            Nobody drew anything
          </p>
          <p className="text-sm text-muted">
            Everyone ran out of time or left the canvas blank.
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-col gap-3">
          <div className={`min-h-0 flex-1 ${HOST_CANVAS_BOX}`}>
            <StrokesView strokes={drawing} className={HOST_CANVAS} />
          </div>
          {Object.keys(gallery).length > 0 && (
            <div className="shrink-0">
              <span className="font-mono text-xs uppercase tracking-widest text-muted">
                Everyone's drawings
              </span>
              <ul className="mt-2 flex gap-3 overflow-x-auto pb-1">
                {Object.entries(gallery).map(([artist, strokes]) => (
                  <li
                    key={artist}
                    className={`shrink-0 rounded-xl border-2 p-1.5 ${
                      artist === reveal?.artist
                        ? "border-foreground"
                        : "border-border"
                    }`}
                  >
                    <StrokesView
                      strokes={strokes}
                      className="aspect-[4/3] w-32 rounded-lg border border-border bg-surface"
                    />
                    <span
                      dir="auto"
                      className="mt-1 block max-w-32 truncate text-center text-xs font-semibold"
                    >
                      {artist}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
```

(`round` is read for parity with the player side and future use; if lint flags it as unused, drop that selector line.)

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `cd frontend && npx vitest run src/components/game/stages.test.tsx && npm run typecheck && npm run lint`
Expected: PASS; typecheck + lint clean. (If lint flags unused `round`, remove the `const round = ...` line and re-run.)

- [ ] **Step 5: Stop — do not commit.** Report green.

---

## Task 10: Frontend — player game-end gallery (replaces leaderboard on the phone)

**Files:**
- Modify: `frontend/src/components/game/shared.tsx:285-339` (`EndedStage`)
- Modify: `frontend/src/components/game/HostStage.tsx:51` and `PlayerStage.tsx:33` (pass `screen`)
- Test: `frontend/src/components/game/stages.test.tsx` (append + tighten)

**Interfaces:**
- Consumes: store `myDrawings` (Task 4), `downloadStrokesPng` / `pngFilename` (Task 5), `StrokesView`.
- Produces: `EndedStage` gains `screen?: "host" | "player"`. Host (default) keeps winner + `Scoreboard` + optional Play-again. Player shows a compact winner banner + a per-round "your drawings" gallery with per-item download and a Download-all, then the waiting line — **no scoreboard**.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/components/game/stages.test.tsx`:

```tsx
  it("player ended shows their drawings with downloads, not the scoreboard", () => {
    useGameStore.setState({
      phase: "ended",
      players: [
        { name: "ann", score: 120 },
        { name: "bob", score: 80 },
      ],
      myDrawings: {
        1: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }],
        2: [{ color: "#f00", width: 4, points: [{ x: 2, y: 2 }] }],
      },
    });
    const { container, getAllByText, queryByText } = render(
      <PlayerStage name="ann" actions={noopActions} />,
    );
    // Two own drawings → two canvases, each with a download control.
    expect(container.querySelectorAll("canvas").length).toBe(2);
    expect(getAllByText(/download/i).length).toBeGreaterThanOrEqual(2);
    // No leaderboard rank numbers on the phone.
    expect(queryByText(/play again/i)).toBeNull();
  });
```

The existing `"player ended screen has no Play again button, just a wait"` test stays valid (no `myDrawings` set → empty gallery + waiting line).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/game/stages.test.tsx`
Expected: FAIL — player ended renders the scoreboard, no canvases.

- [ ] **Step 3: Branch `EndedStage` by `screen`**

In `frontend/src/components/game/shared.tsx`, update imports at the top (line 8) to add what the player variant needs:

```tsx
import { downloadStrokesPng, pngFilename } from "@/lib/canvas";
import type { Player } from "@/lib/protocol";
import { StrokesView } from "./StrokesView";
import { Alert, Avatar, Check, Crown, Eyes, Sparkle, Trophy } from "./icons";
```

(`Player` was already imported; only the three new imports are added. Run `npm run format` if Biome reorders them.)

Replace `EndedStage` (lines 285-339) with a host/player split:

```tsx
// EndedStage is the final results screen. The host TV (screen="host", default)
// shows the winner + full leaderboard, with Play-again via onPlayAgain. The
// player phone (screen="player") shows the winner banner + their own drawings to
// download — the leaderboard lives on the TV.
export function EndedStage({
  name,
  onPlayAgain,
  screen = "host",
}: {
  name: string;
  onPlayAgain?: () => void;
  screen?: "host" | "player";
}) {
  const players = useGameStore((s) => s.players);
  const ranked = [...players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const winner = ranked[0];
  const youWon = winner?.name === name;

  const banner = (
    <div className="card-arcade flex shrink-0 flex-col items-center gap-2 p-8 text-center">
      <span className="trophy-bounce text-foreground">
        {youWon ? (
          <Trophy className="h-12 w-12" />
        ) : (
          <Sparkle className="h-12 w-12" />
        )}
      </span>
      <h2 className="font-display text-2xl font-bold">Game over</h2>
      {winner && (
        <p className="text-sm text-muted">
          Winner:{" "}
          <span dir="auto" className="font-display font-bold text-foreground">
            {winner.name}
          </span>{" "}
          with {winner.score ?? 0} pts
        </p>
      )}
    </div>
  );

  if (screen === "player") {
    return <PlayerEnded banner={banner} />;
  }

  return (
    <div className="m-auto flex w-full max-w-2xl max-h-full min-h-0 flex-col gap-5">
      {banner}
      <div className="min-h-0 flex-1 overflow-auto pr-1">
        <Scoreboard players={players} />
      </div>
      {onPlayAgain ? (
        <button
          type="button"
          className="btn-key w-full shrink-0 px-6 py-4 text-lg"
          onClick={onPlayAgain}
        >
          Play again →
        </button>
      ) : (
        <p className="shrink-0 text-center text-sm text-muted">
          Waiting for the host to start a new game
          <span className="live-dot ml-1 text-foreground">●</span>
        </p>
      )}
    </div>
  );
}

// PlayerEnded is the phone's final screen: keepsake gallery of the player's own
// drawings, each downloadable, plus a Download-all. No leaderboard (that's on
// the TV); a waiting line tells them the host can restart.
function PlayerEnded({ banner }: { banner: React.ReactNode }) {
  const myDrawings = useGameStore((s) => s.myDrawings);
  const rounds = Object.keys(myDrawings)
    .map(Number)
    .filter((r) => (myDrawings[r]?.length ?? 0) > 0)
    .sort((a, b) => a - b);

  const downloadAll = () => {
    for (const r of rounds) downloadStrokesPng(myDrawings[r], pngFilename(r));
  };

  return (
    <div className="m-auto flex w-full max-w-2xl max-h-full min-h-0 flex-col gap-5">
      {banner}
      {rounds.length > 0 ? (
        <>
          <div className="flex shrink-0 items-center justify-between">
            <h3 className="font-display text-lg font-bold">Your drawings</h3>
            <button
              type="button"
              className="btn-ghost px-3 py-1.5 text-sm"
              onClick={downloadAll}
            >
              Download all ↓
            </button>
          </div>
          <ul className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-auto pr-1 sm:grid-cols-3">
            {rounds.map((r) => (
              <li key={r} className="card-arcade flex flex-col gap-2 p-3">
                <StrokesView strokes={myDrawings[r]} />
                <button
                  type="button"
                  className="btn-ghost px-3 py-2 text-sm"
                  onClick={() => downloadStrokesPng(myDrawings[r], pngFilename(r))}
                >
                  Download round {r} ↓
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="shrink-0 text-center text-sm text-muted">
          No drawings to show from this game.
        </p>
      )}
      <p className="shrink-0 text-center text-sm text-muted">
        Waiting for the host to start a new game
        <span className="live-dot ml-1 text-foreground">●</span>
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Pass `screen` from the two stages**

In `frontend/src/components/game/HostStage.tsx`, the ended case (line 51):

```tsx
    case "ended":
      return (
        <EndedStage name={name} onPlayAgain={actions.returnToLobby} screen="host" />
      );
```

In `frontend/src/components/game/PlayerStage.tsx`, the ended case (line 33):

```tsx
    case "ended":
      return <EndedStage name={name} screen="player" />;
```

- [ ] **Step 5: Run the full frontend suite + typecheck + lint**

Run: `cd frontend && npm test && npm run typecheck && npm run lint`
Expected: ALL tests PASS; typecheck + lint clean.

- [ ] **Step 6: Stop — do not commit.** Report green. Feature complete.

---

## Final verification (run after all tasks)

- [ ] Backend: `cd backend && go test ./...` — all PASS.
- [ ] Frontend: `cd frontend && npm test && npm run typecheck && npm run lint` — all PASS/clean.
- [ ] Manual smoke (optional, via `/run`): host TV + 4 phones; draw without locking and let the timer expire → drawings survive into guessing; reveal shows the labeled gallery on the TV; use Fill + the hex picker; at game end each phone shows its own drawings and downloads a PNG.
- [ ] **Do not commit.** Hand the green working tree to the user for commit.

## Spec coverage map

| Spec part | Task(s) |
|---|---|
| A — auto-lock via draft-sync | 2 (server), 6 (action), 8 (client wiring) |
| B — host-TV reveal gallery | 3 (backend view), 9 (UI) |
| C — player view + download own drawings | 4 (accumulation), 5 (download), 8 (reveal), 10 (game-end gallery) |
| D — fill bucket + hex picker | 1 (field), 5 (render), 7 (toolbar) |
| E — tests | every task is TDD; final verification above |
