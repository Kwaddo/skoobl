# Points System Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat "+100 per correct guess" scoring with a speed-based reward for guessers and a depletable pot for the featured artist.

**Architecture:** All scoring lives in the authoritative `Room` actor (`backend/internal/game`). Per-round, correct guessers earn points on a linear speed curve (fastest = `pointsMax`, buzzer = `pointsMax-speedSpread`); the featured artist earns a pot that shrinks with each player who identifies them (none → `pointsMax`, all → 0). Two pure helpers (`speedScore`, `artistPot`) hold the math so they unit-test without a running room. The per-round delta is surfaced to clients through `viewFor` as a redacted-safe view field and rendered on the reveal screen.

**Tech Stack:** Go (backend, standard `testing`), React + TypeScript + Vitest (frontend), Zustand store.

## Global Constraints

- `pointsMax = 100` — caps both a guesser's fastest correct guess and the artist's full pot. Keep them equal.
- `speedSpread = 50` — a correct guess scores from `pointsMax` (instant) down to `pointsMax - speedSpread` (buzzer). Floor for a correct guess is `pointsMax - speedSpread = 50`.
- Artist pot has **no floor** (0 is allowed when everyone identifies them).
- Guess changes stay allowed; speed is scored from the player's **final** guess timestamp.
- Wrong or absent final guess scores 0; wrong guesses are **not** penalized.
- New `GameState` fields are server-side round secrets — they must stay out of client views (`viewFor`) except the explicitly-surfaced `Player.RoundScore`.
- Backend tests run from `backend/`. Frontend tests run from `frontend/`.

---

### Task 1: Backend scoring engine

Rewrite the round scoring: add the two scoring helpers, the supporting state, the
guess timestamp, and the new `beginReveal`. Replaces the `pointsPerCorrect` model.

**Files:**
- Modify: `backend/internal/game/state.go` (add `GuessTimes`, `LastDeltas` fields to `GameState`)
- Modify: `backend/internal/game/room.go` (constants, `import "math"`, `submitGuess`, `speedScore`, `artistPot`, `beginReveal`, `beginRound`, `endGame`, `returnToLobby`)
- Test: `backend/internal/game/room_test.go`

**Interfaces:**
- Produces:
  - `func (r *Room) speedScore(guessedAt int64) int` — points for a correct guess made at unix-ms `guessedAt`, using `r.state.PhaseEndsAt` and `r.state.GuessMs`.
  - `func artistPot(correct, eligible int) int` — pure; the artist's round score.
  - `GameState.GuessTimes map[string]int64` — guesser → unix-ms of latest guess.
  - `GameState.LastDeltas map[string]int` — player → points earned in the just-scored round (consumed by Task 2).
  - Constants `pointsMax = 100`, `speedSpread = 50`.

- [ ] **Step 1: Add the new state fields**

In `state.go`, in the `GameState` "Authoritative round data" block (next to `Guesses`), add:

```go
	GuessTimes map[string]int64 `json:"guessTimes,omitempty"` // guesser → unix-ms of their latest guess
	LastDeltas map[string]int    `json:"lastDeltas,omitempty"` // player → points earned in the round just scored
```

- [ ] **Step 2: Add constants and the `math` import**

In `room.go`, add `"math"` to the import block. Replace the existing constant:

```go
	// Score awarded to a player who correctly identifies the artist.
	pointsPerCorrect = 100
```

with:

```go
	// pointsMax caps both per-round earnings: a guesser's fastest correct guess and
	// the artist's pot when nobody identifies them. Equal maxes keep a featured
	// round worth about the same as a round spent guessing.
	pointsMax = 100
	// speedSpread is how much of a correct guess rides on speed: it scores from
	// pointsMax (instant) down to pointsMax-speedSpread (at the buzzer).
	speedSpread = 50
```

- [ ] **Step 3: Write failing unit tests for the scoring helpers**

Append to `room_test.go`:

