package game

import (
	"testing"
	"time"
)

// inPool reports whether pw appears in the phase's effect pool.
func inPool(pw Powerup, pool []Powerup) bool {
	for _, p := range pool {
		if p == pw {
			return true
		}
	}
	return false
}

func TestPowerupsForPhaseSplit(t *testing.T) {
	draw := powerupsForPhase(PhaseDrawing)
	guess := powerupsForPhase(PhaseGuessing)
	if len(draw) == 0 || len(guess) == 0 {
		t.Fatalf("empty pools: draw=%d guess=%d", len(draw), len(guess))
	}
	// The two pools must be disjoint — an effect only makes sense in one phase.
	for _, p := range draw {
		if inPool(p, guess) {
			t.Fatalf("%q appears in both the draw and guess pools", p)
		}
	}
	if powerupsForPhase(PhaseReveal) != nil || powerupsForPhase(PhaseLobby) != nil {
		t.Fatal("phases with no effects must return a nil pool")
	}
}

func TestActiveEffectsPrunesExpired(t *testing.T) {
	now := int64(1000)
	in := []ActiveEffect{
		{Kind: PowerFog, EndsAt: 500},     // expired
		{Kind: PowerSquint, EndsAt: 1500}, // live
	}
	out := activeEffects(in, now)
	if len(out) != 1 || out[0].Kind != PowerSquint {
		t.Fatalf("activeEffects = %+v, want only the live squint", out)
	}
}

func TestActiveEffectsKeepsNotYetStruck(t *testing.T) {
	now := int64(1000)
	// A staggered effect that hasn't begun yet (StartsAt in the future) is still
	// "live" — it must reach the client so the client can begin it on schedule.
	in := []ActiveEffect{{Kind: PowerFog, StartsAt: 1500, EndsAt: 4000}}
	if out := activeEffects(in, now); len(out) != 1 {
		t.Fatalf("a not-yet-struck effect must survive the prune: %+v", out)
	}
}

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

// keysSubset reports whether every key in effects is one of allowed.
func keysSubset(effects map[string][]ActiveEffect, allowed ...string) bool {
	ok := map[string]bool{}
	for _, a := range allowed {
		ok[a] = true
	}
	for n := range effects {
		if !ok[n] {
			return false
		}
	}
	return true
}

func TestWaveStampsAStaggeredWindow(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := syncRoom(t, names...)
	r.state.Mode = ModeFrenzy
	r.state.Phase = PhaseDrawing

	before := time.Now().UnixMilli()
	r.applyEffectWave(PhaseDrawing, 0.9)
	after := time.Now().UnixMilli()

	if len(r.state.Effects) == 0 {
		t.Fatal("a wave must bite at least one player")
	}
	for n, effs := range r.state.Effects {
		if len(effs) != 1 {
			t.Fatalf("%s has %d effects, want exactly one per wave (no stacking)", n, len(effs))
		}
		e := effs[0]
		if !inPool(e.Kind, powerupsForPhase(PhaseDrawing)) {
			t.Fatalf("%s got %q, not a draw-phase effect", n, e.Kind)
		}
		// The strike is staggered into the near future, then runs for a spell.
		if e.StartsAt < before || e.StartsAt > after+maxStaggerMs {
			t.Fatalf("%s StartsAt %d outside the stagger window [%d,%d]", n, e.StartsAt, before, after+maxStaggerMs)
		}
		if e.EndsAt <= e.StartsAt {
			t.Fatalf("%s effect expires before it starts: start=%d end=%d", n, e.StartsAt, e.EndsAt)
		}
	}
}

func TestWaveRollsIndependentlyPerPlayer(t *testing.T) {
	// Across many waves on a full room at harsh progress (a 2-effect tier), the
	// per-player rolls must produce more than one distinct effect — proof the room
	// no longer shares a single synchronized handicap.
	names := []string{"alice", "bob", "carol", "dave"}
	r := syncRoom(t, names...)
	r.state.Mode = ModeFrenzy
	r.state.Phase = PhaseDrawing

	seen := map[Powerup]bool{}
	for i := 0; i < 80; i++ {
		r.state.Effects = nil // isolate each wave from carry-forward
		r.applyEffectWave(PhaseDrawing, 0.9)
		for _, effs := range r.state.Effects {
			for _, e := range effs {
				seen[e.Kind] = true
			}
		}
	}
	if len(seen) < 2 {
		t.Fatalf("per-player rolls produced only %d distinct effect(s): %v", len(seen), seen)
	}
}

