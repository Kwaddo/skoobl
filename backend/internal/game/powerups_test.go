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
		{Kind: PowerFog, EndsAt: 500, From: "a"},     // expired
		{Kind: PowerSquint, EndsAt: 1500, From: "b"}, // live
	}
	out := activeEffects(in, now)
	if len(out) != 1 || out[0].Kind != PowerSquint {
		t.Fatalf("activeEffects = %+v, want only the live squint", out)
	}
}

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
