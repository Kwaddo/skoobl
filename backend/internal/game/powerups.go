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
	PowerSquint    Powerup = "squint"    // blur the drawing/options on show
	PowerCurtain   Powerup = "curtain"   // hide the options behind a curtain
	PowerShuffle   Powerup = "shuffle"   // jumble the guess options' order
	PowerHideNames Powerup = "hidenames" // mask the guess options' names + avatars
)

// tier is an effect's severity. A player's per-wave roll draws from a tier chosen
// by phase progress (mild early, harsh near the buzzer) but jittered per player,
// so at any instant the room shows a spread of severities rather than one shared
// level.
type tier int

const (
	tierMild tier = iota
	tierMedium
	tierHarsh
)

const (
	// waveHitChance is the odds a given affectable player is caught by a wave at
	// all (the wave always bites at least one guaranteed victim regardless). Below
	// 1 so some players get a breather while others get slammed on the same beat —
	// the room never shares one synchronized handicap.
	waveHitChance = 0.8
	// maxStaggerMs is the largest delay between a wave firing and a victim's effect
	// actually striking. Each victim rolls its own offset in [0, maxStaggerMs), so
	// the hit lands at an unpredictable moment instead of the instant the wave
	// fires — you never see it coming.
	maxStaggerMs = 2400
	// tierSlipPct / tierSpikePct are the per-player odds of slipping one tier
	// milder (a lucky break) or spiking one tier harsher than the progress
	// baseline.
	tierSlipPct  = 22
	tierSpikePct = 22
	// Per-player draw-effect lifetime band: punchy hits, not a steady cover.
	drawEffectMinMs = 2000
	drawEffectMaxMs = 4500
)