```go
func TestSpeedScoreCurve(t *testing.T) {
	// Window is [90_000, 100_000] (GuessMs before PhaseEndsAt).
	r := &Room{state: GameState{GuessMs: 10_000, PhaseEndsAt: 100_000}}
	cases := []struct {
		name      string
		guessedAt int64
		want      int
	}{
		{"instant", 90_000, pointsMax},
		{"midpoint", 95_000, pointsMax - speedSpread/2},
		{"buzzer", 100_000, pointsMax - speedSpread},
		{"before window clamps to max", 80_000, pointsMax},
		{"after window clamps to floor", 120_000, pointsMax - speedSpread},
	}
	for _, c := range cases {
		if got := r.speedScore(c.guessedAt); got != c.want {
			t.Fatalf("%s: speedScore(%d) = %d, want %d", c.name, c.guessedAt, got, c.want)
		}
	}
}

func TestArtistPot(t *testing.T) {
	cases := []struct{ correct, eligible, want int }{
		{0, 3, 100}, // nobody identifies → full pot
		{3, 3, 0},   // everyone identifies → nothing
		{1, 3, 67},  // one of three ≈ two-thirds
		{2, 4, 50},  // half
		{0, 0, 100}, // edge: no eligible guessers at all
	}
	for _, c := range cases {
		if got := artistPot(c.correct, c.eligible); got != c.want {
			t.Fatalf("artistPot(%d, %d) = %d, want %d", c.correct, c.eligible, got, c.want)
		}
	}
}
```

- [ ] **Step 4: Run the unit tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'TestSpeedScoreCurve|TestArtistPot' -v`
Expected: FAIL — compile error, `r.speedScore` and `artistPot` undefined.

- [ ] **Step 5: Implement the scoring helpers**

In `room.go`, add (place them just above `beginReveal`):

```go
// speedScore converts a correct guess's timestamp into points on a linear curve
// across the guess window: pointsMax for an instant guess down to
// pointsMax-speedSpread at the buzzer. Call it during beginReveal, before
// startPhase resets the phase clock. Timestamps outside the window are clamped.
func (r *Room) speedScore(guessedAt int64) int {
	if r.state.GuessMs <= 0 {
		return pointsMax
	}
	start := r.state.PhaseEndsAt - int64(r.state.GuessMs)
	f := float64(guessedAt-start) / float64(r.state.GuessMs)
	f = clampF(f, 0, 1)
	return int(math.Round(float64(pointsMax) - float64(speedSpread)*f))
}

// artistPot is the featured artist's round score: the full pot when nobody
// identifies them, zero when everyone does, linear between. eligible is the count
// of players who could have identified them.
func artistPot(correct, eligible int) int {
	if eligible <= 0 {
		return pointsMax
	}
	return int(math.Round(float64(pointsMax) * (1 - float64(correct)/float64(eligible))))
}
```

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `cd backend && go test ./internal/game/ -run 'TestSpeedScoreCurve|TestArtistPot' -v`
Expected: PASS (both tests).

- [ ] **Step 7: Record the guess timestamp**

In `room.go`, in `submitGuess`, replace this block:

```go
	if r.state.Guesses == nil {
		r.state.Guesses = map[string]string{}
	}
	r.state.Guesses[c.Player] = c.Guess
```

with:

```go
	if r.state.Guesses == nil {
		r.state.Guesses = map[string]string{}
	}
	if r.state.GuessTimes == nil {
		r.state.GuessTimes = map[string]int64{}
	}
	r.state.Guesses[c.Player] = c.Guess
	r.state.GuessTimes[c.Player] = time.Now().UnixMilli()
