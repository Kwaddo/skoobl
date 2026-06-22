package game

import (
	"fmt"
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
	r.state.Mode = sanitizeMode(cfg.Mode)
}

func (r *Room) startGame() {
	for i := range r.state.Players {
		r.state.Players[i].Score = 0
	}
	r.state.FeaturedPast = nil
	r.promptDeck = nil // fresh shuffle for the new game
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
	r.state.RoundFeatured = nil
	r.state.FeatureIndex = 0
	r.state.FeatureCount = 0
	r.state.DrawIDs = nil
	r.state.Prompt = r.pickPrompt()
	r.startPhase(PhaseDrawing, r.state.DrawMs)
}

// guessesForPlayers decides how many drawings a round guesses through, given the
// room's headcount. Small rooms (≤5) guess 2; every ~3 extra players adds one
// more, so a busier room sees more of everyone's art without dragging the round
// out. Capped at maxFeatures (which, at the room cap, is the natural ceiling).
func guessesForPlayers(players int) int {
	n := 2
	if players > 5 {
		n += (players - 3) / 3 // 6-8→+1, 9-11→+2, 12→+3
	}
	if n > maxFeatures {
		n = maxFeatures
	}
	return n
}

// pickPrompt chooses the single word everyone draws this round, from the custom
// pool if configured, else the built-in pool for the chosen language. Words are
// drawn from a shuffled deck (promptDeck) so none repeats until the whole pool is
// used, then the deck reshuffles. The reshuffle never repeats the previous word
// back-to-back.
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
	if len(r.promptDeck) == 0 {
		r.promptDeck = newPromptDeck(pool, r.state.Prompt)
	}
	// Draw from the end (cheap slice trim).
	last := len(r.promptDeck) - 1
	w := r.promptDeck[last]
	r.promptDeck = r.promptDeck[:last]
	return w
}

