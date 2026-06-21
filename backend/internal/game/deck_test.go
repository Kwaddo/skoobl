package game

import "testing"

// drawN simulates n rounds of prompt selection, mirroring beginRound's
// `r.state.Prompt = r.pickPrompt()` so the deck's back-to-back guard sees the
// real previous word. pickPrompt only touches r.state and r.promptDeck, so it's
// safe to call without running the room goroutine.
func drawN(r *Room, n int) []string {
	out := make([]string, n)
	for i := 0; i < n; i++ {
		p := r.pickPrompt()
		r.state.Prompt = p
		out[i] = p
	}
	return out
}

// A whole game is at most maxRounds rounds and the builtin pool is far larger,
// so no prompt should ever repeat within a single game. Repeated across many
// fresh games (each reshuffles) to exercise different shuffles.
func TestPromptDeckNoRepeatWithinGame(t *testing.T) {
	for _, lang := range []Language{LangEN, LangAR} {
		for trial := 0; trial < 300; trial++ {
			r := newRoom(GameState{Language: lang})
			seen := map[string]bool{}
			for _, p := range drawN(r, maxRounds) {
				if seen[p] {
					t.Fatalf("lang %s trial %d: %q repeated within a %d-round game", lang, trial, p, maxRounds)
				}
				seen[p] = true
			}
		}
	}
}

// The deck draws every word once before any repeats, then reshuffles — verified
// over many cycles on a small pool so the deck exhausts and refills repeatedly.
// Also asserts no word repeats back-to-back, including across reshuffle seams.
func TestPromptDeckCyclesWithoutRepeats(t *testing.T) {
	pool := []string{"a", "b", "c", "d", "e", "f", "g"}
	r := newRoom(GameState{Categories: pool})

	const cycles = 100
	picks := drawN(r, len(pool)*cycles)

	for c := 0; c < cycles; c++ {
		block := picks[c*len(pool) : (c+1)*len(pool)]
		seen := map[string]bool{}
		for _, p := range block {
			if seen[p] {
				t.Fatalf("cycle %d: %q repeated before the deck was exhausted", c, p)
			}
			seen[p] = true
		}
		if len(seen) != len(pool) {
			t.Fatalf("cycle %d: %d distinct words, want %d (deck dropped or duplicated a word)", c, len(seen), len(pool))
		}
	}

	for i := 1; i < len(picks); i++ {
		if picks[i] == picks[i-1] {
			t.Fatalf("back-to-back repeat %q at round %d (reshuffle seam not guarded)", picks[i], i)
		}
	}
}

// startGame resets the deck so a new game reshuffles instead of continuing the
// previous game's leftover deck.
func TestPromptDeckResetsBetweenGames(t *testing.T) {
	pool := []string{"a", "b", "c", "d", "e", "f", "g"}
	r := newRoom(GameState{Categories: pool})
	drawN(r, 3) // partially drain the deck
	if len(r.promptDeck) == 0 {
		t.Fatal("setup: deck should still have words after 3 of 7 draws")
	}
	r.promptDeck = nil // startGame does this; assert pickPrompt rebuilds a full cycle
	picks := drawN(r, len(pool))
	seen := map[string]bool{}
	for _, p := range picks {
		seen[p] = true
	}
	if len(seen) != len(pool) {
		t.Fatalf("after reset: %d distinct words in one cycle, want %d", len(seen), len(pool))
	}
}
