# Frenzy Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Frenzy" game mode where, during drawing and guessing, players are periodically handed random powerups and fire them (one tap) at a random rival to inflict short, harmless, view-only effects.

**Architecture:** A new real-time powerup layer on the unchanged draw → guess → reveal loop. Powerups never touch stroke data — they only set short, self-expiring effects on the victim's own client (overlays / view transforms / brief input lock). The server runs a per-phase drop ticker (mirroring the existing advance-timer/generation pattern), holds redacted per-player inventory and per-victim effects, validates fires, and relays. Classic and Flipped never arm the ticker or populate any powerup state.

**Tech Stack:** Go backend (`internal/game`, `internal/realtime`), React + TypeScript + Zustand + Vite, Socket.IO, Vitest + Testing Library, Biome.

## Dependency

This plan builds on the **game-mode foundation** introduced by the Whose Doodle plan (`docs/superpowers/plans/2026-06-22-whose-doodle-flipped-mode.md`, Tasks 1–2): `Mode` type, `Config.Mode`, public `GameState.Mode`, `sanitizeMode`, the lobby `Segmented` mode selector, the frontend `GameMode` type, and the store `mode` field. **If that foundation is not merged, complete those two tasks first.** This plan extends `sanitizeMode` and the selector to add `frenzy`; it assumes the rest exists.

## Global Constraints

- **Classic and Flipped must stay unchanged.** Frenzy only adds branches gated on `r.state.Mode == ModeFrenzy`. Every existing test stays green.
- **The safety rule:** powerups never read, modify, inject, or delete stroke data. Effects are view-only/input-lock, time-boxed, and self-expire via an absolute `endsAt`.
- **No leaks:** a client only ever sees its own inventory and its own active effects — never another player's.
- **Effects are phase-scoped; inventory persists.** Effects clear on every `startPhase`. Inventory survives across features/rounds within a game and is wiped only at game end / return-to-lobby / on a player's departure.
- **Git:** the user runs all commits/pushes. Each "Commit" step means *stage the listed files and hand off* with the suggested message — do not run `git commit`/`git push`.
- **Verification:** backend `cd backend && go test ./...`; frontend `cd frontend && npm run test && npm run typecheck`. Biome lint has pre-existing unrelated errors in `CodeCard.tsx`; assert only touched files with `npx biome check <files>`.
- Tunable constants (playtest later): `dropInterval = 8s`, `inventoryCap = 3`, per-powerup effect durations 2000–3000 ms.
- Backend uses Go `min`/`max` builtins and `math/rand/v2` (already imported in `rounds.go`).

---

## File Structure

**Backend:**
- Create: `backend/internal/game/powerups.go` — powerup catalog, drop/fire logic, helpers.
- Create: `backend/internal/game/powerups_test.go` — powerup unit + behavior tests.
- Modify: `backend/internal/game/state.go` — `ModeFrenzy`, `sanitizeMode`, `ActiveEffect`, `Inventory`/`Effects`, view fields + redaction, `activeEffects`.
- Modify: `backend/internal/game/room.go` — `CmdFirePowerup`/`CmdDropPowerup`, `Command.PowerupID`, constants, `armDrop`, dispatch.
- Modify: `backend/internal/game/rounds.go` — `startPhase` arms the ticker + clears effects; `endGame`/`returnToLobby` wipe powerup state.
- Modify: `backend/internal/game/members.go` — `clearRoundData` clears departed inventory/effects.
- Modify: `backend/internal/realtime/socket.go` — `firePowerup` event.

**Frontend:**
- Modify: `frontend/src/lib/protocol.ts` — `Powerup`, `ActiveEffect`, view fields.
- Modify: `frontend/src/lib/store.ts` — `yourPowerups`/`yourEffects`.
- Modify: `frontend/src/hooks/use-game-socket.ts` — `firePowerup` action.
- Create: `frontend/src/hooks/use-effects.ts` — `useActiveEffects()`.
- Create: `frontend/src/components/game/display/EffectLayer.tsx` — overlay/transform wrapper.
- Create: `frontend/src/components/game/display/PowerupTray.tsx` — fire UI + drop/hit toasts.
- Modify: `frontend/src/components/game/stages/HostConfig.tsx` — add the Frenzy option.
- Modify: `frontend/src/components/game/canvas/DrawingCanvas.tsx` — apply draw-phase effects.
- Modify: `frontend/src/components/game/stages/PlayerStage.tsx` — mount tray; apply guess-phase effects.
- Modify: `frontend/src/components/game/display/FlippedGuessing.tsx` — apply guess-phase effects.

---

## Task 1: Powerup catalog + state + view redaction

**Files:**
- Create: `backend/internal/game/powerups.go`
- Modify: `backend/internal/game/state.go`
- Test: `backend/internal/game/powerups_test.go`

**Interfaces:**
- Consumes: `Mode`/`ModeClassic`/`sanitizeMode` (foundation), `Phase`.
- Produces: `Powerup string` + the 7 consts; `powerupCatalog map[Powerup]powerupSpec`; `powerupsForPhase(Phase) []Powerup`; `ModeFrenzy Mode`; `ActiveEffect{Kind Powerup, EndsAt int64, From string}`; `GameState.Inventory map[string][]Powerup`, `GameState.Effects map[string][]ActiveEffect`; view fields `YourPowerups []Powerup`, `YourEffects []ActiveEffect`; `activeEffects([]ActiveEffect, int64) []ActiveEffect`.

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/game/powerups_test.go`:

```go
package game

import (
	"testing"
	"time"
)

func TestPowerupsForPhaseSplit(t *testing.T) {
	draw := powerupsForPhase(PhaseDrawing)
	guess := powerupsForPhase(PhaseGuessing)
	if len(draw) == 0 || len(guess) == 0 {
		t.Fatalf("empty pools: draw=%d guess=%d", len(draw), len(guess))
	}
	for _, p := range draw {
		if powerupCatalog[p].phase != PhaseDrawing {
			t.Fatalf("%q is in the draw pool but its spec phase is %q", p, powerupCatalog[p].phase)
		}
		if powerupCatalog[p].durMs <= 0 {
			t.Fatalf("%q has non-positive duration", p)
		}
	}
	for _, p := range guess {
		if powerupCatalog[p].phase != PhaseGuessing {
			t.Fatalf("%q is in the guess pool but its spec phase is %q", p, powerupCatalog[p].phase)
		}
	}
}

func TestActiveEffectsPrunesExpired(t *testing.T) {
	now := int64(1000)
	in := []ActiveEffect{
		{Kind: PowerFog, EndsAt: 500, From: "a"},  // expired
		{Kind: PowerSquint, EndsAt: 1500, From: "b"}, // live
	}
	out := activeEffects(in, now)
	if len(out) != 1 || out[0].Kind != PowerSquint {
		t.Fatalf("activeEffects = %+v, want only the live squint", out)
	}
}

