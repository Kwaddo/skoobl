# Whose Doodle (Flipped Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Whose Doodle" game mode where, instead of naming who drew a shown drawing, players are given a target player and pick which anonymized drawing is theirs.

**Architecture:** A new `Mode` on `Config`/`GameState` (default `classic`, unchanged). The entire round engine is reused; only two things branch on `flipped`: the guessing projection in `viewFor` (sends a target name + an anonymized drawing pool instead of one hidden-artist drawing) and guess submission (the client sends an opaque drawing id, the server resolves it to the owner name and scores with the existing classic math). Drawing phase, timers, feature loop, reveal, and scoring formulas are untouched.

**Tech Stack:** Go backend (`internal/game`, `internal/realtime`), React + TypeScript + Zustand + Vite frontend, Socket.IO bridge, Vitest + Testing Library, Biome.

## Global Constraints

- **Classic is the default and must stay byte-for-byte unchanged.** Mode only ever *adds* branches. Every existing test stays green.
- **No answer leaks.** The flipped guessing view must never tell a guesser which drawing id belongs to the target, and must never echo the resolved owner name back to the guesser.
- **Drawing-id opacity.** Per-round drawing ids are random opaque tokens, carry no name, and are stable across a round's features.
- **Git:** the user runs all commits/pushes. Each "Commit" step means *stage the listed files and hand off* with the suggested message — do not run `git commit`/`git push` yourself.
- **Verification commands:** backend `cd backend && go test ./internal/game/`; frontend `cd frontend && npm run test && npm run typecheck`. Biome lint (`npm run lint`) has pre-existing unrelated format errors in `CodeCard.tsx`; only assert your touched files are clean via `npx biome check <files>`.
- Backend uses Go `min`/`max` builtins (Go ≥1.21).

---

## File Structure

**Backend (modify):**
- `backend/internal/game/state.go` — `Mode` type + consts, `Config.Mode`, public `GameState.Mode`, server-only `DrawIDs`, view-only `Target`/`YouAreTarget`/`Pool`, `PoolDrawing` type, `sanitizeMode`, `ownerOfDrawID`, `flippedPool`, `viewFor` echo + flipped guessing branch.
- `backend/internal/game/rounds.go` — `applyConfig` sets mode; `beginRound` clears `DrawIDs`; `beginGuessing` assigns ids in flipped; `assignDrawIDs`/`randDrawID` helpers.
- `backend/internal/game/actions.go` — `submitGuess` resolves the flipped id → owner.
- `backend/internal/game/room.go` — `Command.GuessID`.
- `backend/internal/realtime/socket.go` — `submitGuess` reads the `id` field.
- `backend/internal/game/room_test.go` — new tests.

**Frontend (modify):**
- `frontend/src/lib/protocol.ts` — `GameMode`, `PoolDrawing`, `GameState` + `GameConfig` fields.
- `frontend/src/lib/store.ts` — `mode`/`target`/`youAreTarget`/`pool` state.
- `frontend/src/hooks/use-game-socket.ts` — `submitDoodleGuess` action.
- `frontend/src/components/game/stages/HostConfig.tsx` — mode selector.
- `frontend/src/components/game/stages/PlayerStage.tsx` — flipped guessing + reveal branch.
- `frontend/src/components/game/stages/HostStage.tsx` — flipped guessing branch.

**Frontend (create):**
- `frontend/src/components/game/display/FlippedGuessing.tsx` — the target header + anonymized doodle grid (used by player and host).
- `frontend/src/lib/mode-store.test.ts` — store mode-mapping test.

---

## Task 1: Backend mode foundation (config + state + view echo)

**Files:**
- Modify: `backend/internal/game/state.go`
- Modify: `backend/internal/game/rounds.go` (`applyConfig`)
- Test: `backend/internal/game/room_test.go`

**Interfaces:**
- Produces: `type Mode string`; `ModeClassic`, `ModeFlipped Mode`; `Config.Mode Mode` (JSON `mode`); `GameState.Mode Mode` (JSON `mode`, public); `sanitizeMode(Mode) Mode`. Later tasks branch on `r.state.Mode == ModeFlipped`.

- [ ] **Step 1: Write the failing test**

Add to `backend/internal/game/room_test.go`:

```go
func TestModeConfiguredAndEchoed(t *testing.T) {
	r := syncLobby(t, "alice", "bob", "carol", "dave")

	r.handle(Command{Kind: CmdConfigure, Player: "tv", Config: &Config{
		Rounds: 3, Mode: ModeFlipped, DrawMs: 60000, GuessMs: 25000,
	}})
	if r.state.Mode != ModeFlipped {
		t.Fatalf("mode = %q, want flipped", r.state.Mode)
	}
	if v := r.state.viewFor("alice", r.present); v.Mode != ModeFlipped {
		t.Fatalf("view mode = %q, want flipped (must be public)", v.Mode)
	}

	// Unknown mode falls back to classic.
	r.handle(Command{Kind: CmdConfigure, Player: "tv", Config: &Config{
		Rounds: 3, Mode: "wat", DrawMs: 60000, GuessMs: 25000,
	}})
	if r.state.Mode != ModeClassic {
		t.Fatalf("mode = %q, want classic fallback", r.state.Mode)
	}
}
```

This needs a lobby helper (the existing `syncRoom` starts the game). Add it next to `syncRoom` in `room_test.go`:

