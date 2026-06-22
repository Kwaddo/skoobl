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

func TestGrantDropsTrickleRespectsCapAndConnection(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	r.state.Mode = ModeFrenzy

	// Each tick arms exactly one player (not the whole room). Until everyone is
	// capped, every tick adds exactly one powerup to the room total.
	const ticks = inventoryCap + 3 // 6 < 4*cap, so no tick is wasted on a full room
	for i := 0; i < ticks; i++ {
		r.grantDrops(PhaseDrawing)
	}
	total := 0
	for name, held := range r.state.Inventory {
		if len(held) > inventoryCap {
			t.Fatalf("%s holds %d powerups, over cap %d", name, len(held), inventoryCap)
		}
		for _, p := range held {
			if powerupCatalog[p].phase != PhaseDrawing {
				t.Fatalf("%s holds %q, not a draw-phase powerup", name, p)
			}
		}
		total += len(held)
	}
	if total != ticks {
		t.Fatalf("granted %d powerups across the room, want one per tick = %d", total, ticks)
	}
}

func TestGrantDropsStopsWhenAllCapped(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	r.state.Mode = ModeFrenzy

	// Drive every player to the cap, then keep ticking: no over-cap, no growth.
	capped := len(r.state.Players) * inventoryCap
	for i := 0; i < capped+5; i++ {
		r.grantDrops(PhaseDrawing)
	}
	total := 0
	for name, held := range r.state.Inventory {
		if len(held) != inventoryCap {
			t.Fatalf("%s holds %d, want the cap %d once the room saturates", name, len(held), inventoryCap)
		}
		total += len(held)
	}
	if total != capped {
		t.Fatalf("room holds %d powerups, want the saturated total %d", total, capped)
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

func TestStartPhasePrunesStalePowerups(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := syncRoom(t, names...)
	r.state.Mode = ModeFrenzy

	// During drawing, players hold draw-phase powerups (alice at the cap). These
	// can't fire during guessing and must not linger in the guessing-phase tray,
	// nor eat inventory slots that should fill with guess-phase drops.
	r.state.Inventory = map[string][]Powerup{
		"alice": {PowerFog, PowerLights, PowerCramp},
		"bob":   {PowerFlip},
	}
	for _, n := range names {
		draft(r, n)
	}
	r.advance() // drawing → guessing
	if r.state.Phase != PhaseGuessing {
		t.Fatalf("phase = %q, want guessing", r.state.Phase)
	}

	for name, held := range r.state.Inventory {
		for _, p := range held {
			if powerupCatalog[p].phase != PhaseGuessing {
				t.Fatalf("%s still holds %q after entering guessing — stale powerup not pruned", name, p)
			}
		}
	}
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

func TestFireSkipsLockedDrawers(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := syncRoom(t, names...)
	r.state.Mode = ModeFrenzy
	r.state.Phase = PhaseDrawing
	r.state.Locked = map[string]bool{"bob": true, "carol": true} // only dave still drawing
	r.state.Inventory = map[string][]Powerup{"alice": {PowerFog, PowerFog, PowerFog}}

	// Every hit must land on dave — the locked-in rivals are done and skipped.
	for i := 0; i < 3; i++ {
		r.handle(Command{Kind: CmdFirePowerup, Player: "alice", PowerupID: string(PowerFog)})
	}
	for victim := range r.state.Effects {
		if victim != "dave" {
			t.Fatalf("fog landed on %q, want only the unlocked drawer dave", victim)
		}
	}
	if len(r.state.Effects["dave"]) == 0 {
		t.Fatal("dave (unlocked) should have been hit")
	}
}

func TestFireNoOpWhenAllRivalsLocked(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	r.state.Mode = ModeFrenzy
	r.state.Phase = PhaseDrawing
	r.state.Locked = map[string]bool{"bob": true, "carol": true, "dave": true}
	r.state.Inventory = map[string][]Powerup{"alice": {PowerFog}}

	r.handle(Command{Kind: CmdFirePowerup, Player: "alice", PowerupID: string(PowerFog)})

	if len(r.state.Effects) != 0 {
		t.Fatalf("no affectable rival — effect must not land, got %+v", r.state.Effects)
	}
	if len(r.state.Inventory["alice"]) != 1 {
		t.Fatal("powerup must be kept when there's no eligible victim")
	}
}

func TestFireSkipsGuessedAndFeatured(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := frenzyGuessing(t, names...)
	// carol is the artist on show (doesn't guess); bob already guessed. Only dave
	// is still guessing, so every squint must land on dave.
	r.state.Featured = "carol"
	r.state.Guesses = map[string]string{"bob": "x"}
	r.state.Inventory = map[string][]Powerup{"alice": {PowerSquint, PowerSquint}}

	for i := 0; i < 2; i++ {
		r.handle(Command{Kind: CmdFirePowerup, Player: "alice", PowerupID: string(PowerSquint)})
	}
	for victim := range r.state.Effects {
		if victim != "dave" {
			t.Fatalf("squint landed on %q, want only dave (carol=featured, bob=guessed)", victim)
		}
	}
	if len(r.state.Effects["dave"]) == 0 {
		t.Fatal("dave (still guessing) should have been hit")
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
