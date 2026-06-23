package game

import (
	"math/rand/v2"
	"time"
)

// Powerup is a Frenzy sabotage effect. Each belongs to a phase and is only rolled
// during that phase. Every effect is view-only or a brief input lock — it never
// touches stroke data — and self-expires when its wave-stamped EndsAt passes.
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