```go
// syncLobby joins a host display ("tv") plus players and stops in the lobby
// (unlike syncRoom, which also starts the game). The tv is the host, so it may
// configure.
func syncLobby(t *testing.T, players ...string) *Room {
	t.Helper()
	r := NewRoom("lobby1")
	r.handle(Command{Kind: CmdJoin, Player: "tv", Spectator: true,
		Subscribe: make(chan GameState, 64), Ack: make(chan string, 1)})
	for _, n := range players {
		r.handle(Command{Kind: CmdJoin, Player: n,
			Subscribe: make(chan GameState, 64), Ack: make(chan string, 1)})
	}
	if r.state.Phase != PhaseLobby {
		t.Fatalf("phase = %q, want lobby", r.state.Phase)
	}
	return r
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/game/ -run TestModeConfiguredAndEchoed -v`
Expected: FAIL to compile — `ModeFlipped`, `Config.Mode`, `GameState.Mode` undefined.

- [ ] **Step 3: Add the Mode type, config/state fields, and sanitizer**

In `backend/internal/game/state.go`, add after the `Language` consts block (around line 35):

```go
// Mode selects the round variant. Classic is the default and is unchanged by the
// addition of other modes — mode only ever adds branches, never alters classic.
type Mode string

const (
	ModeClassic Mode = "classic" // current behavior; the default
	ModeFlipped Mode = "flipped" // Whose Doodle: pick which drawing is the target's
)

// sanitizeMode coerces an untrusted mode to a known value, defaulting to classic.
func sanitizeMode(m Mode) Mode {
	if m == ModeFlipped {
		return ModeFlipped
	}
	return ModeClassic
}
```

In the `Config` struct (around line 77) add the field:

```go
	Mode       Mode     `json:"mode"`       // round variant; empty/unknown ⇒ classic
```

In the `GameState` struct, add `Mode` next to `Phase` (public, around line 91):

```go
	Mode  Mode   `json:"mode"`
```

In `newGameState` (around line 139) add `Mode: ModeClassic,` to the literal.

In `viewFor`'s `v := GameState{...}` literal (around line 164), add `Mode: g.Mode,`.

- [ ] **Step 4: Set the mode in applyConfig**

In `backend/internal/game/rounds.go`, in `applyConfig` (around line 8), add at the end of the function body:

```go
	r.state.Mode = sanitizeMode(cfg.Mode)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && go test ./internal/game/ -run TestModeConfiguredAndEchoed -v`
Expected: PASS

- [ ] **Step 6: Run the full game suite (classic unchanged)**

Run: `cd backend && go test ./internal/game/`
Expected: ok — all existing tests still pass.

- [ ] **Step 7: Commit**

Stage `backend/internal/game/state.go`, `backend/internal/game/rounds.go`, `backend/internal/game/room_test.go`. Suggested message: `feat(game): add mode foundation (classic default, flipped enum)`. Hand off to the user to commit.

---

## Task 2: Frontend mode foundation (types, store, lobby selector)

**Files:**
- Modify: `frontend/src/lib/protocol.ts`
- Modify: `frontend/src/lib/store.ts`
- Modify: `frontend/src/components/game/stages/HostConfig.tsx`
- Create: `frontend/src/lib/mode-store.test.ts`

**Interfaces:**
- Consumes: `GameState.mode` from Task 1's `mode` JSON field.
- Produces: `GameMode = "classic" | "flipped" | "frenzy"`; store field `mode: GameMode`; `GameConfig.mode: GameMode`. Later frontend tasks read `useGameStore((s) => s.mode)`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/mode-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { GameState } from "./protocol";
import { useGameStore } from "./store";

