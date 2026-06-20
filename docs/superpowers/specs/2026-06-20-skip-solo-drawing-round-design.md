# Skip Guessing When Only One Drawing — Design

**Date:** 2026-06-20
**Status:** Approved (design); spec pending user review

## Problem

The game's guessing phase asks "who drew this?" — but a guesser only ever sees
players who actually drew something as options (`PlayerGuessing`,
`PlayerStage.tsx:155`, `options = players.filter(p => p.name !== name && p.hasDrawn)`).

When exactly **one** player drew a non-empty drawing, every non-artist's option
list collapses to a single choice: the lone artist. The guess is trivially
correct. Worse, the scoring then *punishes* the artist: `artistPot(correct, eligible)`
returns `pointsMax * (1 - correct/eligible)`, which trends to **0** as everyone
trivially identifies them (`scoring.go:22`). The one person who bothered to draw
gets nothing, while the trivial guessers collect speed points.

## Goal

When only one drawing is present, skip the meaningless guessing phase and award
the lone artist a fixed reward, then reveal as normal.

## Decisions (from brainstorming)

- **Award = half pot** (`pointsMax / 2` = 50). Partial credit: they made art, but
  faced no real guessing challenge.
- **Flow = show reveal, host advances.** Drawing → reveal directly. The round still
  counts toward `TotalRounds`; the host taps Next like any other round. The host-TV
  gallery and scoreboard render normally (one tile, one delta).
- **Reuse existing reveal** — no frontend changes. The lone artist sees "That was
  your drawing! +50"; other players see the standard reveal. This is a
  **backend-only** change.

## Scope of change

Backend only, within `backend/internal/game`. No protocol, socket, or frontend
changes. The reveal phase already renders correctly from `LastDeltas`, `Featured`,
`Gallery`, and per-player `Correct`/`RoundScore` view flags.

## Design

### Chokepoint

`beginGuessing` (`rounds.go:76`) is the single function both round-advance routes
flow through:

- early-advance: `submitDrawing` → `allLocked()` → `beginGuessing` (`actions.go:21`)
- timer expiry: `advance()` (drawing case) → `beginGuessing` (`rounds.go:69`)

So one check there covers both routes.

```
beginGuessing():
  Featured = pickFeatured()
  if Featured == "":      beginReveal()      // 0 drawings — existing "nobody drew"
  if drawerCount() == 1:  beginSoloReveal()  // NEW — 1 drawing, skip guessing
  else:                   startPhase(Guessing, GuessMs)
```

`pickFeatured` already returns the single drawer when only one drew, so `Featured`
is correct before the `drawerCount()` check.

### New pieces (`rounds.go`)

- **`const soloPot = pointsMax / 2`** — the lone artist's fixed award (50).
- **`drawerCount() int`** — number of players with a non-empty drawing this round
  (`len(r.state.Drawings[p.Name]) > 0`). "One drawing present" = exactly one
  non-empty drawing; empty lock-ins do not count, matching `pickFeatured`'s
  "never feature an empty canvas" rule.
- **`beginSoloReveal()`** — the single-drawing path:
  - add `soloPot` to the featured artist's `Score`;
  - set `LastDeltas = {Featured: soloPot}` (no guesser scoring — nobody guessed);
  - append `Featured` to `FeaturedPast` (consistent with `beginReveal`, spreads
    featured coverage across rounds);
  - `startPhase(PhaseReveal, 0)` (untimed reveal, host-advanced).

### Behavior table

| Non-empty drawings | Path | Result |
|---|---|---|
| 0 | `beginReveal` (existing) | `Featured == ""`, "nobody drew" reveal, no scoring |
| 1 | `beginSoloReveal` (new) | skip guessing, artist `+50`, reveal |
| 2+ | `startPhase(Guessing)` (existing) | normal guessing → `beginReveal` |

Empty lock-in + one real drawing → counts as one drawer → solo path.

## Testing (`room_test.go`)

- **Solo skip:** set up a round where exactly one player has a non-empty drawing,
  trigger `beginGuessing` (via timer-advance or all-locked); assert
  `Phase == PhaseReveal` (not `PhaseGuessing`), the artist's `Score`/`LastDeltas`
  gained `soloPot` (50), every other player's delta is 0, and `FeaturedPast`
  contains the artist.
- **Two drawings still guess:** two non-empty drawings → `beginGuessing` enters
  `PhaseGuessing` (unchanged).
- **Empty lock-in ignored:** one real drawing plus a player who locked an empty
  canvas → `drawerCount() == 1` → solo path.
- **Zero drawings unchanged:** no drawings → existing nobody-drew reveal,
  `Featured == ""`, no scoring.

## Out of scope

- Frontend changes — the reveal reuses the existing rendering.
- Special reveal messaging for the auto-award (a non-artist may still see the
  standard "not this time" framing; accepted to keep the change backend-only).
- Changing the normal multi-drawing scoring, `pickFeatured`, or the phase flow.
- Configurable solo award amount — fixed at half pot.
