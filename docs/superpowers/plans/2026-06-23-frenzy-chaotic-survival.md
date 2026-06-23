# Frenzy v2 — Chaotic Survival — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape Frenzy from per-player random sabotage into a fair, escalating, room-wide "chaotic survival" mode — one shared effect per wave, severity tiered by phase progress, waves that tighten toward the buzzer.

**Architecture:** Pure backend change. A wave now rolls ONE effect (from a severity tier chosen by how far the phase has elapsed) and applies it to every affectable player at once. Wave cadence and effect duration are computed from phase progress instead of fixed constants. The existing affectable gate already exempts locked-in/already-guessed players — that exemption IS the "early-lock grace" reward, so no new code is added for it. Scoring and the entire frontend are untouched.

**Tech Stack:** Go 1.26 (`backend/internal/game`), standard `testing`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-23-frenzy-chaotic-survival-design.md`

## Global Constraints

- **Do NOT run `git commit` or `git push`.** Per project rule the user performs all commits. Each "Commit" step below is a checkpoint: stop, state the work is ready, and surface the suggested commit message for the user to run. Do not stage-and-commit automatically.
- **No frontend changes.** Effect kinds, `protocol.ts`, `EffectLayer`, and all React consumers stay exactly as they are. This work changes only *which* effect a wave delivers and *when*.
- **No scoring changes.** `scoring.go` and the reveal scoring in `rounds.go` are not touched.
- **Tier membership and cadence are tunable constants in one place** — tier boundaries `0.45` / `0.80`, cadence fractions in `room.go`. Keep them as named constants, never inline magic numbers at call sites.
- **Effects remain view-only / brief input lock** — never read, modify, or delete stroke data (inherited v1 safety rule). This refactor does not change effect application, so it preserves the rule by construction.
- Reuse existing helpers: `clampF(v, lo, hi float64) float64` (`internal/game/sanitize.go:25`), the `min`/`max` builtins, and the test helpers `syncRoom`, `draft`, `advance`, `frenzyGuessing`, `inPool` already in the package.

## File Structure

- **Modify** `backend/internal/game/powerups.go` — replace flat per-phase pools with severity tiers; add `tierForProgress` and `effectForWave`; rewrite `applyEffectWave` to apply one shared effect.
- **Modify** `backend/internal/game/room.go` — replace the three fixed cadence constants with fraction-based ones; add cadence helpers (`phaseDurationMs`, `phaseProgress`, `firstWaveDelay`, `waveGap`, `waveEffectDuration`); rewire the `CmdEffectWave` handler.
- **Modify** `backend/internal/game/rounds.go` — `startPhase` arms the first wave via `firstWaveDelay(durMs)`.
- **Modify** `backend/internal/game/powerups_test.go` — update existing wave tests to the new signature + "one shared effect" assertion; add tier/selection tests.
- **Create** `backend/internal/game/cadence_test.go` — unit tests for the pure cadence helpers.

Each task below leaves the tree compiling with all tests green.

---

### Task 1: Severity tiers + tier-aware selection

Replace the two flat effect pools with three severity tiers per phase, and add the pure functions that pick a tier by phase progress and an effect within it. `applyEffectWave` is left on its **old** signature in this task (it still calls `powerupsForPhase`, which now derives its union from the tiers) so the tree stays green; the cutover happens in Task 3.

**Files:**
- Modify: `backend/internal/game/powerups.go`
- Test: `backend/internal/game/powerups_test.go`

**Interfaces:**
- Consumes: `Powerup` constants and `Phase` (existing).
- Produces:
  - `type tier int` with `tierMild`, `tierMedium`, `tierHarsh` (iota 0,1,2)
  - `tiersForPhase(p Phase) ([3][]Powerup, bool)` — the phase's tier table, `ok=false` for non-play phases
  - `powerupsForPhase(p Phase) []Powerup` — unchanged signature, now the union of the phase's tiers (nil for non-play phases)
  - `tierForProgress(p float64) tier`
  - `effectForWave(phase Phase, progress float64) (Powerup, bool)` — one effect from the progress-selected tier; `ok=false` for non-play phases

- [ ] **Step 1: Write the failing tests**

Add to `backend/internal/game/powerups_test.go`:

```go
func TestTierForProgress(t *testing.T) {
	cases := []struct {
		p    float64
		want tier
	}{
		{-0.1, tierMild}, {0.0, tierMild}, {0.44, tierMild},
		{0.45, tierMedium}, {0.79, tierMedium},
		{0.80, tierHarsh}, {1.0, tierHarsh}, {1.5, tierHarsh},
	}
	for _, c := range cases {
		if got := tierForProgress(c.p); got != c.want {
			t.Errorf("tierForProgress(%v) = %d, want %d", c.p, got, c.want)
		}
	}
}

