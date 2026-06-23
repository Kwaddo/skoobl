# Whose Doodle (Flipped Mode) — Design

**Date:** 2026-06-22
**Status:** Approved (design); spec pending user review

## Problem / Goal

Skoobl has one round shape: everyone draws a universal prompt, then one drawing
is featured and players guess **who drew it**. "Whose Doodle" adds a flipped
variant of that guess: instead of being shown a drawing and naming the artist,
you are named a **target player** and pick **which of the drawings is theirs**.

The drawing phase is unchanged; only the guess inverts. This is a redaction +
scoring variant, not a new loop — it reuses the entire round engine.

This spec also introduces the **game-mode foundation** shared by all non-classic
modes (Whose Doodle ships it; [Frenzy](2026-06-22-frenzy-mode-design.md) reuses
it).

## Shared foundation: game modes

A new `Mode` is added to the host-tunable `Config`, alongside `Rounds`,
`Language`, `Categories`, `DrawMs`, `GuessMs`.

```go
type Mode string

const (
    ModeClassic Mode = "classic" // current behavior; the default
    ModeFlipped Mode = "flipped" // Whose Doodle
    ModeFrenzy  Mode = "frenzy"  // separate spec
)
```

- `Config.Mode Mode` (JSON `mode`); `GameState.Mode Mode` (public, echoed to all
  clients so the UI can branch).
- `applyConfig` validates/stores it (unknown ⇒ `ModeClassic`); `newGameState`
  defaults to `ModeClassic`.
- Lobby selector in `HostConfig.tsx` (a segmented control like Language), sent via
  the existing `configure` event. Changing mode is lobby-only, like every other
  setting.
- `viewFor` copies `Mode` into every projection.

**Invariant:** classic is the default and its behavior is byte-for-byte
unchanged. Mode only ever *adds* branches; it never alters the classic path.

## Round engine reuse (no changes)

The whole engine is mode-agnostic and is reused as-is:

- `beginRound` / `beginGuessing` / `beginNextFeature` / `pickFeatured` /
  `advanceAfterReveal` / `advanceRound`.
- `FeatureCount = min(guessesForPlayers(players), max(1, drew-2))` — the
  two-drawer margin and per-player feature scaling carry over unchanged.
- `RoundFeatured` (never repeat a drawing this round), `FeaturedPast` (spread
  coverage across the game), and the `Revealed` list (already-revealed
  participants struck from the options) all apply identically.
- Solo path, "nobody drew" path, and "featured participant left mid-feature"
  skip all behave the same.

"Featured" already means "the participant on the spot." Classic hides their
identity and shows their drawing; flipped shows their identity and hides which
drawing is theirs. Same pick logic either way.

## What differs in Flipped

The only divergence is **what the guesser sees** and **how a correct guess is
resolved** — both isolated to `viewFor` (guessing) and the guess-scoring step.

### Anonymized drawing pool (the one new concept)

The guesser must see the candidate drawings **without** learning who drew each.
The same drawing also needs a **stable id across the round** so the grid does not
reshuffle identities between features.

- On entering the round's guessing, the server assigns each drawer a **per-round
  random opaque id** (a `map[string]string` name→id, regenerated per round, never
  reused, never sent name-paired).
- `viewFor` (PhaseGuessing, flipped) sends:
  - the **target name** (the current `Featured`), shown plainly, and
  - `pool []{ id, strokes }` — every drawer's drawing whose owner has **not** yet
    been revealed this round (i.e. excluding `Revealed` targets), keyed by opaque
    id, in a stable order.
  - It does **not** send which id belongs to the target.
- `YouAreTarget = (name == Featured)` replaces the classic `YouAreArtist`. The
  target sits out their own feature (same as the featured artist sits out
  guessing in classic).

The guess command carries the **chosen id**; the server maps id→name to score.
Ids are per-round and carry no name information, so the pool leaks nothing.

### Scoring (mirror of classic)

`beginReveal`'s math is reused verbatim. The only change is how "correct" is
computed:

- Classic: correct ⇔ `Guesses[guesser] == Featured`.
- Flipped: correct ⇔ `ownerOf(pickedId[guesser]) == Featured`.

Resolve each guesser's picked id to its owner, then run the **identical**
speed-points + shrinking artist-pot logic:

- correct matchers earn speed points (faster = more, via `speedScore`);
- the **target** earns a pot that shrinks as more players correctly spot their
  drawing (`artistPot`), so a hard-to-recognize style pays off.

This keeps a Whose Doodle round worth the same as a classic round.

## Frontend

- **`protocol.ts` / `store.ts`:** add `mode`; in the guessing view add
  `youAreTarget` and `pool: { id: string; strokes: Stroke[] }[]`; the guess
  action sends an id instead of a name.
- **`PlayerStage` (guessing):** when `mode === "flipped"`, replace the
  name-button list with a **doodle grid** — each cell renders a pool drawing via
  `StrokesView`; header reads "Which doodle is **<target>**'s?"; tapping a cell
  submits its id. The target sees a "sit tight — they're guessing yours" panel.
- **`HostStage` (guessing, TV):** show the target name + the doodle grid (read
  only). The reveal highlights the correct cell.
- **`PlayerReveal` / host reveal:** show "it was **this** one" highlighting the
  target's drawing; reuse existing per-round score deltas.
- Revealed targets' drawings drop from the grid on later features (the pool
  already excludes them server-side).

## Edge cases (handled by the shared engine)

- Nobody drew → "no drawing" reveal (unchanged).
- One drawer → solo path (only one doodle; trivial — solo award, unchanged).
- Target leaves mid-feature → existing "featured participant left" skip fires.
- Reconnect mid-guess → `viewFor` rebuilds the pool with the same per-round ids.

## Testing

- **Foundation:** `configure` round-trips `mode`; unknown mode ⇒ classic; classic
  path unchanged (existing tests stay green).
- **Redaction:** flipped guessing view sends the target name + an anonymized pool
  and never sends which id is the target's; ids carry no name.
- **Scoring parity:** a correct id-pick scores identically to a classic correct
  guess (same deltas for matchers and the target pot).
- **Revealed removal:** once a target is revealed, their drawing is absent from
  later features' pools.
- **Stable ids:** the same drawing keeps its id across a round's features.

## Out of scope

- Frenzy powerups (separate spec).
- Changing the drawing phase, timers, prompt selection, or lobby/lifecycle.
- Per-mode custom scoring beyond the classic mirror.