// Per-phase severity tiers.
//
// Drawing escalates fog → flip → lights/cramp. Guessing sticks to the two
// effects that obscure WHO without making the drawing itself unreadable —
// hidenames (scribble out the roster) and shuffle (jumble the order). Blur
// (squint) and the curtain cover are deliberately kept out of guessing: they
// hide the thing you're trying to read rather than the answer, which is just
// frustrating. (PowerSquint/Curtain stay defined and rendered for completeness,
// but no wave rolls them.)
var (
	drawTiers = [3][]Powerup{
		tierMild:   {PowerFog},
		tierMedium: {PowerFlip},
		tierHarsh:  {PowerLights, PowerCramp},
	}
	guessTiers = [3][]Powerup{
		tierMild:   {PowerShuffle, PowerHideNames},
		tierMedium: {PowerHideNames, PowerShuffle},
		tierHarsh:  {PowerHideNames, PowerShuffle},
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

// tierForProgress is the room's baseline severity tier at phase progress p (0 =
// phase start, 1 = buzzer). Mild early, harsh near the end.
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

// tierForPlayer rolls one player's severity around the progress baseline: usually
// the baseline, but with a chance to slip one tier milder or spike one harsher.
// This is what makes a single wave hit different players at different severities.
func tierForPlayer(progress float64) tier {
	t := int(tierForProgress(progress))
	switch roll := rand.IntN(100); {
	case roll < tierSlipPct && t > int(tierMild):
		t--
	case roll >= 100-tierSpikePct && t < int(tierHarsh):
		t++
	}
	return tier(t)
}

// effectForPlayer rolls one player's effect for a wave: a jittered tier, then a
// random effect from that tier. ok is false for phases with no tiers.
func effectForPlayer(phase Phase, progress float64) (Powerup, bool) {
	tiers, ok := tiersForPhase(phase)
	if !ok {
		return "", false
	}
	pool := tiers[tierForPlayer(progress)]
	if len(pool) == 0 {
		return "", false
	}
	return pool[rand.IntN(len(pool))], true
}

// guessWaveDuration returns a short, randomized lifetime for a guessing-phase
// scribble — a flash that comes and goes rather than a steady cover. The upper
// bound is ~12% of the configured vote length (so the 25s default tops out near
// 3s, a long vote lingers a touch more, a short vote less), clamped to a sane
// band; each wave then picks a random hold between ~40% of that cap and the cap,
// so some are a quick blink and some hold for the full beat.
func guessWaveDuration(guessMs int) time.Duration {
	capMs := clamp(guessMs*12/100, 1500, 5000)
	minMs := capMs * 40 / 100
	durMs := minMs + rand.IntN(capMs-minMs+1)
	return time.Duration(durMs) * time.Millisecond
}

// effectLifetime is how long one player's freshly-rolled effect lasts. Guessing
// flashes scale with the vote length; drawing effects pick from a punchy band.
func effectLifetime(phase Phase, durMs int) time.Duration {
	if phase == PhaseGuessing {
		return guessWaveDuration(durMs)
	}
	ms := drawEffectMinMs + rand.IntN(drawEffectMaxMs-drawEffectMinMs+1)
	return time.Duration(ms) * time.Millisecond
}

// applyEffectWave rolls a fresh, INDEPENDENT effect for each affectable player —
// different kind, different severity (tierForPlayer), different strike time
// (staggered StartsAt), different lifetime — so no two players share one
// synchronized handicap. Not everyone is caught every wave (waveHitChance), but
// at least one guaranteed victim always is. Players spared this wave keep any
// still-live effect they already have (carry-forward), so a fast follow-up wave
// can't wipe a hit that hasn't even struck yet. A no-op when the phase has no
// tiers or no one is affectable.
func (r *Room) applyEffectWave(phase Phase, progress float64) {
	if _, ok := tiersForPhase(phase); !ok {
		return
	}
	now := time.Now().UnixMilli()
	durMs := r.phaseDurationMs()

	// Carry forward the still-live effects of anyone we don't re-roll below.
	next := map[string][]ActiveEffect{}
	for name, effs := range r.state.Effects {
		if !r.affectable(name) {
			continue
		}
		if live := activeEffects(effs, now); len(live) > 0 {
			next[name] = live
		}
	}

	var victims []string
	for _, p := range r.state.Players {
		pr, ok := r.present[p.Name]
		if !ok || !pr.connected {
			continue
		}
		// affectable already exempts locked-in drawers / the featured artist /
		// already-guessed players — committing early is the grace that spares you.
		if !r.affectable(p.Name) {
			continue
		}
		victims = append(victims, p.Name)
	}
	if len(victims) == 0 {
		return
	}

	// Guarantee the wave bites someone; everyone else rolls their own luck.
	forced := victims[rand.IntN(len(victims))]
	for _, name := range victims {
		if name != forced && rand.Float64() > waveHitChance {
			continue // spared — keeps any carried-forward effect
		}
		kind, ok := effectForPlayer(phase, progress)
		if !ok {
			continue
		}
		// Flipped guessing shows anonymous doodles, not a named roster, so
		// hidenames has nothing to scribble — swap it for a shuffle (jumble the
		// candidate grid) so the hit always actually bites.
		if kind == PowerHideNames && phase == PhaseGuessing && r.state.Mode == ModeFlipped {
			kind = PowerShuffle
		}
		startsAt := now + int64(rand.IntN(maxStaggerMs))
		endsAt := startsAt + effectLifetime(phase, durMs).Milliseconds()
		// A fresh roll replaces this player's slot (effects never stack).
		next[name] = []ActiveEffect{{Kind: kind, StartsAt: startsAt, EndsAt: endsAt}}
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

// activeEffects returns the still-live effects (EndsAt strictly after now). A
// not-yet-struck effect (StartsAt in the future) is still "live" here — it must
// reach the client so the client can begin it when its StartsAt passes; the
// client gates on StartsAt locally.
func activeEffects(effects []ActiveEffect, now int64) []ActiveEffect {
	var live []ActiveEffect
	for _, e := range effects {
		if e.EndsAt > now {
			live = append(live, e)
		}
	}
	return live
}