func TestEffectForWaveStaysInPhaseAndTier(t *testing.T) {
	// Early (mild) draw wave: only fog.
	if e, ok := effectForWave(PhaseDrawing, 0.0); !ok || e != PowerFog {
		t.Fatalf("early draw wave = (%q,%v), want (fog,true)", e, ok)
	}
	// Late (harsh) draw wave: lights or cramp.
	e, ok := effectForWave(PhaseDrawing, 0.9)
	if !ok || (e != PowerLights && e != PowerCramp) {
		t.Fatalf("late draw wave = (%q,%v), want a harsh draw effect", e, ok)
	}
	// Late (harsh) guess wave: curtain.
	if e, ok := effectForWave(PhaseGuessing, 0.9); !ok || e != PowerCurtain {
		t.Fatalf("late guess wave = (%q,%v), want (curtain,true)", e, ok)
	}
	// Non-play phase: no effect.
	if _, ok := effectForWave(PhaseReveal, 0.5); ok {
		t.Fatal("reveal has no tiers — effectForWave must report ok=false")
	}
}
```

Also update the two existing membership assertions to use `powerupsForPhase` (the flat pool vars are being deleted):
- `backend/internal/game/powerups_test.go:79` — change `inPool(effs[0].Kind, drawPowerups)` to `inPool(effs[0].Kind, powerupsForPhase(PhaseDrawing))`
- `backend/internal/game/powerups_test.go:104` — change `inPool(e.Kind, guessPowerups)` to `inPool(e.Kind, powerupsForPhase(PhaseGuessing))`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'TestTierForProgress|TestEffectForWave' -v`
Expected: compile failure — `undefined: tierForProgress`, `undefined: effectForWave`.

- [ ] **Step 3: Implement tiers + selection in `powerups.go`**

Replace the flat pool block (`powerups.go:27-44`, the `var ( drawPowerups ... )` through the end of `powerupsForPhase`) with:

```go
// tier is an effect's severity. Waves draw from harsher tiers as a phase elapses,
// so the room's sabotage escalates toward the buzzer.
type tier int

const (
	tierMild tier = iota
	tierMedium
	tierHarsh
)

// Per-phase severity tiers. Severity comes from which effect fires (and, via the
// cadence, how often) — each effect keeps its own single intensity, so the binary
// effects (flip/cramp/shuffle/hidenames) simply sit at the right tier.
var (
	drawTiers = [3][]Powerup{
		tierMild:   {PowerFog},
		tierMedium: {PowerFlip},
		tierHarsh:  {PowerLights, PowerCramp},
	}
	guessTiers = [3][]Powerup{
		tierMild:   {PowerSquint, PowerHideNames},
		tierMedium: {PowerShuffle},
		tierHarsh:  {PowerCurtain},
	}
)

// tiersForPhase returns the phase's severity table; ok is false for phases with no
// effects (reveal/lobby/ended).
func tiersForPhase(p Phase) ([3][]Powerup, bool) {
	switch p {
	case PhaseDrawing:
		return drawTiers, true
	case PhaseGuessing:
		return guessTiers, true
	default:
		return [3][]Powerup{}, false
	}
}

// powerupsForPhase is the full set of effects a phase can roll — the union of its
// tiers. Nil for non-play phases.
func powerupsForPhase(p Phase) []Powerup {
	tiers, ok := tiersForPhase(p)
	if !ok {
		return nil
	}
	var all []Powerup
	for _, t := range tiers {
		all = append(all, t...)
	}
	return all
}

// tierForProgress picks the severity tier for a wave firing at phase progress p
// (0 = phase start, 1 = buzzer). Mild early, harsh near the end.
func tierForProgress(p float64) tier {
	switch {
	case p < 0.45:
		return tierMild
	case p < 0.80:
		return tierMedium
	default:
		return tierHarsh
	}
}

// effectForWave rolls one effect for a wave: the tier is chosen by progress, then a
// random effect from that tier. ok is false for phases with no tiers.
func effectForWave(phase Phase, progress float64) (Powerup, bool) {
	tiers, ok := tiersForPhase(phase)
	if !ok {
		return "", false
	}
	pool := tiers[tierForProgress(progress)]
	if len(pool) == 0 {
		return "", false
	}
	return pool[rand.IntN(len(pool))], true
}
```