```

- [ ] **Step 8: Rewrite `beginReveal`**

In `room.go`, replace the entire `beginReveal` function (the `for guesser, guess := range r.state.Guesses` loop version) with:

```go
// beginReveal scores the round and opens the host-advanced reveal phase. Correct
// guessers earn speed points (faster = more); the featured artist earns a pot that
// shrinks with each player who identifies them. Scores are computed before
// startPhase resets the clock, so speedScore reads the live guess window.
func (r *Room) beginReveal() {
	deltas := map[string]int{}
	if r.state.Featured != "" {
		// eligible = everyone who could have identified the artist: connected
		// non-artists, unioned with any correct guesser who dropped after guessing
		// (so a correct guess can't be erased by disconnecting).
		eligible := map[string]bool{}
		for _, p := range r.state.Players {
			if p.Name == r.state.Featured {
				continue
			}
			if pr, ok := r.present[p.Name]; ok && pr.connected {
				eligible[p.Name] = true
			}
		}
		correct := 0
		for guesser, guess := range r.state.Guesses {
			if guesser == r.state.Featured || guess != r.state.Featured {
				continue
			}
			correct++
			eligible[guesser] = true
			if i := r.state.playerIndex(guesser); i >= 0 {
				pts := r.speedScore(r.state.GuessTimes[guesser])
				r.state.Players[i].Score += pts
				deltas[guesser] += pts
			}
		}
		pot := artistPot(correct, len(eligible))
		if i := r.state.playerIndex(r.state.Featured); i >= 0 {
			r.state.Players[i].Score += pot
			deltas[r.state.Featured] += pot
		}
		r.state.FeaturedPast = append(r.state.FeaturedPast, r.state.Featured)
	}
	r.state.LastDeltas = deltas
	r.startPhase(PhaseReveal, 0)
}
```

- [ ] **Step 9: Reset the new fields per round and on teardown**

In `room.go` `beginRound`, after the existing `r.state.Guesses = map[string]string{}` line, add:

```go
	r.state.GuessTimes = map[string]int64{}
	r.state.LastDeltas = nil
```

In `endGame`, after the existing `r.state.Guesses = nil` line, add:

```go
	r.state.GuessTimes = nil
	r.state.LastDeltas = nil
```

In `returnToLobby`, after its existing `r.state.Guesses = nil` line, add:

```go
	r.state.GuessTimes = nil
	r.state.LastDeltas = nil
```

- [ ] **Step 10: Update the existing full-flow scoring test**

In `room_test.go`, in `TestFullRoundFlowAndScoring`, replace the final assertion loop:

```go
	for _, p := range rev.Players {
		want := pointsPerCorrect
		if p.Name == artist {
			want = 0 // the artist doesn't guess and scores nothing this round
		}
		if p.Score != want {
			t.Fatalf("%s scored %d, want %d", p.Name, p.Score, want)
		}
	}
```

with (everyone identifies the artist → artist pot 0, each guesser earns a fast-guess score in `[50,100]`):

```go
	for _, p := range rev.Players {
		if p.Name == artist {
			if p.Score != 0 {
				t.Fatalf("artist %s scored %d, want 0 (everyone identified them)", p.Name, p.Score)
			}
			continue
		}
		if p.Score < pointsMax-speedSpread || p.Score > pointsMax {
			t.Fatalf("guesser %s scored %d, want within [%d,%d]", p.Name, p.Score, pointsMax-speedSpread, pointsMax)
		}
	}
