package game

import (
	"math/rand/v2"
	"time"
)

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
	PowerSquint    Powerup = "squint"    // blur the drawing(s) on show
	PowerCurtain   Powerup = "curtain"   // hide the drawing behind a curtain
	PowerShuffle   Powerup = "shuffle"   // jumble the guess options' order
	PowerHideNames Powerup = "hidenames" // mask the guess options' names + avatars
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
	PowerSquint:    {PhaseGuessing, 3000},
	PowerCurtain:   {PhaseGuessing, 2000},
	PowerShuffle:   {PhaseGuessing, 2000},
	PowerHideNames: {PhaseGuessing, 3000},
}

// Explicit per-phase pools (deterministic order, unlike map iteration) used by
// the drop ticker to pick what to hand out.
var (
	drawPowerups  = []Powerup{PowerFog, PowerLights, PowerFlip, PowerCramp}
	guessPowerups = []Powerup{PowerSquint, PowerCurtain, PowerShuffle, PowerHideNames}
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

// pruneInventory drops every held powerup not fireable in phase p, so a player
// only ever sees (and can only fire) powerups for the current phase. Without this
// a leftover draw-phase item would clutter the guessing tray, fail to fire, and
// occupy a slot that should fill with a guess-phase drop. Phases with no pool
// (reveal/lobby) clear the inventory entirely.
func (r *Room) pruneInventory(p Phase) {
	if len(r.state.Inventory) == 0 {
		return
	}
	valid := map[Powerup]bool{}
	for _, pw := range powerupsForPhase(p) {
		valid[pw] = true
	}
	for name, held := range r.state.Inventory {
		kept := held[:0]
		for _, pw := range held {
			if valid[pw] {
				kept = append(kept, pw)
			}
		}
		if len(kept) == 0 {
			delete(r.state.Inventory, name)
			continue
		}
		r.state.Inventory[name] = kept
	}
}

// grantDrops hands a single random powerup to one random connected player who is
// under the cap. Only one player is armed per tick (not the whole room), so
// arsenals build slowly and the recipient varies tick to tick — powerups stay
// scarce and unpredictable. A no-op when nobody is eligible (all capped or
// disconnected) or the phase has no pool.
func (r *Room) grantDrops(phase Phase) {
	pool := powerupsForPhase(phase)
	if len(pool) == 0 {
		return
	}
	if r.state.Inventory == nil {
		r.state.Inventory = map[string][]Powerup{}
	}
	var eligible []string
	for _, p := range r.state.Players {
		pr, ok := r.present[p.Name]
		if !ok || !pr.connected {
			continue
		}
		if len(r.state.Inventory[p.Name]) >= inventoryCap {
			continue
		}
		eligible = append(eligible, p.Name)
	}
	if len(eligible) == 0 {
		return
	}
	name := eligible[rand.IntN(len(eligible))]
	r.state.Inventory[name] = append(r.state.Inventory[name], pool[rand.IntN(len(pool))])
}

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
	victim := r.randomVictim(c.Player)
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

// randomVictim returns a random connected rival who can still feel an effect this
// phase, or "" if none. A player who already locked in their drawing (or already
// guessed / is the featured artist) is done for the phase, so firing at them just
// wastes the powerup — they're skipped so the hit always lands on someone active.
func (r *Room) randomVictim(self string) string {
	var rivals []string
	for _, p := range r.state.Players {
		if p.Name == self {
			continue
		}
		pr, ok := r.present[p.Name]
		if !ok || !pr.connected {
			continue
		}
		if !r.affectable(p.Name) {
			continue
		}
		rivals = append(rivals, p.Name)
	}
	if len(rivals) == 0 {
		return ""
	}
	return rivals[rand.IntN(len(rivals))]
}

// affectable reports whether a powerup fired now would actually disrupt name in
// the current phase. While drawing, a locked-in player has nothing left to
// sabotage; while guessing, the featured artist doesn't guess and a player who
// already guessed is done.
func (r *Room) affectable(name string) bool {
	switch r.state.Phase {
	case PhaseDrawing:
		return !r.state.Locked[name]
	case PhaseGuessing:
		if name == r.state.Featured {
			return false
		}
		_, guessed := r.state.Guesses[name]
		return !guessed
	default:
		return false
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