describe("game mode in the store", () => {
  it("defaults to classic and carries an applied mode", () => {
    useGameStore.getState().reset();
    expect(useGameStore.getState().mode).toBe("classic");

    useGameStore.getState().applyState({
      code: "ABCD",
      phase: "lobby",
      host: "tv",
      players: [],
      mode: "flipped",
    } as GameState);

    expect(useGameStore.getState().mode).toBe("flipped");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/mode-store.test.ts`
Expected: FAIL — `mode` is `undefined` (not in the store).

- [ ] **Step 3: Add the protocol types**

In `frontend/src/lib/protocol.ts`, add after the `Language` type (around line 15):

```ts
// Round variant. Classic is the current game; flipped is "Whose Doodle".
export type GameMode = "classic" | "flipped" | "frenzy";
```

Add to the `GameState` interface (near `phase`):

```ts
  mode?: GameMode;
```

Add to the `GameConfig` interface:

```ts
  mode: GameMode;
```

- [ ] **Step 4: Add the store field**

In `frontend/src/lib/store.ts`:
- Import the type: add `GameMode` to the `import type { ... } from "./protocol"` list.
- In the `GameStore` interface add `mode: GameMode;` (next to `host`).
- In `initial` add `mode: "classic" as GameMode,`.
- In `applyState`'s returned object add `mode: s.mode ?? "classic",`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/mode-store.test.ts`
Expected: PASS

- [ ] **Step 6: Add the lobby mode selector**

In `frontend/src/components/game/stages/HostConfig.tsx`:

Import the type — add to the existing imports:

```tsx
import type { GameMode } from "@/lib/protocol";
```

Add game-mode form state (note: the existing `mode`/`setMode` is the *category* random/custom toggle — use a distinct `gameMode` name):

```tsx
  const [gameMode, setGameMode] = useState<GameMode>(
    () => useGameStore.getState().mode,
  );
```

Extend the `sync` `over` type to include it (add the line inside the `Partial<{...}>`):

```tsx
        gameMode: GameMode;
```

In the `const next = { ... }` object inside `sync`, add `gameMode,` to the seed.

In the `actions.configure({ ... })` call inside `sync`, add:

```tsx
        mode: next.gameMode,
```

Add the selector as the first `Row` (just inside the form, before the `Rounds` row):

```tsx
      <Row label="Mode">
        <Segmented
          value={gameMode}
          options={[
            { value: "classic" as const, label: "Classic" },
            { value: "flipped" as const, label: "Whose Doodle" },
          ]}
          onChange={(v) => {
            setGameMode(v);
            sync({ gameMode: v });
          }}
        />
      </Row>
```

Also add `gameMode` to the `useCallback` dependency array of `sync` (the array currently ending `..., categories]`).

- [ ] **Step 7: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

Stage `frontend/src/lib/protocol.ts`, `frontend/src/lib/store.ts`, `frontend/src/components/game/stages/HostConfig.tsx`, `frontend/src/lib/mode-store.test.ts`. Suggested message: `feat(lobby): add game-mode selector and store plumbing`. Hand off to the user to commit.

---

## Task 3: Backend flipped guessing view (drawing ids + anonymized pool)

**Files:**
- Modify: `backend/internal/game/state.go`
- Modify: `backend/internal/game/rounds.go`
- Test: `backend/internal/game/room_test.go`

**Interfaces:**
- Consumes: `r.state.Mode == ModeFlipped` (Task 1); `revealedExcept(current string) []string` (existing).
- Produces: `PoolDrawing{ID string, Strokes []Stroke}`; `GameState.DrawIDs map[string]string` (server-only, name→id); view fields `Target string`, `YouAreTarget bool`, `Pool []PoolDrawing`; helpers `flippedPool() []PoolDrawing`, `assignDrawIDs()`. Task 4 consumes `DrawIDs` via `ownerOfDrawID`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/internal/game/room_test.go`:

```go
func flippedRoomInGuessing(t *testing.T, names ...string) *Room {
	t.Helper()
	r := syncRoom(t, names...)
	r.state.Mode = ModeFlipped // configured in the lobby; set directly for the unit test
	for _, n := range names {
		draft(r, n)
	}
	r.advance() // drawing timer → flipped guessing
	if r.state.Phase != PhaseGuessing {
		t.Fatalf("phase = %q, want guessing", r.state.Phase)
	}
	return r
}

func TestFlippedGuessingView(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := flippedRoomInGuessing(t, names...)
	target := r.state.Featured

	guesser := "alice"
	if target == "alice" {
		guesser = "bob"
	}
	v := r.state.viewFor(guesser, r.present)
	if v.Mode != ModeFlipped {
		t.Fatalf("view mode = %q, want flipped", v.Mode)
	}
	if v.Target != target {
		t.Fatalf("target = %q, want %q", v.Target, target)
	}
	if v.YouAreTarget {
		t.Fatal("a non-target guesser must not see YouAreTarget")
	}
	if len(v.Pool) != 4 {
		t.Fatalf("pool size = %d, want 4 (all drew, none revealed)", len(v.Pool))
	}
	if v.CurrentDrawing != nil {
		t.Fatal("flipped guessing must not send a single currentDrawing")
	}
	for _, d := range v.Pool {
		if d.ID == "" {
			t.Fatal("pool drawing has no id")
		}
		for _, n := range names { // an id must never be a player name
			if d.ID == n {
				t.Fatalf("pool id %q leaks a player name", d.ID)
			}
		}
	}

	tv := r.state.viewFor(target, r.present)
	if !tv.YouAreTarget {
		t.Fatal("the target should see YouAreTarget")
	}
}

func TestFlippedPoolDropsRevealedTarget(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := flippedRoomInGuessing(t, names...)
	first := r.state.Featured
	firstID := r.state.DrawIDs[first]

	idsBefore := map[string]string{}
	for k, v := range r.state.DrawIDs {
		idsBefore[k] = v
	}

	r.beginReveal()
	r.handle(Command{Kind: CmdNextPhase, Player: "tv"}) // → second feature
	second := r.state.Featured

	for k, v := range r.state.DrawIDs {
		if idsBefore[k] != v {
			t.Fatalf("draw id for %q changed across features (%q→%q)", k, idsBefore[k], v)
		}
	}

	guesser := ""
	for _, n := range names {
		if n != first && n != second {
			guesser = n
			break
		}
	}
	v := r.state.viewFor(guesser, r.present)
	if len(v.Pool) != 3 {
		t.Fatalf("pool size = %d, want 3 (first target removed)", len(v.Pool))
	}
	for _, d := range v.Pool {
		if d.ID == firstID {
			t.Fatal("a revealed target's doodle is still in the pool")
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'TestFlipped' -v`
Expected: FAIL to compile — `DrawIDs`, `v.Target`, `v.Pool`, `v.YouAreTarget` undefined.

- [ ] **Step 3: Add the state fields and PoolDrawing type**

In `backend/internal/game/state.go`:

Add the type near `Reveal` (around line 74):

```go
// PoolDrawing is one anonymized candidate in flipped guessing: a stable per-round
// opaque id and the strokes, with no owner name attached.
type PoolDrawing struct {
	ID      string   `json:"id"`
	Strokes []Stroke `json:"strokes"`
}
```

In the authoritative round-data block of `GameState` (near `RoundFeatured`, around line 118) add:

```go
	DrawIDs map[string]string `json:"drawIds,omitempty"` // flipped: per-round opaque id per drawer (name→id); server-only, redacted by viewFor
```

In the view-only block of `GameState` (near `YouAreArtist`, around line 130) add:

```go
	Target       string        `json:"target,omitempty"`       // flipped guessing: whose doodle to find
	YouAreTarget bool          `json:"youAreTarget,omitempty"` // flipped guessing: you're the target, sit out
	Pool         []PoolDrawing `json:"pool,omitempty"`         // flipped guessing: anonymized candidate doodles
```

Add the pool builder near `revealedExcept` (around line 158):

```go
// flippedPool builds the anonymized candidate list for flipped guessing: every
// drawer whose doodle is still in play this round (not an already-revealed
// target), keyed by opaque id, in stable roster order. The current target's
// doodle is included but unlabeled — that's the one to find.
func (g *GameState) flippedPool() []PoolDrawing {
	revealed := map[string]bool{}
	for _, n := range g.revealedExcept(g.Featured) {
		revealed[n] = true
	}
	var pool []PoolDrawing
	for _, p := range g.Players {
		if len(g.Drawings[p.Name]) == 0 || revealed[p.Name] {
			continue
		}
		pool = append(pool, PoolDrawing{ID: g.DrawIDs[p.Name], Strokes: g.Drawings[p.Name]})
	}
	return pool
}
```

- [ ] **Step 4: Branch the guessing projection in viewFor**

In `backend/internal/game/state.go`, replace the existing `case PhaseGuessing:` block (around line 213) with:

```go
	case PhaseGuessing:
		if g.Mode == ModeFlipped {
			v.Target = g.Featured
			v.YouAreTarget = name == g.Featured
			v.Pool = g.flippedPool()
			// YourGuess is intentionally omitted in flipped: it holds the resolved
			// owner name, which would reveal the answer. The UI uses HasDrawn /
			// the player's HasGuessed flag instead.
		} else {
			v.CurrentDrawing = g.Drawings[g.Featured] // artist identity stays hidden
			v.YouAreArtist = name == g.Featured
			v.YourGuess = g.Guesses[name]
			// Drop earlier-revealed artists from the guess options. The drawing on
			// show (g.Featured) is excluded so it never leaks before its own reveal.
			v.Revealed = g.revealedExcept(g.Featured)
		}
```

- [ ] **Step 5: Assign ids each round in flipped**

In `backend/internal/game/rounds.go`:

Add `"fmt"` to the import block (it currently imports `"math/rand/v2"` and `"time"`).

In `beginRound` (around line 30) add to the per-round reset block:

```go
	r.state.DrawIDs = nil
```

In `beginGuessing`, right after the `drew == 0` early-return block and before computing `maxByDrawers`, add:

```go
	if r.state.Mode == ModeFlipped {
		r.assignDrawIDs()
	}
```

Add the helpers near `drawerCount` (around line 159):

```go
// assignDrawIDs gives every drawer this round a stable opaque id, used by flipped
// mode to show drawings without revealing who drew which. Regenerated each round
// (cleared in beginRound), so the same drawing keeps its id across a round's
// features but not across rounds.
func (r *Room) assignDrawIDs() {
	ids := make(map[string]string, len(r.state.Players))
	used := map[string]bool{}
	for _, p := range r.state.Players {
		if len(r.state.Drawings[p.Name]) == 0 {
			continue
		}
		id := randDrawID()
		for used[id] {
			id = randDrawID()
		}
		used[id] = true
		ids[p.Name] = id
	}
	r.state.DrawIDs = ids
}

func randDrawID() string {
	return fmt.Sprintf("d%08x", rand.Uint32())
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/game/ -run 'TestFlipped' -v`
Expected: PASS (both `TestFlippedGuessingView` and `TestFlippedPoolDropsRevealedTarget`).

- [ ] **Step 7: Run the full suite + vet/fmt**

Run: `cd backend && go test ./internal/game/ && go vet ./internal/game/ && gofmt -l internal/game/state.go internal/game/rounds.go`
Expected: ok; vet clean; `gofmt -l` prints nothing.

- [ ] **Step 8: Commit**

Stage `backend/internal/game/state.go`, `backend/internal/game/rounds.go`, `backend/internal/game/room_test.go`. Suggested message: `feat(game): flipped guessing view with anonymized doodle pool`. Hand off to the user to commit.

---

## Task 4: Backend flipped guess submission + scoring

**Files:**
- Modify: `backend/internal/game/room.go` (`Command`)
- Modify: `backend/internal/game/actions.go` (`submitGuess`)
- Modify: `backend/internal/game/state.go` (`ownerOfDrawID`)
- Modify: `backend/internal/realtime/socket.go` (`submitGuess` bridge)
- Test: `backend/internal/game/room_test.go`

**Interfaces:**
- Consumes: `DrawIDs` (Task 3), existing `beginReveal` scoring.
- Produces: `Command.GuessID string`; `ownerOfDrawID(id string) string`. After resolution, the existing `Guesses[guesser] == Featured` scoring is reused unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `backend/internal/game/room_test.go`:

```go
func TestFlippedCorrectGuessScores(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := flippedRoomInGuessing(t, names...)
	target := r.state.Featured
	targetID := r.state.DrawIDs[target]

	for _, n := range names {
		if n == target {
			continue
		}
		r.handle(Command{Kind: CmdSubmitGuess, Player: n, GuessID: targetID})
	}
	if r.state.Phase != PhaseReveal {
		t.Fatalf("phase = %q, want reveal once all non-targets matched", r.state.Phase)
	}
	for _, p := range r.state.Players {
		if p.Name == target {
			continue
		}
		if p.Score <= 0 {
			t.Fatalf("%s scored %d, want > 0 for a correct flipped match", p.Name, p.Score)
		}
	}
}

func TestFlippedWrongAndUnknownId(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := flippedRoomInGuessing(t, names...)
	target := r.state.Featured

	// A wrong (but valid) id: some non-target drawer's doodle.
	wrongOwner := ""
	for _, n := range names {
		if n != target {
			wrongOwner = n
			break
		}
	}
	wrongID := r.state.DrawIDs[wrongOwner]

	// An unknown id is ignored entirely (no guess recorded).
	r.handle(Command{Kind: CmdSubmitGuess, Player: target == "alice" && false || pickGuesser(names, target), GuessID: "dffffffff"})

	guesser := pickGuesser(names, target)
	r.handle(Command{Kind: CmdSubmitGuess, Player: guesser, GuessID: wrongID})
	if _, ok := r.state.Guesses[guesser]; !ok {
		t.Fatal("a valid wrong id should record a (wrong) guess")
	}
	if r.state.Guesses[guesser] == target {
		t.Fatal("a wrong id must not resolve to the target")
	}
}

// pickGuesser returns the first name that is not the target.
func pickGuesser(names []string, target string) string {
	for _, n := range names {
		if n != target {
			return n
		}
	}
	return ""
}
```

Note: simplify the unknown-id line — replace it with the clean version:

```go
	r.handle(Command{Kind: CmdSubmitGuess, Player: pickGuesser(names, target), GuessID: "dffffffff"})
	if _, ok := r.state.Guesses[pickGuesser(names, target)]; ok {
		t.Fatal("an unknown id must not record a guess")
	}
```

(Use this block in place of the single `r.handle(... "dffffffff")` line above, before the wrong-id assertions.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'TestFlippedCorrectGuessScores|TestFlippedWrongAndUnknownId' -v`
Expected: FAIL to compile — `Command.GuessID` undefined.

- [ ] **Step 3: Add the command field**

In `backend/internal/game/room.go`, in the `Command` struct's "Game payloads" block (around line 122) add:

```go
	GuessID string   // submitGuess (flipped): the chosen drawing id, resolved server-side to its owner
```

- [ ] **Step 4: Add the id→owner resolver**

In `backend/internal/game/state.go`, add near `playerIndex` (around line 150):

```go
// ownerOfDrawID returns the drawer whose flipped per-round id matches, or "" if
// none (unknown or stale id). Used to resolve a flipped guess (a drawing id) back
// to the player name the classic scoring path expects.
func (g *GameState) ownerOfDrawID(id string) string {
	if id == "" {
		return ""
	}
	for name, did := range g.DrawIDs {
		if did == id {
			return name
		}
	}
	return ""
}
```

- [ ] **Step 5: Resolve the flipped guess in submitGuess**

In `backend/internal/game/actions.go`, in `submitGuess` insert the resolution right after the phase guard and before the artist guard:

```go
func (r *Room) submitGuess(c Command) {
	if r.state.Phase != PhaseGuessing {
		return
	}
	if r.state.Mode == ModeFlipped {
		// In flipped the client picks a drawing id; resolve it to the owner so the
		// classic scoring path (Guesses[guesser] == Featured) works unchanged.
		owner := r.state.ownerOfDrawID(c.GuessID)
		if owner == "" {
			return // unknown or stale id
		}
		c.Guess = owner
	}
	if c.Player == r.state.Featured { // the target doesn't guess their own drawing
		return
	}
	// ... existing body unchanged (playerIndex checks, store Guesses/GuessTimes,
	// allGuessed → beginReveal) ...
```

Leave the rest of the function exactly as-is.

- [ ] **Step 6: Bridge the id field over Socket.IO**

In `backend/internal/realtime/socket.go`, replace the `submitGuess` handler (around line 71) with:

```go
	sock.On("submitGuess", func(args ...any) {
		c.submit(game.Command{
			Kind:    game.CmdSubmitGuess,
			Guess:   strings.TrimSpace(stringField(args, "artist")),
			GuessID: strings.TrimSpace(stringField(args, "id")),
		})
	})
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/game/ -run 'TestFlippedCorrectGuessScores|TestFlippedWrongAndUnknownId' -v`
Expected: PASS

- [ ] **Step 8: Run the full backend build + suites**

Run: `cd backend && go build ./... && go test ./...`
Expected: ok (game + realtime + others).

- [ ] **Step 9: Commit**

Stage `backend/internal/game/room.go`, `backend/internal/game/actions.go`, `backend/internal/game/state.go`, `backend/internal/realtime/socket.go`, `backend/internal/game/room_test.go`. Suggested message: `feat(game): resolve and score flipped doodle guesses`. Hand off to the user to commit.

---

## Task 5: Frontend flipped player UI (guessing grid + reveal answer)

**Files:**
- Modify: `frontend/src/lib/protocol.ts` (`PoolDrawing`, view fields)
- Modify: `frontend/src/lib/store.ts` (`target`/`youAreTarget`/`pool`)
- Modify: `frontend/src/hooks/use-game-socket.ts` (`submitDoodleGuess`)
- Create: `frontend/src/components/game/display/FlippedGuessing.tsx`
- Modify: `frontend/src/components/game/stages/PlayerStage.tsx`
- Test: `frontend/src/components/game/stages/stages.test.tsx`

**Interfaces:**
- Consumes: store `mode` (Task 2); backend `target`/`youAreTarget`/`pool` (Task 3); `submitGuess({id})` bridge (Task 4).
- Produces: `PoolDrawing` TS type; store `target: string`, `youAreTarget: boolean`, `pool: PoolDrawing[]`; action `submitDoodleGuess(id: string)`; component `FlippedGuessing` (with optional `onPick` ⇒ read-only when omitted, reused by Task 6).

- [ ] **Step 1: Write the failing test**

In `frontend/src/components/game/stages/stages.test.tsx`, add `submitDoodleGuess: () => {},` to the `noopActions` object, then add this test inside the `describe`:

```tsx
  it("flipped guessing shows a doodle grid for the target, not name buttons", () => {
    useGameStore.setState({
      phase: "guessing",
      mode: "flipped",
      target: "bob",
      youAreTarget: false,
      players: [{ name: "ann" }, { name: "bob", hasDrawn: true }],
      pool: [
        { id: "d1", strokes: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }] },
        { id: "d2", strokes: [{ color: "#f00", width: 4, points: [{ x: 2, y: 2 }] }] },
      ],
    });
    const { container, getByText, queryByText } = render(
      <PlayerStage name="ann" actions={noopActions} />,
    );
    // Two candidate doodles rendered as canvases (the grid).
    expect(container.querySelectorAll("canvas").length).toBe(2);
    // Header names the target.
    expect(getByText(/bob/i)).toBeTruthy();
    // Not the classic "who drew it?" name list.
    expect(queryByText(/who drew it/i)).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/game/stages/stages.test.tsx -t "flipped guessing"`
Expected: FAIL — store has no `target`/`pool`; PlayerStage renders the classic list.

- [ ] **Step 3: Add the protocol view types**

In `frontend/src/lib/protocol.ts`:

Add the type after `Stroke` (around line 28):

```ts
// One anonymized candidate doodle in flipped guessing.
export interface PoolDrawing {
  id: string;
  strokes: Stroke[];
}
```

Add to the `GameState` interface (near `youAreArtist`):

```ts
  // Flipped guessing only.
  target?: string;
  youAreTarget?: boolean;
  pool?: PoolDrawing[];
```

- [ ] **Step 4: Add the store fields**

In `frontend/src/lib/store.ts`:
- Add `PoolDrawing` to the `import type { ... } from "./protocol"` list.
- In the `GameStore` interface add (near `youAreArtist`):

```ts
  target: string;
  youAreTarget: boolean;
  pool: PoolDrawing[];
```

- In `initial` add:

```ts
  target: "",
  youAreTarget: false,
  pool: [] as PoolDrawing[],
```

- In `applyState`'s returned object add:

```ts
        target: s.target ?? "",
        youAreTarget: s.youAreTarget ?? false,
        pool: s.pool ?? [],
```

- [ ] **Step 5: Add the submit action**

In `frontend/src/hooks/use-game-socket.ts`, add to the returned object (after `submitGuess`):

```ts
    submitDoodleGuess: useCallback(
      (id: string) => emit("submitGuess", { id }),
      [emit],
    ),
```

- [ ] **Step 6: Create the FlippedGuessing component**

Create `frontend/src/components/game/display/FlippedGuessing.tsx`:

```tsx
import type { PoolDrawing } from "@/lib/protocol";
import { StrokesView } from "../canvas/StrokesView";
import { Brush } from "../icons";
import { FeatureProgress } from "./FeatureProgress";
import { Timer } from "./Timer";

// FlippedGuessing renders the "Whose Doodle" guess: a target name and a grid of
// anonymized candidate doodles. Pass onPick to make the tiles tappable (player
// controller); omit it for a read-only display (host TV).
export function FlippedGuessing({
  target,
  pool,
  youAreTarget = false,
  alreadyGuessed = false,
  remaining,
  guessMs,
  featureIndex,
  featureCount,
  onPick,
}: {
  target: string;
  pool: PoolDrawing[];
  youAreTarget?: boolean;
  alreadyGuessed?: boolean;
  remaining: number;
  guessMs: number;
  featureIndex: number;
  featureCount: number;
  onPick?: (id: string) => void;
}) {
  return (
    <div className="m-auto flex w-full max-h-full min-h-0 flex-col gap-4 lg:max-w-5xl">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex flex-col gap-2">
          <h2 className="ink-underline w-fit font-display text-2xl font-black">
            Which doodle is{" "}
            <span dir="auto" className="text-foreground">
              {target || "…"}
            </span>
            ’s?
          </h2>
          <FeatureProgress index={featureIndex} count={featureCount} />
        </div>
        <Timer remaining={remaining} total={Math.round(guessMs / 1000)} />
      </div>

      {youAreTarget ? (
        <p className="ink-block tilt-r flex items-center justify-center gap-2 px-5 py-6 text-center font-hand text-2xl leading-tight text-muted">
          <Brush className="h-5 w-5 shrink-0 text-foreground" />
          they’re hunting for your doodle — sit tight.
        </p>
      ) : alreadyGuessed ? (
        <p className="ink-block tilt-l px-5 py-6 text-center font-hand text-2xl leading-tight text-muted">
          locked in — waiting for the reveal…
        </p>
      ) : (
        <ul
          key={`pool-${featureIndex}`}
          className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-auto p-1 sm:grid-cols-3 lg:grid-cols-4"
        >
          {pool.map((d, i) => (
            <li key={d.id}>
              <button
                type="button"
                disabled={!onPick}
                onClick={() => onPick?.(d.id)}
                className="card-arcade card-hover card-press pop tape block aspect-[4/3] w-full overflow-hidden p-1"
                style={{ "--d": `${i * 35}ms` } as React.CSSProperties}
              >
                <StrokesView strokes={d.strokes} className="h-full w-full" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Branch PlayerGuessing to flipped**

In `frontend/src/components/game/stages/PlayerStage.tsx`:

Add the import:

```tsx
import { FlippedGuessing } from "../display/FlippedGuessing";
```

Inside `PlayerGuessing`, after the existing `useGameStore` selectors and `const remaining = useCountdown(endsAt);`, add:

```tsx
  const mode = useGameStore((s) => s.mode);
  const target = useGameStore((s) => s.target);
  const pool = useGameStore((s) => s.pool);
  const youAreTarget = useGameStore((s) => s.youAreTarget);
  const me = players.find((p) => p.name === name);

  if (mode === "flipped") {
    return (
      <FlippedGuessing
        target={target}
        pool={pool}
        youAreTarget={youAreTarget}
        alreadyGuessed={me?.hasGuessed ?? false}
        remaining={remaining}
        guessMs={guessMs}
        featureIndex={featureIndex}
        featureCount={featureCount}
        onPick={(id) => actions.submitDoodleGuess(id)}
      />
    );
  }
```

Place this `if` block *before* the existing `const options = players.filter(...)` line so the classic path is untouched when not flipped.

- [ ] **Step 8: Show the answer doodle in the flipped reveal**

Still in `PlayerStage.tsx`, in `PlayerReveal`, add two selectors near the existing ones:

```tsx
  const mode = useGameStore((s) => s.mode);
  const answer = useGameStore((s) => s.currentDrawing);
```

Then inside the `lg:flex` reveal row, immediately after the closing `</div>` of the reveal card (the `ink-block` block) and before the `{mine.length > 0 && (...)}` block, add:

```tsx
          {mode === "flipped" && answer.length > 0 && (
            <div className="card-arcade tape mt-3 flex shrink-0 flex-col gap-3 p-4 lg:mt-0 lg:flex-1">
              <span className="font-hand text-xl text-muted">
                {reveal?.artist ? `${reveal.artist}’s doodle` : "the answer"}
              </span>
              <StrokesView strokes={answer} />
            </div>
          )}
```

(`StrokesView` is already imported in `PlayerStage.tsx`.)

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/game/stages/stages.test.tsx -t "flipped guessing"`
Expected: PASS

- [ ] **Step 10: Typecheck + lint touched files + full test run**

Run:
```
cd frontend && npm run typecheck && npm run test && npx biome check src/components/game/display/FlippedGuessing.tsx src/components/game/stages/PlayerStage.tsx src/lib/store.ts src/lib/protocol.ts src/hooks/use-game-socket.ts
```
Expected: typecheck clean; all tests pass (canvas `getContext` jsdom warnings are pre-existing noise); biome reports no errors for these files.

- [ ] **Step 11: Commit**

Stage the six files (protocol, store, use-game-socket, FlippedGuessing, PlayerStage, stages.test). Suggested message: `feat(ui): flipped doodle-grid guessing and reveal on the player`. Hand off to the user to commit.

---

## Task 6: Frontend flipped host UI (guessing grid on the TV)

**Files:**
- Modify: `frontend/src/components/game/stages/HostStage.tsx`
- Test: `frontend/src/components/game/stages/stages.test.tsx`

**Interfaces:**
- Consumes: store `mode`/`target`/`pool` (Tasks 2, 5); `FlippedGuessing` with no `onPick` ⇒ read-only (Task 5).

- [ ] **Step 1: Write the failing test**

In `frontend/src/components/game/stages/stages.test.tsx`, add inside the `describe`:

```tsx
  it("host flipped guessing shows the doodle grid and names the target", () => {
    useGameStore.setState({
      phase: "guessing",
      mode: "flipped",
      target: "bob",
      players: [{ name: "ann" }, { name: "bob" }],
      pool: [
        { id: "d1", strokes: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }] },
        { id: "d2", strokes: [{ color: "#f00", width: 4, points: [{ x: 2, y: 2 }] }] },
      ],
    });
    const { container, getByText } = render(
      <HostStage name="tv" actions={noopActions} />,
    );
    expect(container.querySelectorAll("canvas").length).toBe(2);
    expect(getByText(/bob/i)).toBeTruthy();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/game/stages/stages.test.tsx -t "host flipped guessing"`
Expected: FAIL — `HostGuessing` renders the classic single canvas + "Who drew this?".

- [ ] **Step 3: Branch HostGuessing to flipped**

In `frontend/src/components/game/stages/HostStage.tsx`:

Add the import:

```tsx
import { FlippedGuessing } from "../display/FlippedGuessing";
```

In `HostGuessing`, after the existing selectors and `const remaining = useCountdown(endsAt);`, add and branch:

```tsx
  const mode = useGameStore((s) => s.mode);
  const target = useGameStore((s) => s.target);
  const pool = useGameStore((s) => s.pool);

  if (mode === "flipped") {
    return (
      <FlippedGuessing
        target={target}
        pool={pool}
        remaining={remaining}
        guessMs={guessMs}
        featureIndex={featureIndex}
        featureCount={featureCount}
      />
    );
  }
```

(No `onPick` ⇒ the tiles render disabled/read-only, which is correct for the TV. The existing classic `return ( ... )` stays below for non-flipped.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/game/stages/stages.test.tsx -t "host flipped guessing"`
Expected: PASS

- [ ] **Step 5: Full frontend verification**

Run: `cd frontend && npm run typecheck && npm run test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 6: Commit**

Stage `frontend/src/components/game/stages/HostStage.tsx`, `frontend/src/components/game/stages/stages.test.tsx`. Suggested message: `feat(ui): flipped doodle-grid guessing on the host screen`. Hand off to the user to commit.

---

## Task 7: Backend full flipped-round integration test

**Files:**
- Test: `backend/internal/game/room_test.go`

**Interfaces:**
- Consumes: everything from Tasks 1, 3, 4. No production code — this locks the whole flipped loop and guards against regressions.

- [ ] **Step 1: Write the test**

Add to `backend/internal/game/room_test.go`:

```go
func TestFlippedRoundRunsTwoFeaturesAndAdvances(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := flippedRoomInGuessing(t, names...)

	// 4 drawers, two-drawer margin ⇒ two features this round (same as classic).
	if r.state.FeatureCount != 2 {
		t.Fatalf("featureCount = %d, want 2", r.state.FeatureCount)
	}
	first := r.state.Featured

	// Everyone matches the first target's doodle, then the host reveals + advances.
	guessAllCorrect(r, names, first)
	if r.state.Phase != PhaseReveal {
		t.Fatalf("phase = %q, want reveal after first feature", r.state.Phase)
	}
	r.handle(Command{Kind: CmdNextPhase, Player: "tv"})
	if r.state.Phase != PhaseGuessing {
		t.Fatalf("phase = %q, want guessing for the second feature", r.state.Phase)
	}
	second := r.state.Featured
	if second == first {
		t.Fatalf("featured the same target twice in one round: %q", second)
	}

	// No non-target view ever exposes which pool id is the second target's.
	for _, n := range names {
		if n == second {
			continue
		}
		v := r.state.viewFor(n, r.present)
		for _, d := range v.Pool {
			if d.ID == r.state.DrawIDs[second] && len(v.Pool) == 1 {
				t.Fatal("pool collapsed to a single labeled answer")
			}
		}
	}

	guessAllCorrect(r, names, second)
	r.handle(Command{Kind: CmdNextPhase, Player: "tv"})
	if r.state.Phase != PhaseDrawing || r.state.Round != 2 {
		t.Fatalf("after the round: phase=%q round=%d, want drawing/2", r.state.Phase, r.state.Round)
	}
	if r.state.DrawIDs != nil {
		t.Fatal("DrawIDs should be cleared at the start of a new round")
	}
}

// guessAllCorrect has every non-target match the target's doodle id, driving the
// feature to its reveal.
func guessAllCorrect(r *Room, names []string, target string) {
	id := r.state.DrawIDs[target]
	for _, n := range names {
		if n == target {
			continue
		}
		r.handle(Command{Kind: CmdSubmitGuess, Player: n, GuessID: id})
	}
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd backend && go test ./internal/game/ -run TestFlippedRoundRunsTwoFeaturesAndAdvances -v`
Expected: PASS

- [ ] **Step 3: Full backend suite**

Run: `cd backend && go test ./...`
Expected: ok.

- [ ] **Step 4: Commit**

Stage `backend/internal/game/room_test.go`. Suggested message: `test(game): full flipped-round integration coverage`. Hand off to the user to commit.

---

## Self-Review

**Spec coverage** (against `2026-06-22-whose-doodle-flipped-mode-design.md`):
- Shared mode foundation (`Config.Mode`/`GameState.Mode`, lobby selector, `viewFor` echo) → Tasks 1, 2. ✓
- Round-engine reuse (feature count, `FeaturedPast`, `Revealed` removal, solo/no-draw/left-mid paths) → untouched; integration covered in Task 7. ✓
- Anonymized per-round drawing ids, stable across features → Task 3 (`assignDrawIDs`, `DrawIDs`, `flippedPool`); stability asserted in Tasks 3 & 7. ✓
- Target sits out (`YouAreTarget`) → Task 3. ✓
- Scoring mirror via id→owner resolution → Task 4. ✓
- Frontend doodle grid (player + host) + reveal answer → Tasks 5, 6. ✓
- Edge cases (nobody drew, one drawer, target left, reconnect) → handled by the reused engine; not separately tasked because no flipped-specific code touches them (the guessing view simply isn't reached). ✓
- Tests called out in the spec (redaction, scoring parity, revealed removal, stable ids) → Tasks 3, 4, 7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. The one inline note in Task 4 Step 1 (replacing the messy unknown-id line) is an explicit correction, not a placeholder.

**Type consistency:** `Mode`/`ModeFlipped`, `DrawIDs map[string]string`, `PoolDrawing{ID,Strokes}` / `pool: PoolDrawing[]`, `Target`/`target`, `YouAreTarget`/`youAreTarget`, `Command.GuessID` ↔ `submitGuess({id})` ↔ `stringField(args,"id")`, `submitDoodleGuess(id)` — names line up across backend and frontend tasks. `FlippedGuessing` props identical in Tasks 5 (with `onPick`) and 6 (without).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-22-whose-doodle-flipped-mode.md`.
