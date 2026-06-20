# Skip Guessing When Only One Drawing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When exactly one non-empty drawing exists in a round, skip the (trivially-decidable) guessing phase and award the lone artist a fixed half-pot.

**Architecture:** A single guard in `beginGuessing` — the chokepoint both the early-advance (`submitDrawing` → `allLocked`) and timer-expiry (`advance`) routes pass through. When one drawing is present, a new `beginSoloReveal` awards the artist and opens the reveal directly. Backend-only; the existing reveal UI renders unchanged.

**Tech Stack:** Go (`backend/internal/game`), standard `testing` package.

## Global Constraints

- Award is a fixed **half pot** = `pointsMax / 2` = **50**. Not configurable.
- "One drawing present" = exactly **one non-empty** drawing (`len(Drawings[name]) > 0`). Empty lock-ins do not count.
- Zero drawings keeps the existing nobody-drew path (`Featured == ""` → `beginReveal`). 2+ drawings keeps the existing guessing path.
- The skipped round still counts toward `TotalRounds`; reveal is host-advanced (untimed).
- **Do NOT run `git commit` / `git push`** — the user performs all commits (project rule). The final step stages context for the user only.
- Run backend tests from the `backend/` directory: `go test ./internal/game/`.

---

### Task 1: Skip guessing and award the lone artist

**Files:**
- Modify: `backend/internal/game/room.go` (add `soloPot` constant beside the other scoring tunables)
- Modify: `backend/internal/game/rounds.go` (`beginGuessing` guard; add `drawerCount`, `beginSoloReveal`)
- Test: `backend/internal/game/room_test.go` (append three tests)

**Interfaces:**
- Consumes (existing, unchanged): `r.pickFeatured() string`, `r.beginReveal()`, `r.startPhase(p Phase, durMs int)`, `r.state.playerIndex(name string) int`, `r.state.Drawings map[string][]Stroke`, `r.state.Players []Player`, `r.state.LastDeltas map[string]int`, `r.state.FeaturedPast []string`, `r.state.Featured string`, `pointsMax = 100`.
- Test helpers (existing in `room_test.go`): `syncRoom(t, players...) *Room` (returns a started room in drawing phase), `draft(r, name)` (stores a non-empty draft for `name`), `r.advance()` (simulates the drawing-phase timer firing → `beginGuessing`), `r.handle(Command{...})`.
- Produces: `soloPot` constant (= 50), `(*Room).drawerCount() int`, `(*Room).beginSoloReveal()`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/internal/game/room_test.go`:

```go
func TestSoloDrawingSkipsGuessing(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	draft(r, "alice") // only alice draws anything
	r.advance()       // drawing timer fires → beginGuessing

	if r.state.Phase != PhaseReveal {
		t.Fatalf("phase = %q, want reveal (one drawing skips guessing)", r.state.Phase)
	}
	if r.state.Featured != "alice" {
		t.Fatalf("featured = %q, want alice", r.state.Featured)
	}
	if got := r.state.LastDeltas["alice"]; got != soloPot {
		t.Fatalf("alice delta = %d, want %d (solo half-pot)", got, soloPot)
	}
	if i := r.state.playerIndex("alice"); r.state.Players[i].Score != soloPot {
		t.Fatalf("alice score = %d, want %d", r.state.Players[i].Score, soloPot)
	}
	for _, n := range []string{"bob", "carol", "dave"} {
		if got := r.state.LastDeltas[n]; got != 0 {
			t.Fatalf("%s delta = %d, want 0 (no guessing happened)", n, got)
		}
	}
	if len(r.state.FeaturedPast) != 1 || r.state.FeaturedPast[0] != "alice" {
		t.Fatalf("featuredPast = %v, want [alice]", r.state.FeaturedPast)
	}
}

func TestTwoDrawingsStillGuess(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	draft(r, "alice")
	draft(r, "bob")
	r.advance()
	if r.state.Phase != PhaseGuessing {
		t.Fatalf("phase = %q, want guessing (two drawings is a real round)", r.state.Phase)
	}
}