`applyEffectWave` (still below this, unchanged) keeps calling `powerupsForPhase(phase)` and compiles against the new union.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/game/ -run 'TestTierForProgress|TestEffectForWave|TestPowerupsForPhaseSplit|TestWave' -v`
Expected: PASS. `TestPowerupsForPhaseSplit` (disjoint union) and all existing `TestWave*` still pass — `applyEffectWave` is unchanged and the union has the same members as before.

- [ ] **Step 5: Commit (checkpoint — user runs it)**

Stop and report the work is ready. Suggested message:

```
refactor(frenzy): split effects into severity tiers

Tier the draw/guess effect pools (mild/medium/harsh) and add
tierForProgress + effectForWave. powerupsForPhase now derives its
union from the tiers. applyEffectWave wiring unchanged for now.
```

---

### Task 2: Fraction-based cadence helpers

Add the constants and pure functions that compute when the next wave fires and how long its effect lasts, derived from phase progress. Added alongside the old constants (not yet wired), so the tree stays green; the old constants are removed in Task 3.

**Files:**
- Modify: `backend/internal/game/room.go`
- Test: `backend/internal/game/cadence_test.go` (create)

**Interfaces:**
- Consumes: `clampF` (`sanitize.go`), `time.Duration`.
- Produces:
  - Constants `firstWaveFrac=0.12`, `gapStartFrac=0.28`, `gapEndFrac=0.10`, `durationOfGap=0.9`, `minWaveGap=4*time.Second`, `minEffectMs=2500`
  - `firstWaveDelay(durMs int) time.Duration`
  - `waveGap(progress float64, durMs int) time.Duration`
  - `waveEffectDuration(gap time.Duration) time.Duration`
  - `(*Room).phaseDurationMs() int`
  - `(*Room).phaseProgress() float64`

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/game/cadence_test.go`:

```go
package game

import (
	"testing"
	"time"
)

func TestFirstWaveDelayFloored(t *testing.T) {
	// 0.12 * 80000ms = 9.6s, above the floor.
	if got := firstWaveDelay(80_000); got != 9600*time.Millisecond {
		t.Errorf("firstWaveDelay(80000) = %v, want 9.6s", got)
	}
	// 0.12 * 10000ms = 1.2s, below the 4s floor.
	if got := firstWaveDelay(10_000); got != minWaveGap {
		t.Errorf("firstWaveDelay(10000) = %v, want floor %v", got, minWaveGap)
	}
}

func TestWaveGapTightensWithProgress(t *testing.T) {
	early := waveGap(0.0, 80_000) // 0.28 * 80s = 22.4s
	late := waveGap(1.0, 80_000)  // 0.10 * 80s = 8s
	if !(early > late) {
		t.Fatalf("gap must tighten: early=%v late=%v", early, late)
	}
	if early != 22400*time.Millisecond {
		t.Errorf("waveGap(0,80000) = %v, want 22.4s", early)
	}
	if late != 8*time.Second {
		t.Errorf("waveGap(1,80000) = %v, want 8s", late)
	}
}

func TestWaveGapFloored(t *testing.T) {
	// 0.10 * 20000ms = 2s, below the 4s floor.
	if got := waveGap(1.0, 20_000); got != minWaveGap {
		t.Errorf("waveGap(1,20000) = %v, want floor %v", got, minWaveGap)
	}
}

func TestWaveEffectDurationFloored(t *testing.T) {
	// 0.9 * 8s = 7.2s, above the floor.
	if got := waveEffectDuration(8 * time.Second); got != 7200*time.Millisecond {
		t.Errorf("waveEffectDuration(8s) = %v, want 7.2s", got)
	}
	// 0.9 * 2s = 1.8s, below the 2.5s floor.
	if got := waveEffectDuration(2 * time.Second); got != minEffectMs*time.Millisecond {
		t.Errorf("waveEffectDuration(2s) = %v, want floor", got)
	}
}

func TestPhaseProgress(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	r.state.Phase = PhaseDrawing
	r.state.DrawMs = 80_000
	// Half the phase remains → progress ~0.5.
	r.state.PhaseEndsAt = time.Now().Add(40 * time.Second).UnixMilli()
	if p := r.phaseProgress(); p < 0.45 || p > 0.55 {
		t.Fatalf("phaseProgress = %v, want ~0.5", p)
	}
	// Outside a timed play phase → 0.
	r.state.Phase = PhaseReveal
	if p := r.phaseProgress(); p != 0 {
		t.Fatalf("phaseProgress(reveal) = %v, want 0", p)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'TestFirstWaveDelay|TestWaveGap|TestWaveEffectDuration|TestPhaseProgress' -v`
Expected: compile failure — `undefined: firstWaveDelay`, etc.

- [ ] **Step 3: Add the constants and helpers in `room.go`**

In the `const` block, immediately after the existing frenzy cadence constants (`room.go:57-64`, the `firstEffectDelay`/`effectInterval`/`effectDurationMs` lines — leave those in place for now), add:

```go
	// Frenzy v2 escalating cadence (fractions of the phase, floored for short
	// phases). The first wave lands firstWaveFrac in; the gap to each next wave
	// tightens from gapStartFrac toward gapEndFrac as the buzzer nears; each effect
	// lasts durationOfGap of the current gap, so late waves run near-continuous.
	firstWaveFrac = 0.12
	gapStartFrac  = 0.28
	gapEndFrac    = 0.10
	durationOfGap = 0.9
	minWaveGap    = 4 * time.Second
	minEffectMs   = 2500 // ms; floor on a wave effect's lifetime
```

Then add the helpers near `armWave` (after `room.go:330`):

```go
// phaseDurationMs is the configured length of the current timed play phase, or 0
// outside drawing/guessing.
func (r *Room) phaseDurationMs() int {
	switch r.state.Phase {
	case PhaseDrawing:
		return r.state.DrawMs
	case PhaseGuessing:
		return r.state.GuessMs
	default:
		return 0
	}
}

// phaseProgress is how far (0..1) the current timed play phase has elapsed, from
// PhaseEndsAt and the phase's configured duration. 0 outside drawing/guessing.
func (r *Room) phaseProgress() float64 {
	dur := r.phaseDurationMs()
	if dur <= 0 {
		return 0
	}
	remaining := r.state.PhaseEndsAt - time.Now().UnixMilli()
	return clampF(1-float64(remaining)/float64(dur), 0, 1)
}

// firstWaveDelay is when a phase's first wave lands: firstWaveFrac of the phase,
// floored at minWaveGap.
func firstWaveDelay(durMs int) time.Duration {
	d := time.Duration(firstWaveFrac*float64(durMs)) * time.Millisecond
	if d < minWaveGap {
		d = minWaveGap
	}
	return d
}

// waveGap is the delay to the next wave at phase progress p: it tightens from
// gapStartFrac to gapEndFrac of the phase as p→1, floored at minWaveGap.
func waveGap(progress float64, durMs int) time.Duration {
	frac := gapStartFrac + (gapEndFrac-gapStartFrac)*clampF(progress, 0, 1)
	gap := time.Duration(frac*float64(durMs)) * time.Millisecond
	if gap < minWaveGap {
		gap = minWaveGap
	}
	return gap
}

// waveEffectDuration is how long a wave's effect lasts — durationOfGap of the
// current gap so late waves run near-continuous — floored at minEffectMs.
func waveEffectDuration(gap time.Duration) time.Duration {
	d := time.Duration(float64(gap) * durationOfGap)
	if d < minEffectMs*time.Millisecond {
		d = minEffectMs * time.Millisecond
	}
	return d
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/game/ -run 'TestFirstWaveDelay|TestWaveGap|TestWaveEffectDuration|TestPhaseProgress' -v`
Expected: PASS.