func TestWaveRollsPhaseAppropriateEffects(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := frenzyGuessing(t, names...)

	r.applyEffectWave(PhaseGuessing, 0.5)

	if len(r.state.Effects) == 0 {
		t.Fatal("a guessing-phase wave should hit the active guessers")
	}
	for n, effs := range r.state.Effects {
		for _, e := range effs {
			if !inPool(e.Kind, powerupsForPhase(PhaseGuessing)) {
				t.Fatalf("%s got %q during guessing, not a guess-phase effect", n, e.Kind)
			}
		}
	}
}

func TestWaveSkipsLockedDrawers(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := syncRoom(t, names...)
	r.state.Mode = ModeFrenzy
	r.state.Phase = PhaseDrawing
	r.state.Locked = map[string]bool{"bob": true, "carol": true} // only alice + dave still drawing

	r.applyEffectWave(PhaseDrawing, 0.0)

	if _, ok := r.state.Effects["bob"]; ok {
		t.Fatal("a locked-in drawer is done — must not be hit")
	}
	if _, ok := r.state.Effects["carol"]; ok {
		t.Fatal("a locked-in drawer is done — must not be hit")
	}
	if len(r.state.Effects) == 0 || !keysSubset(r.state.Effects, "alice", "dave") {
		t.Fatalf("only still-drawing players may be hit, got %v", r.state.Effects)
	}
}

func TestWaveSkipsFeaturedAndGuessed(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := frenzyGuessing(t, names...)
	// carol is the artist on show (doesn't guess); bob already guessed. Only alice
	// and dave are still guessing.
	r.state.Featured = "carol"
	r.state.Guesses = map[string]string{"bob": "x"}

	r.applyEffectWave(PhaseGuessing, 0.0)

	if _, ok := r.state.Effects["carol"]; ok {
		t.Fatal("the featured artist doesn't guess — must not be hit")
	}
	if _, ok := r.state.Effects["bob"]; ok {
		t.Fatal("an already-guessed player is done — must not be hit")
	}
	if len(r.state.Effects) == 0 || !keysSubset(r.state.Effects, "alice", "dave") {
		t.Fatalf("only still-guessing players may be hit, got %v", r.state.Effects)
	}
}

func TestWaveDoesNotStackPerPlayer(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := syncRoom(t, names...)
	r.state.Mode = ModeFrenzy
	r.state.Phase = PhaseDrawing

	r.applyEffectWave(PhaseDrawing, 0.0)
	r.applyEffectWave(PhaseDrawing, 0.0)

	for n, effs := range r.state.Effects {
		if len(effs) != 1 {
			t.Fatalf("%s holds %d effects after two waves — a wave must replace, not stack", n, len(effs))
		}
	}
}

func TestWaveNoOpOutsidePlayPhases(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	r.state.Mode = ModeFrenzy
	r.state.Phase = PhaseReveal

	r.applyEffectWave(PhaseReveal, 0.5)

	if len(r.state.Effects) != 0 {
		t.Fatalf("reveal has no effect pool — wave must be a no-op, got %+v", r.state.Effects)
	}
}

func TestEffectWaveCommandGenGated(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	r.state.Mode = ModeFrenzy
	r.state.Phase = PhaseDrawing

	// A stale generation does nothing.
	r.handle(Command{Kind: CmdEffectWave, Gen: r.phaseGen - 1})
	if len(r.state.Effects) != 0 {
		t.Fatal("a stale-gen wave tick must not inflict effects")
	}
	// The current generation inflicts a wave.
	r.handle(Command{Kind: CmdEffectWave, Gen: r.phaseGen})
	if len(r.state.Effects) == 0 {
		t.Fatal("a current-gen wave tick should inflict effects")
	}
}