// newPromptDeck returns pool shuffled into a fresh deck. Words are drawn from the
// end, so it ensures the last element (the next pick) isn't `avoid` — the
// previous round's prompt — keeping a reshuffle from repeating a word back-to-back.
func newPromptDeck(pool []string, avoid string) []string {
	deck := make([]string, len(pool))
	copy(deck, pool)
	rand.Shuffle(len(deck), func(i, j int) { deck[i], deck[j] = deck[j], deck[i] })
	if n := len(deck); n > 1 && deck[n-1] == avoid {
		deck[n-1], deck[0] = deck[0], deck[n-1]
	}
	return deck
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

// beginGuessing opens the guessing stage once drawing ends. It sizes how many
// drawings this round will guess through — the room's target (guessesForPlayers),
// capped by how many people actually drew — then features the first one.
func (r *Room) beginGuessing() {
	drew := r.drawerCount()
	if drew == 0 {
		// Nobody drew anything this round — there's nothing to guess, so skip
		// straight to the reveal (which shows a "nobody drew" message).
		r.state.FeatureCount = 0
		r.state.FeatureIndex = 0
		r.beginReveal()
		return
	}
	if r.state.Mode == ModeFlipped {
		r.assignDrawIDs()
	}
	// Keep at least two drawers off-screen each round. Once an artist is revealed
	// they're struck from the remaining drawings' guess options (see PlayerStage),
	// so featuring nearly every drawer would make the last "who drew it?" a forced
	// single answer. Leaving a two-drawer margin keeps every guess a real choice.
	// Floored at one so any round with a drawing still guesses at least once.
	maxByDrawers := drew - 2
	if maxByDrawers < 1 {
		maxByDrawers = 1
	}
	r.state.FeatureCount = min(guessesForPlayers(len(r.state.Players)), maxByDrawers)
	r.state.FeatureIndex = 0
	r.beginNextFeature()
}

// beginNextFeature shows the next not-yet-featured drawing of the round and opens
// its own guessing phase (or a solo reveal when only one person drew). Per-feature
// guess data is reset so every drawing is guessed and scored independently — a
// round with K drawings is K back-to-back "who drew this?" rounds over one prompt.
func (r *Room) beginNextFeature() {
	r.state.Featured = r.pickFeatured()
	if r.state.Featured == "" {
		// No fresh drawing left to feature (e.g. a featured drawer left mid-round,
		// dropping the pool below the planned count). The round's guessing is over.
		r.advanceRound()
		return
	}
	r.state.FeatureIndex++
	r.state.RoundFeatured = append(r.state.RoundFeatured, r.state.Featured)
	r.state.Guesses = map[string]string{}
	r.state.GuessTimes = map[string]int64{}
	r.state.LastDeltas = nil
	if r.drawerCount() == 1 {
		// Only one drawing exists all round, so "who drew it?" has a single
		// trivially correct answer. Skip guessing and award the lone artist.
		r.beginSoloReveal()
		return
	}
	r.startPhase(PhaseGuessing, r.state.GuessMs)
}

// advanceAfterReveal moves the room on once the host dismisses a reveal: to the
// next drawing in this round if any remain, otherwise on to the next round / end.
func (r *Room) advanceAfterReveal() {
	if r.state.FeatureIndex < r.state.FeatureCount {
		r.beginNextFeature()
		return
	}
	r.advanceRound()
}

// advanceRound starts the next round, or ends the game after the last one.
func (r *Room) advanceRound() {
	if r.state.Round < r.state.TotalRounds {
		r.beginRound(r.state.Round + 1)
		return
	}
	r.endGame()
}

// assignDrawIDs gives every drawer this round a stable opaque id, used by flipped
// mode to show drawings without revealing who drew which. Regenerated each round
// (cleared in beginRound), so the same drawing keeps its id across a round's
// features but not across rounds.
func (r *Room) assignDrawIDs() {
	ids := make(map[string]string, len(r.state.Players))
	used := map[string]bool{}
	for _, p := range r.state.Players {
		if len(r.state.Drawings[p.Name]) == 0 {
			continue
		}
		id := randDrawID()
		for used[id] {
			id = randDrawID()
		}
		used[id] = true
		ids[p.Name] = id
	}
	r.state.DrawIDs = ids
}

func randDrawID() string {
	return fmt.Sprintf("d%08x", rand.Uint32())
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

// pickFeatured chooses the next artist whose drawing is shown. It only ever
// features a player who actually drew something (a blank canvas can't be guessed)
// and never one already featured this round (so a round never shows the same
// drawing twice), preferring a not-yet-featured-this-game drawer so coverage
// spreads across rounds. Returns "" when no eligible drawing is left.
func (r *Room) pickFeatured() string {
	thisRound := make(map[string]bool, len(r.state.RoundFeatured))
	for _, n := range r.state.RoundFeatured {
		thisRound[n] = true
	}
	past := make(map[string]bool, len(r.state.FeaturedPast))
	for _, n := range r.state.FeaturedPast {
		past[n] = true
	}

	var freshDrew, anyDrew []string
	for _, p := range r.state.Players {
		if len(r.state.Drawings[p.Name]) == 0 {
			continue // never feature an empty canvas
		}
		if thisRound[p.Name] {
			continue // already shown this round — never repeat a drawing
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
	if r.state.Featured != "" && r.state.playerIndex(r.state.Featured) < 0 {
		// The featured artist left mid-guess. Don't reveal a player who's no
		// longer here (and don't score guesses for a spoiled drawing) — move on
		// to the next drawing this round, or end the round if none remain.
		r.state.Featured = ""
		r.advanceAfterReveal()
		return
	}
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
	r.state.RoundFeatured = nil
	r.state.FeatureIndex = 0
	r.state.FeatureCount = 0
	r.state.Inventory = nil
	r.state.Effects = nil
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
	r.state.RoundFeatured = nil
	r.state.FeatureIndex = 0
	r.state.FeatureCount = 0
	r.state.FeaturedPast = nil
	r.state.Inventory = nil
	r.state.Effects = nil
	for i := range r.state.Players {
		r.state.Players[i].Score = 0
	}
}

// startPhase sets the phase, bumps the generation, and arms the advance timer for
// timed phases (durMs > 0). PhaseEndsAt lets clients render a countdown. In
// Frenzy it also clears phase-scoped effects and arms the drop ticker for the
// drawing/guessing phases.
func (r *Room) startPhase(p Phase, durMs int) {
	r.state.Phase = p
	r.phaseGen++
	r.state.Effects = nil // effects are phase-scoped — none carry across a transition
	r.pruneInventory(p)   // powerups are phase-scoped too — drop any not fireable in p
	if durMs > 0 {
		d := time.Duration(durMs) * time.Millisecond
		r.state.PhaseEndsAt = time.Now().Add(d).UnixMilli()
		r.armAdvance(r.phaseGen, d)
	} else {
		r.state.PhaseEndsAt = 0
	}
	if r.state.Mode == ModeFrenzy && (p == PhaseDrawing || p == PhaseGuessing) {
		r.armDrop(r.phaseGen, dropInterval)
	}
}
