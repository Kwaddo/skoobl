package game

import (
	"math/rand/v2"
	"time"
)

func (r *Room) applyConfig(cfg Config) {
	r.state.TotalRounds = clamp(cfg.Rounds, minRounds, maxRounds)
	if cfg.Language == LangAR {
		r.state.Language = LangAR
	} else {
		r.state.Language = LangEN
	}
	r.state.DrawMs = clamp(cfg.DrawMs, minDrawMs, maxDrawMs)
	r.state.GuessMs = clamp(cfg.GuessMs, minGuessMs, maxGuessMs)
	r.state.Categories = sanitizeCategories(cfg.Categories)
}

func (r *Room) startGame() {
	for i := range r.state.Players {
		r.state.Players[i].Score = 0
	}
	r.state.FeaturedPast = nil
	r.beginRound(1)
}

// beginRound resets per-round data, picks the universal prompt everyone draws,
// and opens the drawing phase.
func (r *Room) beginRound(n int) {
	r.state.Round = n
	r.state.Drawings = map[string][]Stroke{}
	r.state.Locked = map[string]bool{}
	r.state.Guesses = map[string]string{}
	r.state.GuessTimes = map[string]int64{}
	r.state.LastDeltas = nil
	r.state.Featured = ""
	r.state.Prompt = r.pickPrompt()
	r.startPhase(PhaseDrawing, r.state.DrawMs)
}

// pickPrompt chooses the single word everyone draws this round, from the custom
// pool if configured, else the built-in pool for the chosen language. It avoids
// immediately repeating the previous round's word when the pool allows.
func (r *Room) pickPrompt() string {
	pool := r.state.Categories
	if len(pool) == 0 {
		pool = builtinPool(r.state.Language)
	}
	switch len(pool) {
	case 0:
		return "anything"
	case 1:
		return pool[0]
	}
	prev := r.state.Prompt
	for i := 0; i < 5; i++ {
		if w := pool[rand.IntN(len(pool))]; w != prev {
			return w
		}
	}
	return pool[rand.IntN(len(pool))]
}

// advance is the timer-driven transition: drawing → guessing → reveal. Reveal is
// host-driven (no timer), so it isn't handled here.
func (r *Room) advance() {
	switch r.state.Phase {
	case PhaseDrawing:
		r.beginGuessing()
	case PhaseGuessing:
		r.beginReveal()
	}
}

func (r *Room) beginGuessing() {
	r.state.Featured = r.pickFeatured()
	if r.state.Featured == "" {
		// Nobody drew anything this round — there's nothing to guess, so skip
		// straight to the reveal (which shows a "nobody drew" message).
		r.beginReveal()
		return
	}
	if r.drawerCount() == 1 {
		// Only one drawing exists, so "who drew it?" has a single trivially
		// correct answer. Skip the guessing phase and award the lone artist.
		r.beginSoloReveal()
		return
	}
	r.startPhase(PhaseGuessing, r.state.GuessMs)
}

// drawerCount returns how many players drew something non-empty this round. An
// empty lock-in does not count — it can be neither featured nor guessed.
func (r *Room) drawerCount() int {
	n := 0
	for _, p := range r.state.Players {
		if len(r.state.Drawings[p.Name]) > 0 {
			n++
		}
	}
	return n
}

// beginSoloReveal handles the single-drawing case: skip the guessing phase,
// award the lone featured artist a fixed half-pot (no guesser scores, since
// nobody guessed), record the per-round delta, and open the host-advanced
// reveal. Mirrors beginReveal's FeaturedPast bookkeeping so featured coverage
// still spreads across rounds.
func (r *Room) beginSoloReveal() {
	deltas := map[string]int{}
	if i := r.state.playerIndex(r.state.Featured); i >= 0 {
		r.state.Players[i].Score += soloPot
		deltas[r.state.Featured] += soloPot
	}
	r.state.FeaturedPast = append(r.state.FeaturedPast, r.state.Featured)
	r.state.LastDeltas = deltas
	r.startPhase(PhaseReveal, 0)
}