```

- [ ] **Step 11: Add a "nobody identifies the artist" flow test**

Append to `room_test.go`:

```go
func TestArtistPotWhenNoneIdentify(t *testing.T) {
	r := NewRoom("pot0", WithGrace(time.Hour))
	go r.Run()
	defer r.Stop()

	joinSpec(t, r, "tv", make(chan GameState, 64))
	names := []string{"alice", "bob", "carol", "dave"}
	chans := map[string]chan GameState{}
	for _, n := range names {
		ch := make(chan GameState, 64)
		chans[n] = ch
		joinOK(t, r, n, ch)
	}

	r.Submit(Command{Kind: CmdStart, Player: "tv"})
	awaitPhase(t, chans["alice"], PhaseDrawing)
	for _, n := range names {
		r.Submit(Command{Kind: CmdSubmitDrawing, Player: n, Strokes: []Stroke{
			{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}}},
		}})
	}

	artist := ""
	for _, n := range names {
		if v := awaitPhase(t, chans[n], PhaseGuessing); v.YouAreArtist {
			artist = n
		}
	}
	if artist == "" {
		t.Fatal("no featured artist surfaced")
	}

	// Every guesser names a wrong player (anyone who is not the artist), so nobody
	// identifies the artist. allGuessed then advances to reveal.
	wrong := ""
	for _, n := range names {
		if n != artist {
			wrong = n
			break
		}
	}
	for _, n := range names {
		if n != artist {
			r.Submit(Command{Kind: CmdSubmitGuess, Player: n, Guess: wrong})
		}
	}

	rev := awaitPhase(t, chans["alice"], PhaseReveal)
	for _, p := range rev.Players {
		want := 0
		if p.Name == artist {
			want = pointsMax // nobody identified them → full pot
		}
		if p.Score != want {
			t.Fatalf("%s scored %d, want %d", p.Name, p.Score, want)
		}
	}
}
```

- [ ] **Step 12: Add the "correct guess survives a disconnect" test**

Append to `room_test.go`:

```go
func TestCorrectGuessCountsAfterDisconnect(t *testing.T) {
	r := NewRoom("dcpot", WithGrace(time.Hour)) // long grace: guesser isn't pruned
	go r.Run()
	defer r.Stop()

	joinSpec(t, r, "tv", make(chan GameState, 64))
	names := []string{"alice", "bob", "carol", "dave"}
	chans := map[string]chan GameState{}
	for _, n := range names {
		ch := make(chan GameState, 64)
		chans[n] = ch
		joinOK(t, r, n, ch)
	}

	r.Submit(Command{Kind: CmdStart, Player: "tv"})
	awaitPhase(t, chans["alice"], PhaseDrawing)
	for _, n := range names {
		r.Submit(Command{Kind: CmdSubmitDrawing, Player: n, Strokes: []Stroke{
			{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}}},
		}})
	}
	artist := ""
	for _, n := range names {
		if v := awaitPhase(t, chans[n], PhaseGuessing); v.YouAreArtist {
			artist = n
		}
	}

	// Pick a correct guesser who is not the artist; they guess right, then drop.
	first := ""
	for _, n := range names {
		if n != artist {
			first = n
			break
		}
	}
	r.Submit(Command{Kind: CmdSubmitGuess, Player: first, Guess: artist})
	r.Submit(Command{Kind: CmdDisconnect, Player: first, Unsub: chans[first]})

	// The remaining two connected guessers name a wrong player, advancing to reveal.
	for _, n := range names {
		if n == artist || n == first {
			continue
		}
		r.Submit(Command{Kind: CmdSubmitGuess, Player: n, Guess: n}) // self ≠ artist → wrong
	}

	rev := awaitPhase(t, chans["alice"], PhaseReveal)
	// eligible = 2 connected guessers + the disconnected-but-correct one = 3; 1 correct.
	wantPot := artistPot(1, 3) // 67
	scores := map[string]int{}
	for _, p := range rev.Players {
		scores[p.Name] = p.Score
	}
	if scores[artist] != wantPot {
		t.Fatalf("artist pot = %d, want %d (correct guess must survive the disconnect)", scores[artist], wantPot)
	}
	if scores[first] < pointsMax-speedSpread || scores[first] > pointsMax {
		t.Fatalf("disconnected correct guesser scored %d, want within [%d,%d]", scores[first], pointsMax-speedSpread, pointsMax)
	}
}
```

- [ ] **Step 13: Run the full game package test suite**

Run: `cd backend && go test ./internal/game/ -v`
Expected: PASS — all tests, including the updated `TestFullRoundFlowAndScoring` and the new `TestArtistPotWhenNoneIdentify` / `TestCorrectGuessCountsAfterDisconnect`. No remaining references to `pointsPerCorrect`.

- [ ] **Step 14: Commit**

```bash
cd backend && go build ./... && cd ..
git add backend/internal/game/state.go backend/internal/game/room.go backend/internal/game/room_test.go
git commit -m "feat: speed-based guesser scoring and depletable artist pot"
```

---

### Task 2: Surface the per-round delta in client views

Expose each player's points-earned-this-round on the reveal projection so clients
can show "+N". The raw `LastDeltas` map stays server-side; only the recipient-safe
`RoundScore` field is copied into views.

**Files:**
- Modify: `backend/internal/game/state.go` (`Player` struct view-only field; `viewFor` reveal case)
- Test: `backend/internal/game/room_test.go`

**Interfaces:**
- Consumes: `GameState.LastDeltas` (Task 1).
- Produces: `Player.RoundScore int` with json tag `roundScore,omitempty` — populated only in the reveal view.

- [ ] **Step 1: Add the view-only field to `Player`**

In `state.go`, in the `Player` struct's view-only block (after `Correct bool ...`), add:

```go
	RoundScore int `json:"roundScore,omitempty"` // reveal: points earned this round
