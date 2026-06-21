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
