package game

import "time"

// submitDrawing locks in a player's drawing: stores the strokes and marks them
// locked. When every connected player has locked, the round advances early
// rather than waiting out the timer.
func (r *Room) submitDrawing(c Command) {
	if r.state.Phase != PhaseDrawing || r.state.playerIndex(c.Player) < 0 {
		return
	}
	if r.state.Drawings == nil {
		r.state.Drawings = map[string][]Stroke{}
	}
	if r.state.Locked == nil {
		r.state.Locked = map[string]bool{}
	}
	r.state.Drawings[c.Player] = sanitizeStrokes(c.Strokes)
	r.state.Locked[c.Player] = true
	if r.allLocked() {
		r.beginGuessing() // everyone's in — don't wait out the timer
	}
}

// draftDrawing stores a player's in-progress strokes without locking them in.
// The server always holds the latest draft, so when the drawing timer expires
// nothing is lost — whatever was drawn is kept and treated as the drawing.
func (r *Room) draftDrawing(c Command) {
	if r.state.Phase != PhaseDrawing || r.state.playerIndex(c.Player) < 0 {
		return
	}
	if r.state.Drawings == nil {
		r.state.Drawings = map[string][]Stroke{}
	}
	r.state.Drawings[c.Player] = sanitizeStrokes(c.Strokes)
}

func (r *Room) submitGuess(c Command) {
	if r.state.Phase != PhaseGuessing {
		return
	}
	if r.state.Mode == ModeFlipped {
		// In flipped the client picks a drawing id; resolve it to the owner so the
		// classic scoring path (Guesses[guesser] == Featured) works unchanged.
		owner := r.state.ownerOfDrawID(c.GuessID)
		if owner == "" {
			return // unknown or stale id
		}
		c.Guess = owner
	}
	if c.Player == r.state.Featured { // the target doesn't guess their own drawing
		return
	}
	if r.state.playerIndex(c.Player) < 0 || r.state.playerIndex(c.Guess) < 0 {
		return // unknown guesser, or a guess that isn't a real player
	}
	if r.state.Guesses == nil {
		r.state.Guesses = map[string]string{}
	}
	if r.state.GuessTimes == nil {
		r.state.GuessTimes = map[string]int64{}
	}
	r.state.Guesses[c.Player] = c.Guess
	r.state.GuessTimes[c.Player] = time.Now().UnixMilli()
	if r.allGuessed() {
		r.beginReveal()
	}
}

// allLocked reports whether every connected player has locked in their drawing.
// Disconnected players (in their grace window) don't block the round.
func (r *Room) allLocked() bool {
	for _, p := range r.state.Players {
		if pr, ok := r.present[p.Name]; ok && pr.connected {
			if !r.state.Locked[p.Name] {
				return false
			}
		}
	}
	return true
}

// allGuessed reports whether every connected non-artist player has guessed.
func (r *Room) allGuessed() bool {
	for _, p := range r.state.Players {
		if p.Name == r.state.Featured {
			continue
		}
		if pr, ok := r.present[p.Name]; ok && pr.connected {
			if _, guessed := r.state.Guesses[p.Name]; !guessed {
				return false
			}
		}
	}
	return true
}