- [ ] **Step 5: Commit (checkpoint — user runs it)**

Suggested message:

```
feat(frenzy): add fraction-based wave cadence helpers

Add escalating cadence constants and pure helpers (firstWaveDelay,
waveGap, waveEffectDuration, phaseProgress). Not yet wired.
```

---

### Task 3: Cut over to shared, escalating waves

The atomic switch: `applyEffectWave` now rolls ONE tier-selected effect and applies it to every affectable player; the `CmdEffectWave` handler computes progress/gap/duration; `startPhase` arms the first wave with `firstWaveDelay`; the three old fixed constants are removed. Existing wave tests are updated to the new signature and the "one shared effect" property.

**Files:**
- Modify: `backend/internal/game/powerups.go`
- Modify: `backend/internal/game/room.go`
- Modify: `backend/internal/game/rounds.go`
- Test: `backend/internal/game/powerups_test.go`

**Interfaces:**
- Consumes: `effectForWave`, `affectable` (existing), `phaseProgress`, `phaseDurationMs`, `waveGap`, `waveEffectDuration`, `firstWaveDelay`.
- Produces: `(*Room).applyEffectWave(phase Phase, progress float64, dur time.Duration)` — new signature; applies one shared effect.

- [ ] **Step 1: Update the existing wave tests to the new signature + shared-effect assertion**

In `backend/internal/game/powerups_test.go`:

Replace `TestWaveHitsEveryActivePlayerAtOnce` (lines 61-91) with:

```go
func TestWaveAppliesOneSharedEffectToEveryActivePlayer(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := syncRoom(t, names...)
	r.state.Mode = ModeFrenzy
	r.state.Phase = PhaseDrawing

	before := time.Now().UnixMilli()
	dur := 6 * time.Second
	// Harsh progress (0.9) draws from a 2-effect tier, so a shared single roll is
	// observable: every player must get the SAME kind, not an independent roll.
	r.applyEffectWave(PhaseDrawing, 0.9, dur)

	if len(r.state.Effects) != len(names) {
		t.Fatalf("wave hit %d players, want all %d", len(r.state.Effects), len(names))
	}
	var kind Powerup
	var endsAt int64
	for _, n := range names {
		effs := r.state.Effects[n]
		if len(effs) != 1 {
			t.Fatalf("%s has %d effects, want exactly one per wave", n, len(effs))
		}
		if !inPool(effs[0].Kind, powerupsForPhase(PhaseDrawing)) {
			t.Fatalf("%s got %q, not a draw-phase effect", n, effs[0].Kind)
		}
		if effs[0].EndsAt < before+dur.Milliseconds() {
			t.Fatalf("%s effect expires too soon: %d", n, effs[0].EndsAt)
		}
		if kind == "" {
			kind, endsAt = effs[0].Kind, effs[0].EndsAt
			continue
		}
		if effs[0].Kind != kind {
			t.Fatal("a wave is one shared effect — every player must get the same kind")
		}
		if effs[0].EndsAt != endsAt {
			t.Fatal("a wave must stamp every player with the same expiry — they're hit at once")
		}
	}
}
```

