# Frenzy Mode v2 — Chaotic Survival — Design

**Date:** 2026-06-23
**Status:** Approved.
**Supersedes:** the wave model in
[Frenzy Mode](2026-06-22-frenzy-mode-design.md) (the "ambient, per-player random"
waves). Everything that design says about the **safety rule**, the **effect
catalog**, **state/redaction**, **lifetime**, **other-mode isolation**, and the
**frontend layer** still holds. This doc changes only *how a wave chooses and
delivers effects* and *how it escalates over a phase*.

## Why revisit

v1 frenzy is "classic with annoyances": same loop, same scoring, plus random
nuisances. Three problems made it shallow:

1. **No mode identity.** Strip the effects and frenzy *is* classic — no new
   decision for the player.
2. **Per-player RNG is unfair.** A wave rolls a *different* random effect per
   player, so one drawer eats `cramp` (can't draw at all) while another gets `fog`
   (mild) — same round, different difficulty, pure luck.
3. **Flat intensity.** Waves are uniform start to finish, so "frenzy" never
   actually builds.

v2 reframes the mode as **Chaotic Survival**: the whole room weathers the *same*
escalating chaos, and **locking in early buys safety**. The core tension becomes
**rush safe vs. linger for a better doodle/guess** — a real decision that only
exists in this mode.

## What changes from v1 (the whole diff)

- **Shared, not per-player.** A wave picks **one** effect and applies it to the
  **whole affectable room** at once (was: one random effect *per player*). Level
  field — everyone eats the same handicap.
- **Severity tiers replace flat rolls.** Each phase pool is split into mild /
  medium / harsh tiers; the wave's tier is chosen by **how far into the phase** it
  fires. Effects keep their *existing single intensity* — severity comes from
  *which* effect fires and *how often*, not from a per-effect intensity dial.
- **Tightening cadence.** Wave gaps **shrink** as the phase burns down; effect
  duration tracks the gap, so late-phase waves run near-continuous — the chaos
  climax.
- **Early-lock grace is the reward.** The existing affectable gate already skips
  locked-in drawers / already-guessed players. v2 leans on it deliberately:
  locking/guessing early **exempts you from every later (harsher) wave**. No new
  code — it *is* the survival skill.
- **Scoring unchanged.** Speed scoring + grace already reward decisiveness. No
  scoring math touched.

Everything else from v1 is retained verbatim (see "Inherited from v1" below).

## Wave model — shared single effect

A wave now:

1. Computes phase progress `p = elapsed / phaseDuration` (0…1).
2. Picks the **tier** for `p` (see schedule below).
3. Rolls **one** effect from that tier's pool.
4. Applies **that one effect** to **every affectable player**, all stamped with
   the same `endsAt`.

The affectable gate is unchanged from v1 — a wave still skips locked-in drawers
(drawing) and the featured artist / already-guessed players (guessing). Because
the gate already exempts the "done" players, the room-wide effect only lands on
players still working. That exemption is the **early-lock grace**.

> Net effect on `applyEffectWave`: it goes from "roll a random effect *per player*"
> to "roll *one* tiered effect for the wave, apply to all affectable players." This
> is a **simplification** — the per-player roll loop is deleted.

## Severity tiers

Effects keep their current single intensity. Each phase pool is partitioned into
three tiers by how disruptive the effect is:

**Draw phase** (pool: `fog`, `flip`, `lights`, `cramp`):

| Tier | Effects | Why |
|------|---------|-----|
| Mild | `fog` | Can still draw, just clouded. |
| Medium | `flip` | Disorienting (180°) but fully drawable. |
| Harsh | `lights`, `cramp` | Blackout / input-locked — you lose drawing time. |

**Guess phase** (pool: `squint`, `hidenames`, `shuffle`, `curtain`):

| Tier | Effects | Why |
|------|---------|-----|
| Mild | `squint`, `hidenames` | Readable with effort. |
| Medium | `shuffle` | Reorders options — costs orientation. |
| Harsh | `curtain` | Hides the drawing outright. |

Within a tier the effect is a random pick, so successive harsh waves alternate
(e.g. `lights` then `cramp`). Tiers sidestep the binary-effect problem entirely:
no effect needs an intensity parameter, because `flip`/`shuffle`/`hidenames`/
`cramp` are simply *placed* at the right severity tier.

### Tier schedule (by phase progress `p`)

| `p` range | Tier |
|-----------|------|
| `0 ≤ p < 0.45` | Mild |
| `0.45 ≤ p < 0.80` | Medium |
| `0.80 ≤ p ≤ 1.0` | Harsh |

## Tightening cadence

Both the **gap between waves** and each **effect's duration** are derived from
phase progress, expressed as fractions of the phase duration `D` so they scale to
any configured draw/guess time, with absolute floors so short phases still feel
right.

- **First wave delay:** `firstWaveFrac · D`, floored at `minGapMs`.
- **Gap to next wave:** linearly interpolated from `gapStartFrac · D` down to
  `gapEndFrac · D` as `p → 1`, floored at `minGapMs`.
- **Effect duration:** `gap · durationOfGap` (slightly under the current gap early
  for breathing room; ≈ the gap late, so back-to-back harsh waves read as
  near-continuous), floored at `minEffectMs`.

Starting constants (named, in `room.go`, all tunable):

| Constant | Value | Meaning |
|----------|-------|---------|
| `firstWaveFrac` | `0.12` | First wave at 12% of the phase. |
| `gapStartFrac` | `0.28` | Early gap ≈ 28% of the phase. |
| `gapEndFrac` | `0.10` | Late gap ≈ 10% of the phase. |
| `durationOfGap` | `0.9` | Effect lasts 90% of the current gap. |
| `minGapMs` | `4000` | Floor on any computed gap / first delay. |
| `minEffectMs` | `2500` | Floor on effect duration. |

> Example, `D = 60s` draw phase: first wave ≈ 7.2s (mild fog), gaps tighten from
> ~16.8s toward ~6s; by `p ≥ 0.8` waves fire ~6s apart drawing from the harsh tier
> (`lights`/`cramp`) for ~5.4s each — near-continuous blackout into the buzzer.

## Early-lock grace (no new code)

The v1 affectable gate already encodes the entire reward:

- A drawer who **locks in** is skipped by every subsequent wave → safe from the
  harsh late-phase `lights`/`cramp`.
- A guesser who **submits** is skipped likewise → safe from late `curtain`.

So the survival skill is *decisiveness*: commit early and the escalation never
reaches you; linger for a better doodle/guess and you gamble against the harsh
tier. This is emergent from existing logic — v2 adds **no** shields, cleanses, or
clear-gestures. We document and rely on it; we do not build it.

## Scoring — untouched

No scoring change. Justification:

- **Speed scoring** (`speedScore`) already rewards fast correct guesses.
- **Early-lock grace** already rewards committing before the chaos peaks.

Together these already pay for decisiveness, which is exactly the v2 skill. Adding
a "performed-under-effect" bonus would double-reward and complicate a system that
already produces the intended pressure. Explicitly out of scope.

## Backend changes

Confined to two files; the catalog, state shape, redaction, ticker plumbing, and
lifetime from v1 are unchanged.

### `powerups.go`

- Replace the flat per-phase pools with **tiered** pools:
  `drawTiers` / `guessTiers`, each `mild` / `medium` / `harsh`.
- `tierForProgress(p)` → which tier a wave at progress `p` uses.
- `effectForWave(phase, p)` → pick the tier, then a random effect from it.
- `applyEffectWave(phase, p)` → roll **one** effect via `effectForWave`, stamp
  **all affectable players** with it sharing one `endsAt`. (Deletes the per-player
  roll loop.)
- `affectable(name)` — **unchanged** (it already is the grace gate).
- `activeEffects(effects, now)` — unchanged.

### `room.go` / `rounds.go`

- New cadence constants (table above); remove the fixed `effectInterval` /
  `effectDurationMs` constants (their roles are now computed).
- The wave ticker keeps the generation pattern (`armWave`/`phaseGen`). On each
  `CmdEffectWave`:
  1. compute `p` from phase start + configured phase duration,
  2. `applyEffectWave(phase, p)`,
  3. re-arm with the **computed** next gap (not a fixed interval).
- `startPhase` arms the first wave at `firstWaveFrac · D` (floored).
- `endsAt` per wave = `now + computed duration` (not a fixed 7s).

> The ticker needs the **phase start time** and **configured duration** to compute
> `p` and the gap. The phase deadline is already tracked for the round timer; the
> wave handler reads the same values rather than introducing new state.

## Frontend

**No frontend changes.** Same effect catalog, same `EffectLayer` / `DrawingCanvas`
/ `PlayerStage` / `FlippedGuessing` consumers, same `useActiveEffects` deriving the
live `Set<Powerup>` from `yourEffects`. v2 changes only *which* effect arrives and
*when* — all server-side. Because every player in a wave now shares the same
effect, screens look identical during a wave (a visible "the whole room is fogged"
moment), but the client needs no awareness of that.

## Inherited from v1 (unchanged, see prior doc)

- **Safety rule:** effects never read/modify/inject/delete stroke data; view
  overlays / brief input lock only; absolute `endsAt`, self-clearing.
- **Effect catalog** and per-effect client rendering.
- **State & redaction:** authoritative `Effects` map server-only; `viewFor` copies
  only the recipient's own live effects into `YourEffects`.
- **Lifetime:** phase-scoped; cleared on transition, on player leave, on
  `endGame` / `returnToLobby`.
- **Other-mode isolation:** classic/flipped never arm the ticker, never populate
  `Effects`.
- **TV host / play-along host** handling.

## Testing

New / changed:

- **Shared wave:** one `applyEffectWave` stamps **every** affectable player with
  the **same** effect kind and the **same** `endsAt` (was: assert *differing* per
  player — flip that assertion).
- **Tier selection:** `tierForProgress` returns mild / medium / harsh at the
  documented `p` boundaries; `effectForWave` only draws from the selected tier's
  pool.
- **Cadence:** first wave fires at ~`firstWaveFrac · D` (floored); successive
  computed gaps **shrink** monotonically toward `gapEndFrac · D`; every gap and
  duration respects its floor.
- **Escalation end-to-end:** a late-phase wave (`p ≥ 0.8`) draws from the harsh
  tier; an early one (`p < 0.45`) draws from mild.
- **Early-lock grace:** a drawer who locked in / a guesser who submitted before a
  wave is **not** stamped by it.

Retained from v1: affectable gate, gen-gating, redaction, cleanup, classic/flipped
isolation, and the frontend rendering tests (now also valid for the shared model).

## Open tuning (constants, not blockers)

The cadence/tier constants (`firstWaveFrac`, `gapStartFrac`, `gapEndFrac`,
`durationOfGap`, `minGapMs`, `minEffectMs`) and the **tier boundaries** (`0.45` /
`0.80`) are starting values to playtest. They live as named constants in one place.
Tier *membership* (which effect sits in which tier) is likewise a one-place edit.

## Optional cleanup (deferred)

The protocol type `Powerup` is now (and was already) entirely debuffs — a
misnomer. Renaming to `Effect` across `protocol.ts` + Go would read truer but is a
pure rename touching many files for no behavior change. **Deferred** — not part of
this work.

## Out of scope

- Per-effect continuous intensity dials (tiers replace them).
- Active counterplay: shields, cleanses, clear-gestures, tilt-to-unflip.
- Frenzy-specific scoring bonuses.
- Positive powerups / buffs (this is a debuff-only survival mode).
- The `Powerup` → `Effect` rename.
- Anything already out of scope in v1 (wonky-output family, targeting/firing,
  cross-round carry, effects in classic/flipped).