// pickFeatured chooses the single artist whose drawing is shown this round. It
// only ever features a player who actually drew something (a blank canvas can't
// be guessed), preferring a not-yet-featured drawer so coverage spreads across
// rounds. Returns "" when nobody drew anything.
func (r *Room) pickFeatured() string {
	past := make(map[string]bool, len(r.state.FeaturedPast))
	for _, n := range r.state.FeaturedPast {
		past[n] = true
	}

	var freshDrew, anyDrew []string
	for _, p := range r.state.Players {
		if len(r.state.Drawings[p.Name]) == 0 {
			continue // never feature an empty canvas
		}
		anyDrew = append(anyDrew, p.Name)
		if !past[p.Name] {
			freshDrew = append(freshDrew, p.Name)
		}
	}
	for _, pick := range [][]string{freshDrew, anyDrew} {
		if len(pick) > 0 {
			return pick[rand.IntN(len(pick))]
		}
	}
	return ""
}

// beginReveal scores the round and opens the host-advanced reveal phase. Correct
// guessers earn speed points (faster = more); the featured artist earns a pot that
// shrinks with each player who identifies them. Scores are computed before
// startPhase resets the clock, so speedScore reads the live guess window.
func (r *Room) beginReveal() {
	var deltas map[string]int
	if r.state.Featured != "" {
		deltas = map[string]int{}
		// eligible = everyone who could have identified the artist: connected
		// non-artists, unioned with any correct guesser who dropped after guessing
		// (so a correct guess can't be erased by disconnecting).
		eligible := map[string]bool{}
		for _, p := range r.state.Players {
			if p.Name == r.state.Featured {
				continue
			}
			if pr, ok := r.present[p.Name]; ok && pr.connected {
				eligible[p.Name] = true
			}
		}
		correct := 0
		for guesser, guess := range r.state.Guesses {
			if guesser == r.state.Featured || guess != r.state.Featured {
				continue
			}
			correct++
			eligible[guesser] = true
			ts, ok := r.state.GuessTimes[guesser]
			if !ok {
				ts = r.state.PhaseEndsAt // no recorded time (e.g. restored mid-round) → score as the buzzer
			}
			if i := r.state.playerIndex(guesser); i >= 0 {
				pts := r.speedScore(ts)
				r.state.Players[i].Score += pts
				deltas[guesser] += pts
			}
		}
		pot := artistPot(correct, len(eligible))
		if i := r.state.playerIndex(r.state.Featured); i >= 0 {
			r.state.Players[i].Score += pot
			deltas[r.state.Featured] += pot
		}
		r.state.FeaturedPast = append(r.state.FeaturedPast, r.state.Featured)
	}
	r.state.LastDeltas = deltas
	r.startPhase(PhaseReveal, 0)
}

func (r *Room) endGame() {
	r.phaseGen++
	r.state.Phase = PhaseEnded
	r.state.PhaseEndsAt = 0
	// Drop transient round data so the final scoreboard view carries no leftovers.
	r.state.Prompt = ""
	r.state.Drawings = nil
	r.state.Locked = nil
	r.state.Guesses = nil
	r.state.GuessTimes = nil
	r.state.LastDeltas = nil
	r.state.Featured = ""
}

// returnToLobby sends a finished game back to the lobby for a fresh round,
// keeping the players, host, and configured settings but zeroing scores and
// clearing all round data. Lets a group play again without re-joining.
func (r *Room) returnToLobby() {
	r.phaseGen++
	r.state.Phase = PhaseLobby
	r.state.Round = 0
	r.state.PhaseEndsAt = 0
	r.state.Prompt = ""
	r.state.Drawings = nil
	r.state.Locked = nil
	r.state.Guesses = nil
	r.state.GuessTimes = nil
	r.state.LastDeltas = nil
	r.state.Featured = ""
	r.state.FeaturedPast = nil
	for i := range r.state.Players {
		r.state.Players[i].Score = 0
	}
}

// startPhase sets the phase, bumps the generation, and arms the advance timer for
// timed phases (durMs > 0). PhaseEndsAt lets clients render a countdown.
func (r *Room) startPhase(p Phase, durMs int) {
	r.state.Phase = p
	r.phaseGen++
	if durMs > 0 {
		d := time.Duration(durMs) * time.Millisecond
		r.state.PhaseEndsAt = time.Now().Add(d).UnixMilli()
		r.armAdvance(r.phaseGen, d)
	} else {
		r.state.PhaseEndsAt = 0
	}
}