Update the remaining wave-test call sites to the new signature (add `progress, dur` args):
- `TestWaveRollsPhaseAppropriateEffects` — `r.applyEffectWave(PhaseGuessing, 0.0, 6*time.Second)`
- `TestWaveSkipsLockedDrawers` — `r.applyEffectWave(PhaseDrawing, 0.0, 6*time.Second)`
- `TestWaveSkipsFeaturedAndGuessed` — `r.applyEffectWave(PhaseGuessing, 0.0, 6*time.Second)`
- `TestWaveReplacesPriorEffects` — both calls become `r.applyEffectWave(PhaseDrawing, 0.0, 6*time.Second)`
- `TestWaveNoOpOutsidePlayPhases` — `r.applyEffectWave(PhaseReveal, 0.5, 6*time.Second)`

Add an escalation test:

```go
func TestWaveEscalatesWithProgress(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}

	early := syncRoom(t, names...)
	early.state.Mode = ModeFrenzy
	early.state.Phase = PhaseDrawing
	early.applyEffectWave(PhaseDrawing, 0.0, 6*time.Second) // mild tier → fog
	for n, effs := range early.state.Effects {
		if effs[0].Kind != PowerFog {
			t.Fatalf("%s early wave = %q, want mild fog", n, effs[0].Kind)
		}
	}

	late := syncRoom(t, names...)
	late.state.Mode = ModeFrenzy
	late.state.Phase = PhaseDrawing
	late.applyEffectWave(PhaseDrawing, 0.9, 6*time.Second) // harsh tier → lights/cramp
	for n, effs := range late.state.Effects {
		if effs[0].Kind != PowerLights && effs[0].Kind != PowerCramp {
			t.Fatalf("%s late wave = %q, want a harsh effect", n, effs[0].Kind)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'TestWave' -v`
Expected: compile failure — `too many arguments in call to r.applyEffectWave` (signature not yet changed).

- [ ] **Step 3: Rewrite `applyEffectWave` in `powerups.go`**

Replace `applyEffectWave` (`powerups.go:46-76`) with:

```go
// applyEffectWave inflicts ONE shared, tier-selected effect on every connected,
// affectable player at once — the whole room eats the same handicap on the same
// beat. The effect's severity comes from progress (mild early, harsh near the
// buzzer); it lasts dur and replaces any prior effects. A no-op when the phase has
// no tiers or no one is affectable.
func (r *Room) applyEffectWave(phase Phase, progress float64, dur time.Duration) {
	kind, ok := effectForWave(phase, progress)
	if !ok {
		return
	}
	endsAt := time.Now().Add(dur).UnixMilli()
	next := map[string][]ActiveEffect{}
	for _, p := range r.state.Players {
		pr, ok := r.present[p.Name]
		if !ok || !pr.connected {
			continue
		}
		// affectable already exempts locked-in drawers / the featured artist /
		// already-guessed players — this exemption IS the early-lock grace: commit
		// early and the escalating waves never reach you.
		if !r.affectable(p.Name) {
			continue
		}
		next[p.Name] = []ActiveEffect{{Kind: kind, EndsAt: endsAt}}
	}
	if len(next) == 0 {
		return
	}
	r.state.Effects = next
}
```

Also fix the stale doc reference at `powerups.go:10` (the `Powerup` type comment): change "self-expires after effectDurationMs" to "self-expires when its wave-stamped EndsAt passes".

- [ ] **Step 4: Rewire the `CmdEffectWave` handler in `room.go`**

Replace the `CmdEffectWave` case (`room.go:396-400`) with:

```go
	case CmdEffectWave:
		if c.Gen == r.phaseGen {
			progress := r.phaseProgress()
			gap := waveGap(progress, r.phaseDurationMs())
			r.applyEffectWave(r.state.Phase, progress, waveEffectDuration(gap))
			r.armWave(r.phaseGen, gap)
		}
```

