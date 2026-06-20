# Points System Redesign — Design

**Date:** 2026-06-20
**Branch:** alimohsen999/sko-9-improve-points-system
**Status:** Approved

## Problem

The current scoring (`backend/internal/game/room.go`, `beginReveal`) gives a flat
`pointsPerCorrect = 100` to every player who correctly identifies the featured
artist. The artist earns nothing, and speed is irrelevant. This is shallow: there
is no tension for the artist, no reward for being decisive, and a correct guess at
the buzzer is worth the same as an instant one.

## Goals

- The featured artist holds a **pot** that guessers chip away by identifying them:
  everyone IDs them → 0, nobody → 100.
- Guessers earn by **speed** of a correct identification.
- Maximize fun and keep the two roles balanced so neither dominates.

## Key Decisions

1. **Equal max, accept luck.** Only one player is featured as artist per round
   (`pickFeatured`), and rounds can be fewer than players, so most players never get
   featured in a given game. Rather than change the featuring flow, both roles are
   capped at **100 per round**: a featured round is worth about the same as a round
   spent guessing, so being picked is roughly score-neutral. Featuring stays partly
   luck, which is accepted.
2. **Linear speed curve with a floor (100 → 50).** A correct guess always pays a
   solid chunk; speed adds the rest. Avoids punishing thoughtful-but-slower players.
3. **Allow guess changes, score the final guess.** Players keep the existing ability
   to change their guess. Speed is scored from the *final* guess's timestamp, so
   flip-flopping or committing late slides the timestamp later and lowers the score —
   preserving a real speed incentive without forcing a one-shot lock. A wrong final
   guess scores 0.

## Scoring Rules

### Artist pot

```
pot = round(100 × (1 − correct / eligible))
```

- `correct` = number of guessers whose **final** guess equals the featured artist
  (the artist themself excluded).
- `eligible` = connected non-artist players at reveal time, unioned with any correct
  guesser who disconnected after guessing (so the pot cannot be gamed by dropping
  the connection after a correct guess).
- Everyone IDs the artist → pot 0. Nobody → pot 100. Linear between. **No floor.**
- Edge: `eligible == 0` → pot = 100 (nobody could identify them).

### Guesser speed points

A **correct** final guess earns on a linear curve across the guess window:

```
guessStart = PhaseEndsAt − GuessMs           // captured before the phase clock resets
f          = clamp((finalGuessTime − guessStart) / GuessMs, 0, 1)
points     = round(100 − 50 × f)             // 100 fastest → 50 at the buzzer
```

- Wrong or no final guess → 0.
- Changing a guess moves `finalGuessTime` later → lower score. That is the speed cost.
- Floor of 50: a correct-but-slow guess still pays; it only loses the speed bonus.

### Coupling

A correct guess both earns the guesser speed points **and** subtracts `100/eligible`
from the artist's pot. Fast identification doubly hurts the artist — swingy and fun.

### Worked examples (4 players: artist A, guessers B/C/D)

- All 3 correct & fast: each ≈ 90–100; pot = 100×(1 − 3/3) = 0.
- Nobody correct: guessers 0; pot = 100.
- 1 of 3 correct & fast: that guesser ≈ 100; pot = 100×(1 − 1/3) ≈ 67.

Over a 3-round game, a never-featured player guessing well every round can reach
≈ 3 × 95 = 285; a featured player gets one artist round (≤ 100) + two guess rounds
(≤ 190) ≈ ≤ 290. Roughly equal — the *equal max, accept luck* intent holds.

## Data Model Changes

All in `GameState` (`backend/internal/game/state.go`); server-side only, redacted
from client views like the other round-secret fields.

- `GuessTimes map[string]int64` — guesser → unix-ms of their latest guess. Written in
  `submitGuess` on every submission; reset each round.
- `LastDeltas map[string]int` — per-player points earned **this round**, set in
  `beginReveal`, cleared on `beginRound`.
- View-only derived field `Player.RoundScore int` — populated by `viewFor` in the
  reveal case from `LastDeltas`, so the UI can show "+72" and the artist's pot.
  Marshals away (`omitempty`) from the persisted snapshot like the other view fields.

## Code Touch Points

All in `backend/internal/game` unless noted.

- **Constants** (`room.go`): repurpose `pointsPerCorrect` → `pointsMax = 100`; add
  `speedSpread = 50`.
- **`submitGuess`** (`room.go`): record `GuessTimes[c.Player] = time.Now().UnixMilli()`
  on every submit; keep the existing change-allowed overwrite of `Guesses`.
- **`beginReveal`** (`room.go`): replace the flat `pointsPerCorrect` loop with the new
  scoring — speed points per correct guesser + artist pot — and populate `LastDeltas`.
  Compute speed scores using the current `PhaseEndsAt`/`GuessMs` **before** calling
  `startPhase(PhaseReveal, 0)` resets the clock.
- **`beginRound`** (`room.go`): initialize/clear `GuessTimes` and `LastDeltas`.
- **`viewFor`** reveal case (`state.go`): populate `Player.RoundScore` from `LastDeltas`.
- **`endGame` / `returnToLobby`** (`room.go`): drop `GuessTimes` and `LastDeltas` with
  the other transient round data.
- **Tests** (`room_test.go`): update for the new scoring (pot math, speed curve,
  change-then-rescore, disconnect edge cases).
- **Frontend** reveal UI (`frontend/src/components/game/`): show the per-round delta
  (`RoundScore`) alongside cumulative score.

## Inherent Note (not a points-system bug)

This game rewards the artist for being *un*recognizable, which can incentivize
generic or low-effort drawing. That is baked into the "guess who drew it" concept and
is not something the points formula fixes — recorded here as a conscious choice.

## Out of Scope

- Changing the featuring flow (one artist per round stays).
- Penalizing wrong guesses.
- Host-tunable point values (the 100 / 50 constants are fixed for now).
