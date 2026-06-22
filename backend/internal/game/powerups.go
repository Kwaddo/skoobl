package game

import (
	"math/rand/v2"
	"time"
)

// Powerup is a Frenzy sabotage effect. Each belongs to a phase and is only rolled
// during that phase. Every effect is view-only or a brief input lock — it never
// touches stroke data — and self-expires after effectDurationMs.
type Powerup string

const (
	// Draw-phase effects (sabotage while the victim draws).
	PowerFog    Powerup = "fog"    // cloud the victim's canvas view
	PowerLights Powerup = "lights" // black the canvas out entirely (can't draw)
	PowerFlip   Powerup = "flip"   // rotate the canvas view 180°
	PowerCramp  Powerup = "cramp"  // block drawing input briefly

	// Guess-phase effects (disrupt the victim's guessing).
	PowerSquint    Powerup = "squint"    // blur the drawing(s) on show
	PowerCurtain   Powerup = "curtain"   // hide the drawing behind a curtain
	PowerShuffle   Powerup = "shuffle"   // jumble the guess options' order
	PowerHideNames Powerup = "hidenames" // mask the guess options' names + avatars
)

// Per-phase effect pools (deterministic order, unlike map iteration) the wave
// ticker draws from when rolling each player's effect.
var (
	drawPowerups  = []Powerup{PowerFog, PowerLights, PowerFlip, PowerCramp}
	guessPowerups = []Powerup{PowerSquint, PowerCurtain, PowerShuffle, PowerHideNames}
)

// powerupsForPhase lists the effects that can be rolled in a phase.
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

// applyEffectWave inflicts one random effect on every connected, affectable
// player at once — the whole room is sabotaged on the same beat. Each player
// rolls their own effect (they don't all get the same one), every effect starts
// now and lasts effectDurationMs. A no-op when the phase has no pool. The wave
// replaces any prior effects (the previous wave's are already expired — see
// effectInterval vs effectDurationMs), so there is no stacking.
func (r *Room) applyEffectWave(phase Phase) {
	pool := powerupsForPhase(phase)
	if len(pool) == 0 {
		return
	}
	endsAt := time.Now().Add(effectDurationMs * time.Millisecond).UnixMilli()
	next := map[string][]ActiveEffect{}
	for _, p := range r.state.Players {
		pr, ok := r.present[p.Name]
		if !ok || !pr.connected {
			continue
		}
		if !r.affectable(p.Name) {
			continue
		}
		next[p.Name] = []ActiveEffect{{
			Kind:   pool[rand.IntN(len(pool))],
			EndsAt: endsAt,
		}}
	}
	if len(next) == 0 {
		return
	}
	r.state.Effects = next
}

// affectable reports whether an effect inflicted now would actually disrupt name
// in the current phase. While drawing, a locked-in player has nothing left to
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
