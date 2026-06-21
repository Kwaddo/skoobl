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