Then delete the three old constants (`room.go:62-64`): `firstEffectDelay`, `effectInterval`, `effectDurationMs`, and update the comment above them (`room.go:57-61`) to describe v2 — or simply remove that comment block since the v2 cadence constants added in Task 2 carry their own comment.

- [ ] **Step 5: Update `startPhase` in `rounds.go`**

Replace `r.armWave(r.phaseGen, firstEffectDelay)` (`rounds.go:393`) with:

```go
		r.armWave(r.phaseGen, firstWaveDelay(durMs))
```

(`durMs` is the `startPhase` parameter already in scope.)

- [ ] **Step 6: Run the full package test suite**

Run: `cd backend && go test ./internal/game/ -v`
Expected: PASS — all wave tests (shared-effect, escalation, skip-locked, skip-featured, replace, no-op, gen-gated), redaction, cleanup, and the rest of the package.

- [ ] **Step 7: Build + vet the whole backend**

Run: `cd backend && go build ./... && go vet ./...`
Expected: no output (clean). Confirms no dangling references to the removed constants anywhere.

- [ ] **Step 8: Commit (checkpoint — user runs it)**

Suggested message:

```
feat(frenzy): shared, escalating effect waves

A wave now applies one tier-selected effect to the whole affectable
room (was: a random effect per player), with severity and cadence
ramping toward the buzzer. Early-lock grace falls out of the existing
affectable gate. Removes the fixed cadence constants. Scoring and
frontend unchanged.
```

---

## Self-Review

**Spec coverage** (against `2026-06-23-frenzy-chaotic-survival-design.md`):
- Shared single effect per wave → Task 3 `applyEffectWave` rewrite + `TestWaveAppliesOneSharedEffectToEveryActivePlayer`. ✓
- Severity tiers (mild/medium/harsh; 0.45/0.80 cuts; documented membership) → Task 1 `drawTiers`/`guessTiers`/`tierForProgress` + `TestTierForProgress`/`TestEffectForWaveStaysInPhaseAndTier`. ✓
- Tightening cadence + duration tracking the gap, fraction-based with floors → Task 2 helpers + `cadence_test.go`. ✓
- First wave at `firstWaveFrac` → Task 3 Step 5 `startPhase`. ✓
- Early-lock grace = existing affectable gate, no new code → Task 3 comment + `TestWaveSkipsLockedDrawers`/`TestWaveSkipsFeaturedAndGuessed` retained. ✓
- Escalation end-to-end → `TestWaveEscalatesWithProgress`. ✓
- Scoring untouched → no task touches `scoring.go`/reveal scoring (Global Constraint). ✓
- Frontend untouched → no frontend task (Global Constraint). ✓
- `Powerup`→`Effect` rename → explicitly deferred in spec, no task. ✓
- Named constants in one place → Task 1/2 keep all tunables as package constants. ✓

**Placeholder scan:** No TBD/TODO; every step carries full code or an exact edit + the file:line it targets. ✓

**Type consistency:** `applyEffectWave(phase Phase, progress float64, dur time.Duration)` is defined in Task 3 and every updated call site in Task 3 Step 1 matches it. `tier`, `tierForProgress`, `effectForWave`, `tiersForPhase`, `powerupsForPhase` names are consistent across Tasks 1 and 3. Cadence helper names (`firstWaveDelay`, `waveGap`, `waveEffectDuration`, `phaseProgress`, `phaseDurationMs`) are defined in Task 2 and used unchanged in Task 3. ✓

## Notes for the executor

- Tasks 1 and 2 are independent (different functions, different files mostly) and could be done in either order; Task 3 depends on both.
- Each task's final `go test ./internal/game/` must be green before the checkpoint. If a pre-existing test outside the wave/cadence set breaks, stop — it means a wider assumption changed; investigate before continuing.
- Remember the Global Constraint: do not run `git commit`/`git push`. Surface the message and let the user commit.
