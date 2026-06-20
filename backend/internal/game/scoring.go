package game

import "math"

// speedScore converts a correct guess's timestamp into points on a linear curve
// across the guess window: pointsMax for an instant guess down to
// pointsMax-speedSpread at the buzzer. Call it during beginReveal, before
// startPhase resets the phase clock. Timestamps outside the window are clamped.
func (r *Room) speedScore(guessedAt int64) int {
	if r.state.GuessMs <= 0 {
		return pointsMax
	}
	start := r.state.PhaseEndsAt - int64(r.state.GuessMs)
	f := float64(guessedAt-start) / float64(r.state.GuessMs)
	f = clampF(f, 0, 1)
	return int(math.Round(float64(pointsMax) - float64(speedSpread)*f))
}

// artistPot is the featured artist's round score: the full pot when nobody
// identifies them, zero when everyone does, linear between. eligible is the count
// of players who could have identified them.
func artistPot(correct, eligible int) int {
	if eligible <= 0 {
		return pointsMax
	}
	return int(math.Round(float64(pointsMax) * (1 - float64(correct)/float64(eligible))))
}
