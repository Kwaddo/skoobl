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

func TestWaveRollsPhaseAppropriateEffects(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := frenzyGuessing(t, names...)

	r.applyEffectWave(PhaseGuessing, 0.0, 6*time.Second)

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

	r.applyEffectWave(PhaseDrawing, 0.0, 6*time.Second)

	if _, ok := r.state.Effects["bob"]; ok {
		t.Fatal("a locked-in drawer is done — must not be hit")
	}
	if _, ok := r.state.Effects["carol"]; ok {
		t.Fatal("a locked-in drawer is done — must not be hit")
	}
	if len(r.state.Effects["alice"]) == 0 || len(r.state.Effects["dave"]) == 0 {
		t.Fatal("the still-drawing players should have been hit")
	}
}

func TestWaveSkipsFeaturedAndGuessed(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := frenzyGuessing(t, names...)
	// carol is the artist on show (doesn't guess); bob already guessed. Only alice
	// and dave are still guessing.
	r.state.Featured = "carol"
	r.state.Guesses = map[string]string{"bob": "x"}

	r.applyEffectWave(PhaseGuessing, 0.0, 6*time.Second)

	if _, ok := r.state.Effects["carol"]; ok {
		t.Fatal("the featured artist doesn't guess — must not be hit")
	}
	if _, ok := r.state.Effects["bob"]; ok {
		t.Fatal("an already-guessed player is done — must not be hit")
	}
	if len(r.state.Effects["alice"]) == 0 || len(r.state.Effects["dave"]) == 0 {
		t.Fatal("the still-guessing players should have been hit")
	}
}

func TestWaveReplacesPriorEffects(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := syncRoom(t, names...)
	r.state.Mode = ModeFrenzy
	r.state.Phase = PhaseDrawing

	r.applyEffectWave(PhaseDrawing, 0.0, 6*time.Second)
	r.applyEffectWave(PhaseDrawing, 0.0, 6*time.Second)

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

	r.applyEffectWave(PhaseReveal, 0.5, 6*time.Second)

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

func TestWaveEscalatesWithProgress(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}

	early := syncRoom(t, names...)
	early.state.Mode = ModeFrenzy
	early.state.Phase = PhaseDrawing
	early.applyEffectWave(PhaseDrawing, 0.0, 6*time.Second) // mild tier
	for n, effs := range early.state.Effects {
		if !inPool(effs[0].Kind, drawTiers[tierMild]) {
			t.Fatalf("%s early wave = %q, want a mild draw effect", n, effs[0].Kind)
		}
	}

	late := syncRoom(t, names...)
	late.state.Mode = ModeFrenzy
	late.state.Phase = PhaseDrawing
	late.applyEffectWave(PhaseDrawing, 0.9, 6*time.Second) // harsh tier
	for n, effs := range late.state.Effects {
		if !inPool(effs[0].Kind, drawTiers[tierHarsh]) {
			t.Fatalf("%s late wave = %q, want a harsh draw effect", n, effs[0].Kind)
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
	// Mid (medium) draw wave: only flip.
	if e, ok := effectForWave(PhaseDrawing, 0.5); !ok || e != PowerFlip {
		t.Fatalf("medium draw wave = (%q,%v), want (flip,true)", e, ok)
	}
	// Mid (medium) guess wave: only shuffle.
	if e, ok := effectForWave(PhaseGuessing, 0.5); !ok || e != PowerShuffle {
		t.Fatalf("medium guess wave = (%q,%v), want (shuffle,true)", e, ok)
	}
	// Non-play phase: no effect.
	if _, ok := effectForWave(PhaseReveal, 0.5); ok {
		t.Fatal("reveal has no tiers — effectForWave must report ok=false")
	}
}