func TestEffectsClearedReturningToLobby(t *testing.T) {
	r := frenzyGuessing(t, "alice", "bob", "carol", "dave")
	r.state.Effects = map[string][]ActiveEffect{"bob": {{Kind: PowerSquint, EndsAt: 1 << 40}}}

	r.handle(Command{Kind: CmdReturnToLobby, Player: "tv"})

	if len(r.state.Effects) != 0 {
		t.Fatalf("return-to-lobby must clear effect state: eff=%+v", r.state.Effects)
	}
}

func TestClearRoundDataDropsDepartedEffects(t *testing.T) {
	r := frenzyGuessing(t, "alice", "bob", "carol", "dave")
	r.state.Effects = map[string][]ActiveEffect{"alice": {{Kind: PowerFog, EndsAt: 1 << 40}}}

	r.clearRoundData("alice")

	if _, ok := r.state.Effects["alice"]; ok {
		t.Fatal("a departed player's effects must be cleared")
	}
}

func TestViewRedactsEffects(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	r.state.Mode = ModeFrenzy
	future := time.Now().Add(time.Minute).UnixMilli()
	r.state.Effects = map[string][]ActiveEffect{
		"alice": {{Kind: PowerLights, EndsAt: future}},
		"bob":   {{Kind: PowerFog, EndsAt: 1}}, // expired
	}

	av := r.state.viewFor("alice", r.present)
	if len(av.YourEffects) != 1 || av.YourEffects[0].Kind != PowerLights {
		t.Fatalf("alice effects = %+v, want [lights]", av.YourEffects)
	}

	bv := r.state.viewFor("bob", r.present)
	if len(bv.YourEffects) != 0 {
		t.Fatalf("bob effects = %+v, want none (expired pruned)", bv.YourEffects)
	}
	// No cross-leak: a client view never carries the authoritative Effects map.
	if av.Effects != nil {
		t.Fatal("authoritative Effects must not appear in a client view")
	}
}

func TestEffectForPlayerStaysInPhase(t *testing.T) {
	// Whatever the jittered tier lands on, the rolled effect is always one the
	// phase owns — a draw wave never leaks a guess effect and vice versa.
	for i := 0; i < 200; i++ {
		for _, prog := range []float64{0.0, 0.5, 0.9} {
			d, ok := effectForPlayer(PhaseDrawing, prog)
			if !ok || !inPool(d, powerupsForPhase(PhaseDrawing)) {
				t.Fatalf("draw roll %q (ok=%v) escaped the draw pool at p=%v", d, ok, prog)
			}
			g, ok := effectForPlayer(PhaseGuessing, prog)
			if !ok || !inPool(g, powerupsForPhase(PhaseGuessing)) {
				t.Fatalf("guess roll %q (ok=%v) escaped the guess pool at p=%v", g, ok, prog)
			}
		}
	}
	if _, ok := effectForPlayer(PhaseReveal, 0.5); ok {
		t.Fatal("reveal has no tiers — effectForPlayer must report ok=false")
	}
}

func TestWaveEscalatesWithProgress(t *testing.T) {
	// Early waves never reach the harsh-only effects (the tier jitter can spike at
	// most one step, mild→medium); late waves never fall back to the mild-only fog
	// (slip at most one step, harsh→medium). So severity climbs toward the buzzer
	// even though any single roll is randomized.
	for i := 0; i < 200; i++ {
		early, ok := effectForPlayer(PhaseDrawing, 0.0)
		if !ok || early == PowerLights || early == PowerCramp {
			t.Fatalf("early draw roll = %q, want a non-harsh effect", early)
		}
		late, ok := effectForPlayer(PhaseDrawing, 0.95)
		if !ok || late == PowerFog {
			t.Fatalf("late draw roll = %q, want a non-mild effect", late)
		}
	}
}

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

func TestTierForPlayerStaysWithinOneStep(t *testing.T) {
	for i := 0; i < 300; i++ {
		for _, prog := range []float64{0.0, 0.5, 0.95} {
			base := int(tierForProgress(prog))
			got := int(tierForPlayer(prog))
			if got < base-1 || got > base+1 {
				t.Fatalf("tierForPlayer(%v) = %d, more than one step from baseline %d", prog, got, base)
			}
			if got < int(tierMild) || got > int(tierHarsh) {
				t.Fatalf("tierForPlayer(%v) = %d, out of range", prog, got)
			}
		}
	}
}