func TestEmptyLockInIsNotADrawing(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	draft(r, "alice") // one real drawing
	// bob locks in an empty canvas — must not count as a second drawing.
	r.handle(Command{Kind: CmdSubmitDrawing, Player: "bob", Strokes: nil})
	r.advance()
	if r.state.Phase != PhaseReveal {
		t.Fatalf("phase = %q, want reveal (empty lock-in is not a drawing)", r.state.Phase)
	}
	if r.state.Featured != "alice" {
		t.Fatalf("featured = %q, want alice", r.state.Featured)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'TestSoloDrawingSkipsGuessing|TestTwoDrawingsStillGuess|TestEmptyLockInIsNotADrawing' -v`
Expected: `TestSoloDrawingSkipsGuessing` and `TestEmptyLockInIsNotADrawing` FAIL — undefined: `soloPot`, and (once that compiles) phase is `guessing` not `reveal`. (Compile error counts as failing; it blocks the whole package until Step 3.)

- [ ] **Step 3: Add the `soloPot` constant**

In `backend/internal/game/room.go`, in the `const (...)` block, add `soloPot` immediately after the `speedSpread` line (room.go:77):

```go
	// speedSpread is how much of a correct guess rides on speed: it scores from
	// pointsMax (instant) down to pointsMax-speedSpread (at the buzzer).
	speedSpread = 50
	// soloPot is the lone artist's award when they are the only one who drew this
	// round. With a single drawing, "who drew it?" has one trivially correct
	// answer, so guessing is skipped and the artist takes half the pot for the
	// unchallenged drawing (see beginSoloReveal).
	soloPot = pointsMax / 2
```

- [ ] **Step 4: Add the skip guard and helpers**

In `backend/internal/game/rounds.go`, replace `beginGuessing` (rounds.go:76-85):

```go
func (r *Room) beginGuessing() {
	r.state.Featured = r.pickFeatured()
	if r.state.Featured == "" {
		// Nobody drew anything this round — there's nothing to guess, so skip
		// straight to the reveal (which shows a "nobody drew" message).
		r.beginReveal()
		return
	}
	if r.drawerCount() == 1 {
		// Only one drawing exists, so "who drew it?" has a single trivially
		// correct answer. Skip the guessing phase and award the lone artist.
		r.beginSoloReveal()
		return
	}
	r.startPhase(PhaseGuessing, r.state.GuessMs)
}

// drawerCount returns how many players drew something non-empty this round. An
// empty lock-in does not count — it can be neither featured nor guessed.
func (r *Room) drawerCount() int {
	n := 0
	for _, p := range r.state.Players {
		if len(r.state.Drawings[p.Name]) > 0 {
			n++
		}
	}
	return n
}

// beginSoloReveal handles the single-drawing case: skip the guessing phase,
// award the lone featured artist a fixed half-pot (no guesser scores, since
// nobody guessed), record the per-round delta, and open the host-advanced
// reveal. Mirrors beginReveal's FeaturedPast bookkeeping so featured coverage
// still spreads across rounds.
func (r *Room) beginSoloReveal() {
	deltas := map[string]int{}
	if i := r.state.playerIndex(r.state.Featured); i >= 0 {
		r.state.Players[i].Score += soloPot
		deltas[r.state.Featured] += soloPot
	}
	r.state.FeaturedPast = append(r.state.FeaturedPast, r.state.Featured)
	r.state.LastDeltas = deltas
	r.startPhase(PhaseReveal, 0)
}
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `cd backend && go test ./internal/game/ -run 'TestSoloDrawingSkipsGuessing|TestTwoDrawingsStillGuess|TestEmptyLockInIsNotADrawing' -v`
Expected: all three PASS.

- [ ] **Step 6: Run the full game package suite (regression check)**

Run: `cd backend && go test ./internal/game/`
Expected: `ok` — the whole package passes. (`TestEmptyDraftNotFeatured` asserts only `Featured == "alice"`, which `beginSoloReveal` still sets, so it remains green despite the new reveal-vs-guessing phase.)

- [ ] **Step 7: Hand off for commit**

Do **not** run `git commit`. Report to the user the files changed (`room.go`, `rounds.go`, `room_test.go`) plus the two design docs, and let them commit.

---

## Self-Review

**Spec coverage:**
- Half-pot award (50) → `soloPot = pointsMax / 2`, applied in `beginSoloReveal` (Task 1, Steps 3–4); asserted in `TestSoloDrawingSkipsGuessing`. ✓
- Skip guessing on one drawing, show reveal, host advances → `beginGuessing` guard + `beginSoloReveal` calls `startPhase(PhaseReveal, 0)`. ✓
- "One drawing" = exactly one non-empty; empty lock-ins excluded → `drawerCount` counts `len > 0`; `TestEmptyLockInIsNotADrawing`. ✓
- Zero unchanged, 2+ unchanged → guard order (empty → `beginReveal`; else count check); `TestTwoDrawingsStillGuess`. ✓
- Backend-only, no frontend/protocol change → only `room.go`, `rounds.go`, `room_test.go` touched. ✓
- Round still counts toward `TotalRounds` → no change to `Round`/`TotalRounds`; reveal proceeds to host's normal Next. ✓
- `FeaturedPast` consistency → appended in `beginSoloReveal`; asserted in `TestSoloDrawingSkipsGuessing`. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `soloPot` (room.go const), `drawerCount()` / `beginSoloReveal()` (rounds.go) referenced identically in tests and implementation; `pointsMax` reused from room.go:74. Note: spec placed `soloPot` in `rounds.go`; this plan groups it with the sibling scoring constants (`pointsMax`, `speedSpread`) in `room.go` instead — same package, cleaner placement, no behavior change.