```

- [ ] **Step 2: Write a failing test for the reveal delta**

Append to `room_test.go`:

```go
func TestRevealViewCarriesRoundScore(t *testing.T) {
	r := NewRoom("delta1", WithGrace(time.Hour))
	go r.Run()
	defer r.Stop()

	joinSpec(t, r, "tv", make(chan GameState, 64))
	names := []string{"alice", "bob", "carol", "dave"}
	chans := map[string]chan GameState{}
	for _, n := range names {
		ch := make(chan GameState, 64)
		chans[n] = ch
		joinOK(t, r, n, ch)
	}

	r.Submit(Command{Kind: CmdStart, Player: "tv"})
	awaitPhase(t, chans["alice"], PhaseDrawing)
	for _, n := range names {
		r.Submit(Command{Kind: CmdSubmitDrawing, Player: n, Strokes: []Stroke{
			{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}}},
		}})
	}
	artist := ""
	for _, n := range names {
		if v := awaitPhase(t, chans[n], PhaseGuessing); v.YouAreArtist {
			artist = n
		}
	}
	for _, n := range names {
		if n != artist {
			r.Submit(Command{Kind: CmdSubmitGuess, Player: n, Guess: artist})
		}
	}

	rev := awaitPhase(t, chans["alice"], PhaseReveal)
	for _, p := range rev.Players {
		if p.Name == artist {
			continue // pot is 0 here; omitempty drops it, which is fine
		}
		if p.RoundScore == 0 {
			t.Fatalf("guesser %s has RoundScore 0 in the reveal view, want their earned points", p.Name)
		}
		if p.RoundScore != p.Score {
			t.Fatalf("%s RoundScore %d != Score %d (single round, should match)", p.Name, p.RoundScore, p.Score)
		}
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && go test ./internal/game/ -run TestRevealViewCarriesRoundScore -v`
Expected: FAIL — `RoundScore` is 0 because `viewFor` doesn't populate it yet.

- [ ] **Step 4: Populate `RoundScore` in `viewFor`**

In `state.go` `viewFor`, inside the `for i, p := range g.Players` loop, after the existing reveal `Correct` block, add:

```go
		if g.Phase == PhaseReveal {
			pub.RoundScore = g.LastDeltas[p.Name]
		}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && go test ./internal/game/ -run TestRevealViewCarriesRoundScore -v`
Expected: PASS.

- [ ] **Step 6: Run the full game suite and commit**

Run: `cd backend && go test ./internal/game/ -v`
Expected: PASS (all).

```bash
git add backend/internal/game/state.go backend/internal/game/room_test.go
git commit -m "feat: surface per-round score delta in the reveal view"
```

---

### Task 3: Show the round delta on the reveal screens

Render the "+N" earned this round in the scoreboard and on the player's personal
reveal card.

**Files:**
- Modify: `frontend/src/lib/protocol.ts` (`Player.roundScore`)
- Modify: `frontend/src/components/game/shared.tsx` (`Scoreboard`)
- Modify: `frontend/src/components/game/PlayerStage.tsx` (`PlayerReveal`)
- Test: `frontend/src/components/game/stages.test.tsx`

**Interfaces:**
- Consumes: `Player.roundScore` from the server reveal view (Task 2).

- [ ] **Step 1: Add `roundScore` to the `Player` type**

In `protocol.ts`, in the `Player` interface, after `correct?: boolean;` add:

```ts
  roundScore?: number;
```

- [ ] **Step 2: Write failing tests for the delta rendering**

In `stages.test.tsx`, add these two cases inside the `describe("stage split", …)` block:

```tsx
  it("scoreboard shows the round delta during reveal", () => {
    useGameStore.setState({
      phase: "reveal",
      players: [{ name: "ann", score: 167, roundScore: 67 }],
      reveal: { artist: "ann", prompt: "cat" },
    });
    const { getByText } = render(<HostStage name="tv" actions={noopActions} />);
    expect(getByText("+67")).toBeTruthy();
  });

  it("player reveal shows the points earned this round", () => {
    useGameStore.setState({
      phase: "reveal",
      players: [{ name: "ann", score: 92, roundScore: 92 }],
      reveal: { artist: "bob", prompt: "cat" },
      youAreArtist: false,
    });
    const { getByText } = render(<PlayerStage name="ann" actions={noopActions} />);
    expect(getByText("+92")).toBeTruthy();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/game/stages.test.tsx`
Expected: FAIL — "+67" and "+92" are not found in the rendered output.

- [ ] **Step 4: Render the delta in `Scoreboard`**

In `shared.tsx` `Scoreboard`, replace the score span:

```tsx
          <span className="font-mono text-sm font-bold text-foreground">
            {p.score ?? 0}
          </span>
```

with a version that prepends the round delta when present:

```tsx
          {p.roundScore != null && p.roundScore > 0 && (
            <span className="font-mono text-xs font-bold text-primary">
              +{p.roundScore}
            </span>
          )}
          <span className="font-mono text-sm font-bold text-foreground">
            {p.score ?? 0}
          </span>
```

- [ ] **Step 5: Render the delta on the player reveal card**

In `PlayerStage.tsx` `PlayerReveal`, replace the points line:

```tsx
            <p className="mt-1 font-mono text-2xl font-bold text-primary">
              {me?.score ?? 0} pts
            </p>
```

with:

```tsx
            <p className="mt-1 font-mono text-2xl font-bold text-primary">
              {me?.roundScore != null && me.roundScore > 0 && (
                <span className="mr-2">+{me.roundScore}</span>
              )}
              {me?.score ?? 0} pts
            </p>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/game/stages.test.tsx`
Expected: PASS — including the two new cases and the existing four.

- [ ] **Step 7: Typecheck, lint, and commit**

Run: `cd frontend && npm run typecheck && npm run lint`
Expected: no errors.

```bash
git add frontend/src/lib/protocol.ts frontend/src/components/game/shared.tsx frontend/src/components/game/PlayerStage.tsx frontend/src/components/game/stages.test.tsx
git commit -m "feat: show per-round score delta on the reveal screens"
```

---

## Self-Review

**Spec coverage:**
- Artist pot (`100 × (1 − correct/eligible)`, no floor, edge `eligible==0 → 100`) → Task 1 `artistPot` + `TestArtistPot` + `TestArtistPotWhenNoneIdentify`.
- Eligible = connected non-artists ∪ correct-but-disconnected → Task 1 `beginReveal` + `TestCorrectGuessCountsAfterDisconnect`.
- Guesser speed curve (`100 − 50f`, clamped, floor 50) → Task 1 `speedScore` + `TestSpeedScoreCurve`.
- Allow guess changes, score final timestamp → Task 1 Step 7 records timestamp on every submit (existing overwrite kept); no lock added.
- Wrong/absent guess scores 0, no penalty → Task 1 `beginReveal` only scores `guess == Featured`; `TestArtistPotWhenNoneIdentify` asserts wrong guessers get 0.
- `GuessTimes` / `LastDeltas` fields, reset each round and on teardown → Task 1 Steps 1, 9.
- `Player.RoundScore` surfaced at reveal only → Task 2.
- Equal `pointsMax`/`speedSpread` constants (100/50) → Task 1 Step 2 + Global Constraints.
- Frontend shows the round delta → Task 3.
- Out of scope (featuring flow, wrong-guess penalty, host-tunable points) → no tasks, as intended.

**Placeholder scan:** none — every code step shows the full code; every run step has an exact command and expected result.

**Type consistency:** `speedScore(int64) int`, `artistPot(int, int) int`, `GuessTimes map[string]int64`, `LastDeltas map[string]int`, `Player.RoundScore int` / `roundScore?: number` are used identically across Tasks 1–3. Constants `pointsMax` / `speedSpread` referenced consistently in code and tests.