func TestViewRedactsPowerups(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	r.state.Mode = ModeFrenzy
	future := time.Now().Add(time.Minute).UnixMilli()
	r.state.Inventory = map[string][]Powerup{
		"alice": {PowerFog},
		"bob":   {PowerSquint, PowerCramp},
	}
	r.state.Effects = map[string][]ActiveEffect{
		"alice": {{Kind: PowerLights, EndsAt: future, From: "bob"}},
		"bob":   {{Kind: PowerFog, EndsAt: 1, From: "alice"}}, // expired
	}

	av := r.state.viewFor("alice", r.present)
	if len(av.YourPowerups) != 1 || av.YourPowerups[0] != PowerFog {
		t.Fatalf("alice powerups = %+v, want [fog]", av.YourPowerups)
	}
	if len(av.YourEffects) != 1 || av.YourEffects[0].Kind != PowerLights {
		t.Fatalf("alice effects = %+v, want [lights]", av.YourEffects)
	}

	bv := r.state.viewFor("bob", r.present)
	if len(bv.YourPowerups) != 2 {
		t.Fatalf("bob powerups = %+v, want two", bv.YourPowerups)
	}
	if len(bv.YourEffects) != 0 {
		t.Fatalf("bob effects = %+v, want none (expired pruned)", bv.YourEffects)
	}
	// No cross-leak: alice's view never carries bob's inventory.
	if av.Inventory != nil || av.Effects != nil {
		t.Fatal("authoritative Inventory/Effects must not appear in a client view")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'TestPowerupsForPhaseSplit|TestActiveEffectsPrunesExpired|TestViewRedactsPowerups' -v`
Expected: FAIL to compile — `Powerup`, `powerupCatalog`, `ModeFrenzy`, etc. undefined.

- [ ] **Step 3: Create the catalog file**

Create `backend/internal/game/powerups.go`:

```go
package game

// Powerup is a Frenzy sabotage item. Each belongs to a phase and only fires
// during that phase. Every effect is view-only or a brief input lock — it never
// touches stroke data — and self-expires after its duration.
type Powerup string

const (
	// Draw-phase powerups (sabotage while the victim draws).
	PowerFog    Powerup = "fog"    // cloud the victim's canvas view
	PowerLights Powerup = "lights" // dim the canvas to near-black
	PowerFlip   Powerup = "flip"   // rotate the canvas view 180°
	PowerCramp  Powerup = "cramp"  // block drawing input briefly

	// Guess-phase powerups (disrupt the victim's guessing).
	PowerSquint  Powerup = "squint"  // blur the drawing(s) on show
	PowerCurtain Powerup = "curtain" // hide the drawing behind a curtain
	PowerShuffle Powerup = "shuffle" // jumble the guess options' order
)

// powerupSpec is a powerup's phase and effect duration (ms).
type powerupSpec struct {
	phase Phase
	durMs int64
}

var powerupCatalog = map[Powerup]powerupSpec{
	PowerFog:     {PhaseDrawing, 3000},
	PowerLights:  {PhaseDrawing, 2500},
	PowerFlip:    {PhaseDrawing, 3000},
	PowerCramp:   {PhaseDrawing, 2000},
	PowerSquint:  {PhaseGuessing, 3000},
	PowerCurtain: {PhaseGuessing, 2000},
	PowerShuffle: {PhaseGuessing, 2000},
}

// Explicit per-phase pools (deterministic order, unlike map iteration) used by
// the drop ticker to pick what to hand out.
var (
	drawPowerups  = []Powerup{PowerFog, PowerLights, PowerFlip, PowerCramp}
	guessPowerups = []Powerup{PowerSquint, PowerCurtain, PowerShuffle}
)

// powerupsForPhase lists the powerups droppable/fireable in a phase.
func powerupsForPhase(p Phase) []Powerup {
	switch p {
	case PhaseDrawing:
		return drawPowerups
	case PhaseGuessing:
		return guessPowerups
	default:
		return nil
	}
}

// activeEffects returns the still-live effects (EndsAt strictly after now).
func activeEffects(effects []ActiveEffect, now int64) []ActiveEffect {
	var live []ActiveEffect
	for _, e := range effects {
		if e.EndsAt > now {
			live = append(live, e)
		}
	}
	return live
}
```

- [ ] **Step 4: Add ModeFrenzy and extend sanitizeMode**

In `backend/internal/game/state.go`, add `ModeFrenzy` to the mode consts:

```go
	ModeFrenzy  Mode = "frenzy"  // powerup free-for-all over the classic loop
```

Replace `sanitizeMode` with:

```go
// sanitizeMode coerces an untrusted mode to a known value, defaulting to classic.
func sanitizeMode(m Mode) Mode {
	switch m {
	case ModeFlipped:
		return ModeFlipped
	case ModeFrenzy:
		return ModeFrenzy
	default:
		return ModeClassic
	}
}
```

- [ ] **Step 5: Add the state + view fields**

In `backend/internal/game/state.go`:

Add the `ActiveEffect` type near `Reveal` (around line 70):

```go
// ActiveEffect is a Frenzy effect currently inflicted on a victim: which
// powerup, when it expires (unix ms, absolute), and who fired it (for the
// victim's toast). Stored per-victim, redacted to that victim only.
type ActiveEffect struct {
	Kind   Powerup `json:"kind"`
	EndsAt int64   `json:"endsAt"`
	From   string  `json:"from"`
}
```

In the authoritative round-data block of `GameState` (near `Drawings`), add:

```go
	Inventory map[string][]Powerup      `json:"inventory,omitempty"` // frenzy: player → held powerups; server-only
	Effects   map[string][]ActiveEffect `json:"effects,omitempty"`   // frenzy: victim → active effects; server-only
```

In the view-only block of `GameState` (near `Reveal`), add:

```go
	YourPowerups []Powerup      `json:"yourPowerups,omitempty"` // frenzy: this recipient's held powerups
	YourEffects  []ActiveEffect `json:"yourEffects,omitempty"`  // frenzy: this recipient's active effects
```

- [ ] **Step 6: Redact into the view**

In `backend/internal/game/state.go`, add `"time"` to the imports (the file currently has no import block — add one):

```go
import "time"
```

In `viewFor`, just before `return v`, add:

```go
	if g.Mode == ModeFrenzy {
		now := time.Now().UnixMilli()
		if held := g.Inventory[name]; len(held) > 0 {
			v.YourPowerups = append([]Powerup(nil), held...)
		}
		if live := activeEffects(g.Effects[name], now); len(live) > 0 {
			v.YourEffects = live
		}
	}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/game/ -run 'TestPowerupsForPhaseSplit|TestActiveEffectsPrunesExpired|TestViewRedactsPowerups' -v`
Expected: PASS

- [ ] **Step 8: Full suite + vet/fmt**

Run: `cd backend && go test ./internal/game/ && go vet ./internal/game/ && gofmt -l internal/game/powerups.go internal/game/state.go`
Expected: ok; vet clean; `gofmt -l` prints nothing.

- [ ] **Step 9: Commit**

Stage `backend/internal/game/powerups.go`, `backend/internal/game/powerups_test.go`, `backend/internal/game/state.go`. Suggested message: `feat(game): frenzy powerup catalog, state, and redacted views`. Hand off to the user to commit.

---

## Task 2: Drop ticker

**Files:**
- Modify: `backend/internal/game/powerups.go` (`grantDrops`)
- Modify: `backend/internal/game/room.go` (`CmdDropPowerup`, `armDrop`, constants, dispatch)
- Modify: `backend/internal/game/rounds.go` (`startPhase` arms ticker + clears effects)
- Test: `backend/internal/game/powerups_test.go`

**Interfaces:**
- Consumes: `powerupsForPhase`, `r.present`, `r.phaseGen`, `inventoryCap`.
- Produces: `grantDrops(phase Phase)`; `CmdDropPowerup CmdKind`; `armDrop(gen int, d time.Duration)`; constants `dropInterval`, `inventoryCap`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/internal/game/powerups_test.go`:

```go
func TestGrantDropsRespectsCapAndConnection(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	r.state.Mode = ModeFrenzy

	// Grant repeatedly; nobody exceeds the cap.
	for i := 0; i < inventoryCap+3; i++ {
		r.grantDrops(PhaseDrawing)
	}
	for name, held := range r.state.Inventory {
		if len(held) > inventoryCap {
			t.Fatalf("%s holds %d powerups, over cap %d", name, len(held), inventoryCap)
		}
		for _, p := range held {
			if powerupCatalog[p].phase != PhaseDrawing {
				t.Fatalf("%s holds %q, not a draw-phase powerup", name, p)
			}
		}
	}
	if len(r.state.Inventory["alice"]) != inventoryCap {
		t.Fatalf("alice holds %d, want the cap %d after many drops", len(r.state.Inventory["alice"]), inventoryCap)
	}
}

func TestDropCommandGenGated(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	r.state.Mode = ModeFrenzy
	r.state.Phase = PhaseDrawing

	// A stale generation does nothing.
	r.handle(Command{Kind: CmdDropPowerup, Gen: r.phaseGen - 1})
	if len(r.state.Inventory) != 0 {
		t.Fatal("a stale-gen drop tick must not grant powerups")
	}
	// The current generation grants a round of drops.
	r.handle(Command{Kind: CmdDropPowerup, Gen: r.phaseGen})
	if len(r.state.Inventory) == 0 {
		t.Fatal("a current-gen drop tick should grant powerups")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'TestGrantDropsRespectsCapAndConnection|TestDropCommandGenGated' -v`
Expected: FAIL to compile — `grantDrops`, `inventoryCap`, `CmdDropPowerup` undefined.

- [ ] **Step 3: Add grantDrops**

In `backend/internal/game/powerups.go`, add:

```go
import "math/rand/v2"
```

at the top (the file has no imports yet), then add:

```go
// grantDrops gives every connected player one random powerup eligible for the
// current phase, up to inventoryCap. Players already at the cap are skipped.
func (r *Room) grantDrops(phase Phase) {
	pool := powerupsForPhase(phase)
	if len(pool) == 0 {
		return
	}
	if r.state.Inventory == nil {
		r.state.Inventory = map[string][]Powerup{}
	}
	for _, p := range r.state.Players {
		pr, ok := r.present[p.Name]
		if !ok || !pr.connected {
			continue
		}
		if len(r.state.Inventory[p.Name]) >= inventoryCap {
			continue
		}
		r.state.Inventory[p.Name] = append(r.state.Inventory[p.Name], pool[rand.IntN(len(pool))])
	}
}
```

- [ ] **Step 4: Add constants, command kind, armDrop, and dispatch**

In `backend/internal/game/room.go`:

Add to the `CmdKind` consts (after `CmdHostPrune`):

```go
	CmdFirePowerup // player: fire a held powerup at a random rival (frenzy)
	CmdDropPowerup // internal: periodic powerup drop tick (frenzy)
```

Add to the constants block (near `maxFeatures`):

```go
	// dropInterval is how often Frenzy hands every player a fresh powerup while
	// drawing or guessing. inventoryCap bounds a player's held powerups.
	dropInterval = 8 * time.Second
	inventoryCap = 3
```

Add `PowerupID` to the `Command` struct's game-payload block:

```go
	PowerupID string // firePowerup: the powerup kind being fired
```

Add the timer arm (next to `armAdvance`):

```go
// armDrop schedules the next Frenzy drop tick. The captured generation makes the
// timer a no-op once the phase changes (mirrors armAdvance), so drops naturally
// stop when the round leaves drawing/guessing.
func (r *Room) armDrop(gen int, d time.Duration) {
	time.AfterFunc(d, func() {
		r.Submit(Command{Kind: CmdDropPowerup, Gen: gen})
	})
}
```

Add the dispatch cases in `handle` (next to `CmdAdvance`):

```go
	case CmdFirePowerup:
		r.firePowerup(c)
	case CmdDropPowerup:
		if c.Gen == r.phaseGen {
			r.grantDrops(r.state.Phase)
			r.armDrop(r.phaseGen, dropInterval)
		}
```

(`firePowerup` is added in Task 3; for this task it is referenced but not yet defined — so implement Step 5 of this task before compiling, or temporarily stub. To keep the build green, add the stub now and replace it in Task 3:)

In `backend/internal/game/powerups.go` add a stub to be fleshed out in Task 3:

```go
// firePowerup is implemented in Task 3.
func (r *Room) firePowerup(c Command) {}
```

- [ ] **Step 5: Arm the ticker in startPhase + clear effects**

In `backend/internal/game/rounds.go`, replace `startPhase` with:

```go
// startPhase sets the phase, bumps the generation, and arms the advance timer for
// timed phases (durMs > 0). PhaseEndsAt lets clients render a countdown. In
// Frenzy it also clears phase-scoped effects and arms the drop ticker for the
// drawing/guessing phases.
func (r *Room) startPhase(p Phase, durMs int) {
	r.state.Phase = p
	r.phaseGen++
	r.state.Effects = nil // effects are phase-scoped — none carry across a transition
	if durMs > 0 {
		d := time.Duration(durMs) * time.Millisecond
		r.state.PhaseEndsAt = time.Now().Add(d).UnixMilli()
		r.armAdvance(r.phaseGen, d)
	} else {
		r.state.PhaseEndsAt = 0
	}
	if r.state.Mode == ModeFrenzy && (p == PhaseDrawing || p == PhaseGuessing) {
		r.armDrop(r.phaseGen, dropInterval)
	}
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/game/ -run 'TestGrantDropsRespectsCapAndConnection|TestDropCommandGenGated' -v`
Expected: PASS

- [ ] **Step 7: Full suite (classic/flipped unaffected)**

Run: `cd backend && go test ./internal/game/`
Expected: ok.

- [ ] **Step 8: Commit**

Stage `backend/internal/game/powerups.go`, `backend/internal/game/room.go`, `backend/internal/game/rounds.go`, `backend/internal/game/powerups_test.go`. Suggested message: `feat(game): frenzy drop ticker (generation-gated, per-phase)`. Hand off to the user to commit.

---

## Task 3: Fire a powerup

**Files:**
- Modify: `backend/internal/game/powerups.go` (`firePowerup` + helpers)
- Modify: `backend/internal/realtime/socket.go` (`firePowerup` event)
- Test: `backend/internal/game/powerups_test.go`

**Interfaces:**
- Consumes: `powerupCatalog`, `r.present`, `r.state.Inventory`/`Effects`, `Command.PowerupID`.
- Produces: `firePowerup(c Command)` (replacing the stub), `hasPowerup`, `consumePowerup`, `randomRival`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/internal/game/powerups_test.go`:

```go
func frenzyGuessing(t *testing.T, names ...string) *Room {
	t.Helper()
	r := syncRoom(t, names...)
	r.state.Mode = ModeFrenzy
	for _, n := range names {
		draft(r, n)
	}
	r.advance() // → guessing
	if r.state.Phase != PhaseGuessing {
		t.Fatalf("phase = %q, want guessing", r.state.Phase)
	}
	return r
}

func TestFireLandsOnRivalAndConsumes(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := frenzyGuessing(t, names...)
	r.state.Inventory = map[string][]Powerup{"alice": {PowerSquint}}

	r.handle(Command{Kind: CmdFirePowerup, Player: "alice", PowerupID: string(PowerSquint)})

	if len(r.state.Inventory["alice"]) != 0 {
		t.Fatalf("alice still holds %+v, want consumed", r.state.Inventory["alice"])
	}
	hit := 0
	for victim, effs := range r.state.Effects {
		if victim == "alice" {
			t.Fatal("a fire must not land on its own caster")
		}
		for _, e := range effs {
			if e.Kind == PowerSquint && e.From == "alice" {
				hit++
				if e.EndsAt <= time.Now().UnixMilli() {
					t.Fatal("effect endsAt should be in the future")
				}
			}
		}
	}
	if hit != 1 {
		t.Fatalf("squint landed on %d rivals, want exactly 1", hit)
	}
}

func TestFireRejectedWrongPhaseOrUnowned(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := frenzyGuessing(t, names...)
	r.state.Inventory = map[string][]Powerup{"alice": {PowerSquint}}

	// A draw-phase powerup can't fire during guessing.
	r.handle(Command{Kind: CmdFirePowerup, Player: "alice", PowerupID: string(PowerFog)})
	// An unowned powerup can't fire.
	r.handle(Command{Kind: CmdFirePowerup, Player: "bob", PowerupID: string(PowerSquint)})

	if len(r.state.Effects) != 0 {
		t.Fatalf("no effect should exist after rejected fires, got %+v", r.state.Effects)
	}
	if len(r.state.Inventory["alice"]) != 1 {
		t.Fatal("alice's squint must be untouched after a wrong-phase fire")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'TestFireLandsOnRivalAndConsumes|TestFireRejectedWrongPhaseOrUnowned' -v`
Expected: FAIL — the stub `firePowerup` does nothing, so the consume/land assertions fail.

- [ ] **Step 3: Replace the stub with the real fire logic**

In `backend/internal/game/powerups.go`, add `"time"` to the import (make it a block with `math/rand/v2`):

```go
import (
	"math/rand/v2"
	"time"
)
```

Replace the `firePowerup` stub with:

```go
// firePowerup validates a fire and applies the powerup's effect to a random
// connected rival. It is a no-op (the item is kept) when not in frenzy, in the
// wrong phase, the powerup is unknown / not fireable this phase, not held, or
// there is no eligible rival.
func (r *Room) firePowerup(c Command) {
	if r.state.Mode != ModeFrenzy {
		return
	}
	if r.state.Phase != PhaseDrawing && r.state.Phase != PhaseGuessing {
		return
	}
	pw := Powerup(c.PowerupID)
	spec, ok := powerupCatalog[pw]
	if !ok || spec.phase != r.state.Phase {
		return
	}
	if !r.hasPowerup(c.Player, pw) {
		return
	}
	victim := r.randomRival(c.Player)
	if victim == "" {
		return
	}
	r.consumePowerup(c.Player, pw)
	if r.state.Effects == nil {
		r.state.Effects = map[string][]ActiveEffect{}
	}
	r.state.Effects[victim] = append(r.state.Effects[victim], ActiveEffect{
		Kind:   pw,
		EndsAt: time.Now().Add(time.Duration(spec.durMs) * time.Millisecond).UnixMilli(),
		From:   c.Player,
	})
}

func (r *Room) hasPowerup(name string, pw Powerup) bool {
	for _, held := range r.state.Inventory[name] {
		if held == pw {
			return true
		}
	}
	return false
}

func (r *Room) consumePowerup(name string, pw Powerup) {
	held := r.state.Inventory[name]
	for i, h := range held {
		if h == pw {
			r.state.Inventory[name] = append(held[:i], held[i+1:]...)
			return
		}
	}
}

// randomRival returns a random connected player other than self, or "" if none.
func (r *Room) randomRival(self string) string {
	var rivals []string
	for _, p := range r.state.Players {
		if p.Name == self {
			continue
		}
		if pr, ok := r.present[p.Name]; ok && pr.connected {
			rivals = append(rivals, p.Name)
		}
	}
	if len(rivals) == 0 {
		return ""
	}
	return rivals[rand.IntN(len(rivals))]
}
```

- [ ] **Step 4: Bridge the firePowerup event**

In `backend/internal/realtime/socket.go`, add to `bind` (next to the other `sock.On` handlers):

```go
	sock.On("firePowerup", func(args ...any) {
		c.submit(game.Command{Kind: game.CmdFirePowerup, PowerupID: strings.TrimSpace(stringField(args, "id"))})
	})
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/game/ -run 'TestFireLandsOnRivalAndConsumes|TestFireRejectedWrongPhaseOrUnowned' -v`
Expected: PASS

- [ ] **Step 6: Full backend build + suites**

Run: `cd backend && go build ./... && go test ./...`
Expected: ok.

- [ ] **Step 7: Commit**

Stage `backend/internal/game/powerups.go`, `backend/internal/realtime/socket.go`, `backend/internal/game/powerups_test.go`. Suggested message: `feat(game): fire a powerup at a random rival`. Hand off to the user to commit.

---

## Task 4: Lifecycle — inventory wipe + departed cleanup

**Files:**
- Modify: `backend/internal/game/rounds.go` (`endGame`, `returnToLobby`)
- Modify: `backend/internal/game/members.go` (`clearRoundData`)
- Test: `backend/internal/game/powerups_test.go`

**Interfaces:**
- Consumes: `r.state.Inventory`/`Effects`.
- Produces: inventory/effects cleared at game end, return-to-lobby, and player departure.

- [ ] **Step 1: Write the failing tests**

Add to `backend/internal/game/powerups_test.go`:

```go
func TestInventoryWipedReturningToLobby(t *testing.T) {
	r := frenzyGuessing(t, "alice", "bob", "carol", "dave")
	r.state.Inventory = map[string][]Powerup{"alice": {PowerSquint}}
	r.state.Effects = map[string][]ActiveEffect{"bob": {{Kind: PowerSquint, EndsAt: 1 << 40, From: "alice"}}}

	r.handle(Command{Kind: CmdReturnToLobby, Player: "tv"})

	if len(r.state.Inventory) != 0 || len(r.state.Effects) != 0 {
		t.Fatalf("return-to-lobby must clear powerup state: inv=%+v eff=%+v", r.state.Inventory, r.state.Effects)
	}
}

func TestClearRoundDataDropsDepartedPowerups(t *testing.T) {
	r := frenzyGuessing(t, "alice", "bob", "carol", "dave")
	r.state.Inventory = map[string][]Powerup{"alice": {PowerSquint}}
	r.state.Effects = map[string][]ActiveEffect{"alice": {{Kind: PowerFog, EndsAt: 1 << 40, From: "bob"}}}

	r.clearRoundData("alice")

	if _, ok := r.state.Inventory["alice"]; ok {
		t.Fatal("a departed player's inventory must be cleared")
	}
	if _, ok := r.state.Effects["alice"]; ok {
		t.Fatal("a departed player's effects must be cleared")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'TestInventoryWipedReturningToLobby|TestClearRoundDataDropsDepartedPowerups' -v`
Expected: FAIL — state is not cleared yet.

- [ ] **Step 3: Wipe in endGame and returnToLobby**

In `backend/internal/game/rounds.go`, in both `endGame` and `returnToLobby`, add to the round-data reset block (alongside the existing `r.state.Featured = ""` etc.):

```go
	r.state.Inventory = nil
	r.state.Effects = nil
```

- [ ] **Step 4: Clear departed players' powerups**

In `backend/internal/game/members.go`, add to `clearRoundData`:

```go
	delete(r.state.Inventory, name)
	delete(r.state.Effects, name)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/game/ -run 'TestInventoryWipedReturningToLobby|TestClearRoundDataDropsDepartedPowerups' -v`
Expected: PASS

- [ ] **Step 6: Full suite**

Run: `cd backend && go test ./...`
Expected: ok.

- [ ] **Step 7: Commit**

Stage `backend/internal/game/rounds.go`, `backend/internal/game/members.go`, `backend/internal/game/powerups_test.go`. Suggested message: `feat(game): clear frenzy state on game-end, lobby, and departure`. Hand off to the user to commit.

---

## Task 5: Frontend plumbing + Frenzy lobby option + effects hook

**Files:**
- Modify: `frontend/src/lib/protocol.ts`
- Modify: `frontend/src/lib/store.ts`
- Modify: `frontend/src/hooks/use-game-socket.ts`
- Create: `frontend/src/hooks/use-effects.ts`
- Modify: `frontend/src/components/game/stages/HostConfig.tsx`
- Test: `frontend/src/hooks/use-effects.test.ts`

**Interfaces:**
- Consumes: backend `yourPowerups`/`yourEffects` (Task 1); store `mode` + `GameMode` (foundation).
- Produces: `Powerup` + `ActiveEffect` TS types; store `yourPowerups: Powerup[]`, `yourEffects: ActiveEffect[]`; action `firePowerup(id: string)`; hook `useActiveEffects(): Set<Powerup>`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/hooks/use-effects.test.ts`:

```ts
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useGameStore } from "@/lib/store";
import { useActiveEffects } from "./use-effects";

describe("useActiveEffects", () => {
  it("returns only effects whose endsAt is still in the future", () => {
    act(() => {
      useGameStore.getState().reset();
      useGameStore.setState({
        yourEffects: [
          { kind: "fog", endsAt: Date.now() + 5000, from: "bob" },
          { kind: "squint", endsAt: Date.now() - 5000, from: "carol" },
        ],
      });
    });
    const { result } = renderHook(() => useActiveEffects());
    expect(result.current.has("fog")).toBe(true);
    expect(result.current.has("squint")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/hooks/use-effects.test.ts`
Expected: FAIL — `useActiveEffects` / `yourEffects` don't exist.

- [ ] **Step 3: Add the protocol types**

In `frontend/src/lib/protocol.ts`, add after `Stroke`:

```ts
// A Frenzy sabotage item.
export type Powerup =
  | "fog"
  | "lights"
  | "flip"
  | "cramp"
  | "squint"
  | "curtain"
  | "shuffle";

// An active effect inflicted on this client.
export interface ActiveEffect {
  kind: Powerup;
  endsAt: number;
  from: string;
}
```

Add to the `GameState` interface (near the recipient-specific fields):

```ts
  yourPowerups?: Powerup[];
  yourEffects?: ActiveEffect[];
```

- [ ] **Step 4: Add the store fields**

In `frontend/src/lib/store.ts`:
- Add `Powerup`, `ActiveEffect` to the `import type { ... } from "./protocol"` list.
- In `GameStore` add `yourPowerups: Powerup[];` and `yourEffects: ActiveEffect[];`.
- In `initial` add `yourPowerups: [] as Powerup[],` and `yourEffects: [] as ActiveEffect[],`.
- In `applyState`'s returned object add `yourPowerups: s.yourPowerups ?? [],` and `yourEffects: s.yourEffects ?? [],`.

- [ ] **Step 5: Add the fire action**

In `frontend/src/hooks/use-game-socket.ts`, add to the returned object:

```ts
    firePowerup: useCallback(
      (id: string) => emit("firePowerup", { id }),
      [emit],
    ),
```

- [ ] **Step 6: Create the effects hook**

Create `frontend/src/hooks/use-effects.ts`:

```ts
import { useEffect, useState } from "react";
import { now as serverTime } from "@/lib/clock";
import type { Powerup } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";

// useActiveEffects returns the set of powerup kinds currently affecting this
// client. It re-evaluates on a short interval so each effect drops out the moment
// its server-stamped endsAt passes (compared against the server-anchored clock).
export function useActiveEffects(): Set<Powerup> {
  const effects = useGameStore((s) => s.yourEffects);
  const [, tick] = useState(0);

  useEffect(() => {
    if (effects.length === 0) return;
    const id = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(id);
  }, [effects]);

  const t = serverTime();
  return new Set(effects.filter((e) => e.endsAt > t).map((e) => e.kind));
}
```

- [ ] **Step 7: Add the Frenzy lobby option**

In `frontend/src/components/game/stages/HostConfig.tsx`, extend the mode `Segmented` `options` array (added by the Whose Doodle foundation) to include Frenzy:

```tsx
          options={[
            { value: "classic" as const, label: "Classic" },
            { value: "flipped" as const, label: "Whose Doodle" },
            { value: "frenzy" as const, label: "Frenzy" },
          ]}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/hooks/use-effects.test.ts`
Expected: PASS

- [ ] **Step 9: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

Stage `frontend/src/lib/protocol.ts`, `frontend/src/lib/store.ts`, `frontend/src/hooks/use-game-socket.ts`, `frontend/src/hooks/use-effects.ts`, `frontend/src/hooks/use-effects.test.ts`, `frontend/src/components/game/stages/HostConfig.tsx`. Suggested message: `feat(ui): frenzy plumbing, effects hook, and lobby option`. Hand off to the user to commit.

---

## Task 6: Powerup tray (fire UI + toasts)

**Files:**
- Create: `frontend/src/components/game/display/PowerupTray.tsx`
- Modify: `frontend/src/components/game/stages/PlayerStage.tsx` (mount the tray)
- Test: `frontend/src/components/game/stages/stages.test.tsx`

**Interfaces:**
- Consumes: store `yourPowerups`/`yourEffects`/`mode`; `actions.firePowerup(id)`.
- Produces: `<PowerupTray actions={GameActions} />` rendered during drawing/guessing in Frenzy.

- [ ] **Step 1: Write the failing test**

Add `firePowerup: () => {},` to `noopActions` in `frontend/src/components/game/stages/stages.test.tsx`, then add:

```tsx
  it("frenzy tray shows held powerups and fires them", () => {
    const fired: string[] = [];
    const actions = {
      ...noopActions,
      firePowerup: (id: string) => fired.push(id),
    } as unknown as GameActions;
    useGameStore.setState({
      phase: "drawing",
      mode: "frenzy",
      players: [{ name: "ann" }, { name: "bob" }],
      yourPrompt: "cat",
      yourPowerups: ["fog", "cramp"],
    });
    const { getByLabelText } = render(<PlayerStage name="ann" actions={actions} />);
    getByLabelText(/fire fog/i).click();
    expect(fired).toEqual(["fog"]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/game/stages/stages.test.tsx -t "frenzy tray"`
Expected: FAIL — no tray.

- [ ] **Step 3: Create the tray**

Create `frontend/src/components/game/display/PowerupTray.tsx`:

```tsx
import { useEffect, useRef } from "react";
import type { GameActions } from "@/hooks/use-game-socket";
import type { Powerup } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";

// Human labels + emoji for each powerup, used on the tray buttons and toasts.
const META: Record<Powerup, { label: string; icon: string }> = {
  fog: { label: "Fog", icon: "🌫️" },
  lights: { label: "Lights-Out", icon: "🌑" },
  flip: { label: "Topsy-Turvy", icon: "🙃" },
  cramp: { label: "Cramp", icon: "✋" },
  squint: { label: "Squint", icon: "😵" },
  curtain: { label: "Curtain", icon: "🎭" },
  shuffle: { label: "Shuffle", icon: "🔀" },
};

// PowerupTray is the Frenzy fire UI: a row of held powerups. Tapping one fires it
// at a random rival (the server chooses). It also surfaces a transient toast when
// an effect lands on this player ("Bob fogged you!").
export function PowerupTray({ actions }: { actions: GameActions }) {
  const powerups = useGameStore((s) => s.yourPowerups);
  const effects = useGameStore((s) => s.yourEffects);
  const pushNotice = useGameStore((s) => s.pushNotice);
  const seen = useRef(0);

  // Announce newly-arrived incoming effects once each.
  useEffect(() => {
    if (effects.length > seen.current) {
      for (const e of effects.slice(seen.current)) {
        pushNotice(`${e.from} hit you with ${META[e.kind].label}!`);
      }
    }
    seen.current = effects.length;
  }, [effects, pushNotice]);

  if (powerups.length === 0) {
    return (
      <div className="flex shrink-0 items-center justify-center gap-2 font-hand text-lg text-muted">
        no powerups yet — hang tight…
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-2">
      {powerups.map((p, i) => (
        <button
          // index-keyed: duplicates of the same powerup are distinct slots
          key={`${p}-${i}`}
          type="button"
          aria-label={`fire ${META[p].label}`}
          title={`Fire ${META[p].label} at a random rival`}
          onClick={() => actions.firePowerup(p)}
          className="card-arcade card-hover card-press pop flex items-center gap-1.5 px-3 py-2 text-sm font-bold"
        >
          <span aria-hidden>{META[p].icon}</span>
          {META[p].label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Add a pushNotice helper to the store**

The tray uses `pushNotice` for the hit toast. In `frontend/src/lib/store.ts`, add to the `GameStore` interface:

```ts
  pushNotice: (text: string) => void;
```

And implement it next to `dismissNotice` in the store body:

```ts
  pushNotice: (text) =>
    set((s) => ({ notices: [...s.notices, { id: ++noticeSeq, text }] })),
```

- [ ] **Step 5: Mount the tray in the player drawing + guessing stages**

In `frontend/src/components/game/stages/PlayerStage.tsx`:

Import it:

```tsx
import { PowerupTray } from "../display/PowerupTray";
```

In `PlayerDrawing`, read the mode near the other selectors:

```tsx
  const mode = useGameStore((s) => s.mode);
```

Then render the tray just below the prompt header row (inside the top-level `<div className="flex h-full min-h-0 flex-col gap-3">`, right after the header `</div>` that holds the prompt + Timer):

```tsx
      {mode === "frenzy" && <PowerupTray actions={actions} />}
```

In `PlayerGuessing`, the classic branch already reads several selectors — add the mode (if not already present) and render the tray right after the header row (the `<div className="flex shrink-0 items-center justify-between gap-3">...</div>`):

```tsx
      {mode === "frenzy" && <PowerupTray actions={actions} />}
```

(For the flipped guess, the tray is added in Task 8 alongside the flipped effect wiring; classic guess gets it here.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/game/stages/stages.test.tsx -t "frenzy tray"`
Expected: PASS

- [ ] **Step 7: Full frontend test + typecheck**

Run: `cd frontend && npm run typecheck && npm run test`
Expected: clean; all pass.

- [ ] **Step 8: Commit**

Stage `frontend/src/components/game/display/PowerupTray.tsx`, `frontend/src/lib/store.ts`, `frontend/src/components/game/stages/PlayerStage.tsx`, `frontend/src/components/game/stages/stages.test.tsx`. Suggested message: `feat(ui): frenzy powerup tray with fire + hit toasts`. Hand off to the user to commit.

---

## Task 7: Drawing-phase effects (fog / lights / flip / cramp)

**Files:**
- Create: `frontend/src/components/game/display/EffectLayer.tsx`
- Modify: `frontend/src/components/game/canvas/DrawingCanvas.tsx`
- Modify: `frontend/src/components/game/stages/PlayerStage.tsx` (`PlayerDrawing` passes effects)
- Test: `frontend/src/components/game/stages/stages.test.tsx`

**Interfaces:**
- Consumes: `useActiveEffects()` (Task 5).
- Produces: `<EffectLayer effects={Set<Powerup>}>`; `DrawingCanvas` gains an `effects?: Set<Powerup>` prop (fog/lights/flip overlays around the canvas; `cramp` ORs into `disabled`).

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/components/game/stages/stages.test.tsx`:

```tsx
  it("frenzy fog overlays the drawing canvas; cramp disables input", () => {
    useGameStore.setState({
      phase: "drawing",
      mode: "frenzy",
      players: [{ name: "ann" }],
      yourPrompt: "cat",
      yourEffects: [
        { kind: "fog", endsAt: Date.now() + 5000, from: "bob" },
        { kind: "cramp", endsAt: Date.now() + 5000, from: "bob" },
      ],
    });
    const { container } = render(<PlayerStage name="ann" actions={noopActions} />);
    // Fog overlay is present over the canvas area.
    expect(container.querySelector('[data-effect="fog"]')).not.toBeNull();
    // Cramp disables the canvas (the dim/opacity class the disabled canvas uses).
    expect(container.querySelector("canvas.opacity-70")).not.toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/game/stages/stages.test.tsx -t "frenzy fog"`
Expected: FAIL — no overlay, canvas not disabled.

- [ ] **Step 3: Create EffectLayer**

Create `frontend/src/components/game/display/EffectLayer.tsx`:

```tsx
import type { Powerup } from "@/lib/protocol";

// EffectLayer wraps content and renders Frenzy perception effects over it: blur
// (squint) and 180° flip (topsy-turvy) as transforms on the content, and fog /
// lights-out / curtain as pointer-transparent overlays (so input still passes
// through — the victim draws/guesses "blind"). Cramp and shuffle are input/data
// effects handled by consumers, not here.
export function EffectLayer({
  effects,
  children,
  className,
}: {
  effects: Set<Powerup>;
  children: React.ReactNode;
  className?: string;
}) {
  const blur = effects.has("squint");
  const flip = effects.has("flip");
  return (
    <div className={`relative overflow-hidden ${className ?? "h-full w-full"}`}>
      <div
        className={`h-full w-full transition-all duration-200 ${
          blur ? "blur-md" : ""
        } ${flip ? "rotate-180" : ""}`}
      >
        {children}
      </div>
      {effects.has("fog") && (
        <div
          data-effect="fog"
          className="pointer-events-none absolute inset-0 animate-pulse bg-white/70 backdrop-blur-md"
        />
      )}
      {effects.has("lights") && (
        <div
          data-effect="lights"
          className="pointer-events-none absolute inset-0 bg-black/85"
        />
      )}
      {effects.has("curtain") && (
        <div
          data-effect="curtain"
          className="pointer-events-none absolute inset-0 bg-foreground/90"
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire effects into DrawingCanvas**

In `frontend/src/components/game/canvas/DrawingCanvas.tsx`:

Add the import:

```tsx
import type { Powerup } from "@/lib/protocol";
import { EffectLayer } from "../display/EffectLayer";
```

Add an `effects` prop (default empty set) to the component signature and props type:

```tsx
  effects = new Set<Powerup>(),
```

```tsx
  effects?: Set<Powerup>;
```

Compute the cramp lock + derive disabled, just inside the component body (after the existing hooks):

```tsx
  const crampLocked = effects.has("cramp");
  const inputDisabled = disabled || crampLocked;
```

Replace every gameplay use of `disabled` for *input/visual* with `inputDisabled`: the `start`/`move` guards (`if (disabled ...)` → `if (inputDisabled ...)`) and the canvas `className` ternary (`disabled ? "opacity-70" : "cursor-crosshair"` → `inputDisabled ? "opacity-70" : "cursor-crosshair"`). Keep the toolbar's `{!disabled && (...)}` on the original `disabled` so the tools stay usable during a cramp.

Wrap the `<canvas>` element in the `EffectLayer` so overlays/flip sit over the canvas only (not the toolbar). Replace the canvas wrapper:

```tsx
      <div className="flex min-h-0 flex-1 items-center justify-center lg:max-w-176 lg:flex-initial">
        <EffectLayer effects={effects} className="flex h-full w-full items-center justify-center">
          <canvas
            ref={ref}
            width={CANVAS_W}
            height={CANVAS_H}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerLeave={end}
            onPointerCancel={end}
            className={`max-h-full max-w-full touch-none select-none rounded-2xl border-2 border-border bg-surface lg:max-h-[68vh] ${
              inputDisabled ? "opacity-70" : "cursor-crosshair"
            }`}
          />
        </EffectLayer>
      </div>
```

- [ ] **Step 5: Pass effects from PlayerDrawing**

In `frontend/src/components/game/stages/PlayerStage.tsx`, add the import:

```tsx
import { useActiveEffects } from "@/hooks/use-effects";
```

In `PlayerDrawing`, compute the effects and pass them to the canvas:

```tsx
  const effects = useActiveEffects();
```

Update the `<DrawingCanvas ... />` usage to pass `effects={effects}`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/game/stages/stages.test.tsx -t "frenzy fog"`
Expected: PASS

- [ ] **Step 7: Full frontend test + typecheck + lint touched files**

Run:
```
cd frontend && npm run typecheck && npm run test && npx biome check src/components/game/display/EffectLayer.tsx src/components/game/canvas/DrawingCanvas.tsx src/components/game/stages/PlayerStage.tsx
```
Expected: clean.

- [ ] **Step 8: Commit**

Stage `EffectLayer.tsx`, `DrawingCanvas.tsx`, `PlayerStage.tsx`, `stages.test.tsx`. Suggested message: `feat(ui): frenzy drawing-phase effects (fog/lights/flip/cramp)`. Hand off to the user to commit.

---

## Task 8: Guess-phase effects (squint / curtain / shuffle)

**Files:**
- Modify: `frontend/src/components/game/display/FlippedGuessing.tsx`
- Modify: `frontend/src/components/game/stages/PlayerStage.tsx` (`PlayerGuessing` classic inline drawing + options)
- Test: `frontend/src/components/game/stages/stages.test.tsx`

**Interfaces:**
- Consumes: `useActiveEffects()`, `EffectLayer`.
- Produces: squint/curtain wrap the drawing(s); shuffle reorders the candidate list. Applied on player devices only (the TV host has no effects).

Note: guess effects are meaningful where the player sees drawings on their own device — flipped (the doodle grid) and play-along classic (the inline drawing). On a classic phone that only shows option buttons, `shuffle` still reorders them; `squint`/`curtain` simply have nothing to cover. No special-casing needed.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/components/game/stages/stages.test.tsx`:

```tsx
  it("frenzy curtain covers the flipped doodle grid", () => {
    useGameStore.setState({
      phase: "guessing",
      mode: "frenzy",
      // flipped layout drives the on-device grid; frenzy effects layer over it
      target: "bob",
      youAreTarget: false,
      players: [{ name: "ann" }, { name: "bob", hasDrawn: true }],
      pool: [
        { id: "d1", strokes: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }] },
        { id: "d2", strokes: [{ color: "#f00", width: 4, points: [{ x: 2, y: 2 }] }] },
      ],
      yourEffects: [{ kind: "curtain", endsAt: Date.now() + 5000, from: "bob" }],
    });
    const { container } = render(<PlayerStage name="ann" actions={noopActions} />);
    expect(container.querySelector('[data-effect="curtain"]')).not.toBeNull();
  });
```

Note: this test exercises a flipped + frenzy combination. If the `mode` union only carries one value, treat `mode: "frenzy"` as the controlling mode and have `FlippedGuessing` render whenever a `pool` is present. To keep modes orthogonal in the test, set `mode: "frenzy"` and rely on `PlayerGuessing` routing to the flipped grid when `pool.length > 0` (see Step 3).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/game/stages/stages.test.tsx -t "frenzy curtain"`
Expected: FAIL — no curtain overlay.

- [ ] **Step 3: Decouple the flipped grid from the mode flag and layer effects**

Modes are mutually exclusive on the server, but the *grid* UI should render whenever the server sends a `pool` (flipped) and the *effects* should layer in whenever present (frenzy). In `frontend/src/components/game/stages/PlayerStage.tsx`, in `PlayerGuessing`, change the flipped routing condition from `mode === "flipped"` to:

```tsx
  if (pool.length > 0) {
```

and pass effects into `FlippedGuessing`:

```tsx
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
        effects={effects}
        tray={mode === "frenzy" ? <PowerupTray actions={actions} /> : null}
      />
    );
```

Add `const effects = useActiveEffects();` to `PlayerGuessing` if not already present (it is imported in Task 7).

- [ ] **Step 4: Apply effects in FlippedGuessing**

In `frontend/src/components/game/display/FlippedGuessing.tsx`:

Add imports + props:

```tsx
import type { Powerup } from "@/lib/protocol";
import { EffectLayer } from "./EffectLayer";
```

Extend the props with `effects` (default empty) and an optional `tray` node:

```tsx
  effects = new Set<Powerup>(),
  tray,
```

```tsx
  effects?: Set<Powerup>;
  tray?: React.ReactNode;
```

Render `tray` under the header (after the header row `</div>`), and wrap the grid `<ul>` in `EffectLayer` so squint/curtain layer over the candidates; apply `shuffle` by reordering the pool. Add before the return:

```tsx
  const shuffled = effects.has("shuffle")
    ? [...pool].sort((a, b) => a.id.localeCompare(b.id)).reverse()
    : pool;
```

Use `shuffled` instead of `pool` inside the `.map(...)`, and wrap that `<ul>` element:

```tsx
        <EffectLayer effects={effects} className="min-h-0 flex-1">
          <ul ...>
            {shuffled.map((d, i) => ( ... ))}
          </ul>
        </EffectLayer>
```

Add `{tray}` right after the header `</div>` and before the body branch.

- [ ] **Step 5: Apply effects to the classic inline guess (play-along)**

Still in `PlayerStage.tsx` `PlayerGuessing` (the classic branch, reached when `pool.length === 0`): wrap the inline `StrokesView` (the `showDrawing` block) in `EffectLayer effects={effects}`, and reorder `options` with the same shuffle rule:

```tsx
  const shownOptions = effects.has("shuffle")
    ? [...options].reverse()
    : options;
```

Use `shownOptions` in the options `.map(...)`. Wrap the inline drawing:

```tsx
        {showDrawing && (
          <EffectLayer effects={effects} className="tape reveal-clip mt-2 aspect-4/3 ...">
            <StrokesView strokes={drawing} className="h-full w-full" />
          </EffectLayer>
        )}
```

(Keep the existing wrapper classes; move them onto `EffectLayer`'s `className`. Import `EffectLayer` at the top of `PlayerStage.tsx`.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/game/stages/stages.test.tsx -t "frenzy curtain"`
Expected: PASS

- [ ] **Step 7: Full verification**

Run:
```
cd frontend && npm run typecheck && npm run test && npx biome check src/components/game/display/FlippedGuessing.tsx src/components/game/stages/PlayerStage.tsx
```
Expected: typecheck clean; all tests pass (existing flipped tests still green — the `pool.length > 0` routing preserves them); biome clean on touched files.

- [ ] **Step 8: Commit**

Stage `FlippedGuessing.tsx`, `PlayerStage.tsx`, `stages.test.tsx`. Suggested message: `feat(ui): frenzy guess-phase effects (squint/curtain/shuffle)`. Hand off to the user to commit.

---

## Self-Review

**Spec coverage** (against `2026-06-22-frenzy-mode-design.md`):
- Safety rule (view-only/input-lock, never alter strokes, absolute `endsAt`) → Tasks 1, 7, 8. Effects are client-side overlays/transforms; the server never edits `Drawings`. ✓
- Catalog (4 draw + 3 guess) → Task 1. ✓
- Drops (periodic, every connected player, `inventoryCap`, draw+guess only, pause in reveal, gen-gated) → Task 2. ✓
- Fire (random connected rival, never self, phase-gated, consume, no-rival no-op) → Task 3. ✓
- Redaction (own inventory/effects only) → Task 1 (`TestViewRedactsPowerups`). ✓
- Lifecycle (effects phase-scoped, inventory persists then wiped at end/lobby/departure) → Tasks 2 (clear on `startPhase`) + 4. ✓
- Frontend tray + toasts → Task 6; effect overlays → Tasks 7, 8; lobby option → Task 5. ✓
- Edge cases: no rival (Task 3), departed victim (Task 4), reconnect mid-effect (absolute `endsAt` honored by `useActiveEffects`, Task 5), TV host not targeted (not in `present` as a player; tray only on player stages), inventory cap (Task 2). ✓
- Zero overhead for classic/flipped: all logic gated on `ModeFrenzy`; `startPhase` only arms the ticker in frenzy; views only carry powerup fields in frenzy. ✓

**Placeholder scan:** No TBD/TODO. Task 2 Step 4 introduces an explicit, called-out `firePowerup` stub that Task 3 Step 3 replaces — intentional ordering, not a placeholder. Task 8's note about the flipped/frenzy test combination is an explicit instruction, with the concrete `pool.length > 0` routing given in Step 3.

**Type consistency:** `Powerup` values (`fog/lights/flip/cramp/squint/curtain/shuffle`) match across `powerups.go`, `protocol.ts`, `PowerupTray` META, and `EffectLayer`. `ActiveEffect{kind,endsAt,from}` identical backend/frontend. `Command.PowerupID` ↔ `firePowerup({id})` ↔ `stringField(args,"id")` ↔ `actions.firePowerup(p)`. `CmdFirePowerup`/`CmdDropPowerup`, `armDrop`, `dropInterval`, `inventoryCap`, `grantDrops`, `randomRival` consistent across Tasks 2–4. `EffectLayer`/`FlippedGuessing` `effects?: Set<Powerup>` prop identical in Tasks 7–8.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-22-frenzy-mode.md`.
