# Frenzy Mode — Design

**Date:** 2026-06-22
**Status:** Approved; **revised 2026-06-22** — replaced the collect-and-fire
powerup model with room-wide ambient effect waves (see Revision note).

## Problem / Goal

Add a chaotic party variant on top of Skoobl's existing draw → guess → reveal
loop. In Frenzy, the whole room is periodically hit by a **wave** of effects:
every active player simultaneously gets a random, short-lived nuisance that makes
drawing or guessing briefly harder. The loop, prompts, scoring, and lifecycle are
otherwise unchanged — the effect waves are a new real-time layer.

This mode depends on the **game-mode foundation** defined in
[Whose Doodle](2026-06-22-whose-doodle-flipped-mode-design.md#shared-foundation-game-modes)
(`Config.Mode` / `GameState.Mode`, lobby selector, `viewFor` echo). Frenzy adds
`ModeFrenzy = "frenzy"`.

## Revision note (what changed)

The original design was a free-for-all: a server timer trickled **powerups** into
each player's **inventory**; tapping one **fired** it at a random rival. Playtesting
found this too fiddly and too weak. The model is now **ambient and synchronized**:

- **No inventory, no tray, no targeting, no firing.** All removed.
- Instead, a server timer fires a **wave** that hits **every active player at
  once**. Each player **rolls their own** random effect (they don't all get the
  same one), so the room is sabotaged on the same beat but no two screens look
  alike.
- **Cadence:** first wave **5s** into the phase, then **every 15s**
  (`firstEffectDelay`, `effectInterval`). Waves run during drawing and guessing,
  pause in reveal, never run in classic/flipped.
- **Duration:** every effect lasts **~7s** (`effectDurationMs`) — long enough to
  properly impede, short enough to leave clear play before the next wave (7s < 15s,
  so waves never overlap and a wave cleanly **replaces** the prior one).
- **Lights-Out** is now a full, input-eating blackout (see catalog).

## Core principle (the safety rule)

**Effects never read, modify, inject, or delete a player's stroke data.** They
apply only as **view overlays/transforms** or a **brief input lock** on the
player's own client, each stamped with an absolute `endsAt` and self-clearing.
The server relays effect state; it never vandalizes a canvas.

Consequences:
- Drawings stay intact and fully guessable — Frenzy doesn't break the guess phase.
- Effects survive a reconnect cleanly (absolute expiry; the client resumes or
  finds it already expired).
- "Temporary nuisances only — drawing itself never altered" stays literally true.

The "wonky output" family (shaky pen, wrong crayon, fat marker) would leave
altered strokes behind, so it is **out of scope**.

## Effect catalog

All effects are time-boxed to `effectDurationMs` (~7s) and purely
perception/input. Each effect belongs to a phase and is only rolled in that phase.

**Draw phase:**
| Effect         | Effect on the player (client-only)                              |
|----------------|-----------------------------------------------------------------|
| **Fog**        | Canvas clouds over; they draw blind but can still draw.         |
| **Lights-Out** | Canvas goes **fully black and eats all input** — they can't see *or* draw until it clears. |
| **Topsy-Turvy**| Canvas *view* flips/rotates 180° (strokes still record true).   |
| **Cramp**      | Pointer input disabled; nothing they drew changes.              |

**Guess phase:**
| Effect     | Effect on the player (client-only)                        |
|------------|-----------------------------------------------------------|
| **Squint** | The drawing(s) on show blur.                              |
| **Curtain**| The drawing hides behind a sketchy curtain.               |
| **Shuffle**| The guess options (names or doodle grid) jumble order.    |
| **No Names**| The guess options' names + avatars are masked.           |

Fog and Curtain pass input through (the player acts "blind"); Lights-Out is the
one perception effect that also **blocks input** — the whole point is they can't
do anything on screen. Cramp, Shuffle and No Names are input/data effects applied
by their consumers, not by the overlay layer.

The pools and duration are constants in one place (`powerups.go` / `room.go`) so
the set can be trimmed/tuned without touching wiring.

## Effect waves

- **Cadence:** while in a drawing **or** guessing phase, a server timer fires the
  first wave `firstEffectDelay` (**5s**) in, then re-arms every `effectInterval`
  (**15s**). Waves pause during reveal; classic/flipped never arm the timer.
- **A wave** rolls one random phase-appropriate effect for **every connected,
  affectable player** and stamps each with `endsAt = now + effectDurationMs`.
  Every player is hit at the same instant; each rolls independently.
- **Affectable gate:** a wave skips players who can't be disrupted right now — a
  locked-in drawer (drawing), or the featured artist / an already-guessed player
  (guessing). No point blacking out someone who's already done.
- **Replace, not stack:** a wave overwrites `Effects` wholesale. Because 7s < 15s,
  any prior wave's effects have already expired, so there is never overlap.
- **No defense:** no shields/cleanse/immunity. Effects are short — ride it out.

## Backend architecture

### `powerups.go`

Owns the catalog and wave logic, isolated from the round engine:
- `Powerup` kind enum + per-phase pools (`drawPowerups`, `guessPowerups`).
- `powerupsForPhase(phase)` — the pool a wave draws from.
- `applyEffectWave(phase)` — roll one random effect per connected, affectable
  player; replace `Effects`.
- `affectable(name)` — whether an effect would actually disrupt the player now.
- `activeEffects(effects, now)` — filter out expired effects.

### State (`state.go`)

Authoritative, server-side, **redacted** from views:
```go
Effects map[string][]ActiveEffect // player → active effects

type ActiveEffect struct {
    Kind   Powerup `json:"kind"`
    EndsAt int64   `json:"endsAt"` // unix ms, absolute
}
```
`viewFor` copies **only the recipient's own** still-live effects into the view
field `YourEffects []ActiveEffect`. No client sees another player's effects, and
the authoritative `Effects` map never appears in a view. There is no inventory and
no attacker (`From`) field — effects come from room-wide waves, not a player.

### Commands (`room.go`)

- `CmdEffectWave{Gen}` — internal, self-rescheduling wave ticker.
- Constants: `firstEffectDelay` (5s), `effectInterval` (15s), `effectDurationMs`
  (7000).

### Wave ticker

Reuses the generation pattern (`armAdvance`/`phaseGen`):
- `startPhase`, when `Mode == ModeFrenzy` and the new phase is drawing or
  guessing, calls `armWave(phaseGen, firstEffectDelay)`.
- The `CmdEffectWave` handler ignores stale generations (auto-stops when the phase
  changes to reveal / round end / lobby), otherwise calls `applyEffectWave(phase)`
  and re-arms `armWave(phaseGen, effectInterval)`.
- Reveal arms no ticker, so waves naturally pause there.

### Lifetime

- **Effects are phase-scoped.** `startPhase` clears `Effects` on every transition
  (a draw-phase blackout must not linger into guessing); expiry is enforced lazily
  in `viewFor`. They are cleared when their player leaves (`clearRoundData`) and
  wiped wholesale on `endGame` / `returnToLobby`.
- There is no cross-phase state to carry — the old inventory is gone.

### Zero-overhead for other modes

Classic and Flipped never arm the ticker, never run a wave, and never populate
`Effects`. Their behavior and payloads are unchanged.

## Frontend

- **`protocol.ts` / `store.ts`:** carry `yourEffects: ActiveEffect[]` only. No
  `yourPowerups`, no `firePowerup` action, no `from` on `ActiveEffect`.
- **`useActiveEffects`:** derives the live `Set<Powerup>` from `yourEffects`,
  re-evaluating on a short interval so each effect drops the moment its
  server-stamped `endsAt` passes. **Unchanged** by the revision.
- **`EffectLayer`:** renders blur (Squint) and 180° flip (Topsy-Turvy) as
  transforms; Fog and Curtain as pointer-transparent overlays; **Lights-Out as a
  fully opaque, input-eating blackout** (`bg-black`, `touch-none`, no
  `pointer-events-none`).
- **`DrawingCanvas`:** Cramp disables the pointer + shows a "frozen" badge.
- **Guessing views (`PlayerStage` / `FlippedGuessing`):** Shuffle reorders the
  options/grid; No Names masks names + avatars.
- **No tray, no toast.** The firing UI (`PowerupTray`) is deleted; effects are
  visually self-evident, so there is no incoming-effect toast.
- **Visibility:** waves only run in Frenzy and only affect players (the
  non-playing TV host is never hit).

## Edge cases

- **No affectable player** (all locked / done / disconnected) → the wave is a
  no-op; nothing is stamped.
- **Player leaves** → their effects are pruned with them.
- **Reconnect mid-effect** → absolute `endsAt` lets the client resume the
  remaining time, or treat it as expired.
- **Play-along host** → a normal player: gets hit by waves like anyone.
- **TV host (non-playing)** → never in the player list, never hit.
- **Mode switched in lobby** → no effect state persists past lobby; waves only run
  in-game under frenzy.

## Testing

- **Waves:** hit every connected, affectable player at once with one
  phase-appropriate effect, all sharing the same `endsAt`; replace (don't stack);
  no-op outside drawing/guessing.
- **Affectable gate:** a wave skips locked drawers (drawing) and the featured
  artist / already-guessed players (guessing).
- **Gen-gating:** a stale-generation `CmdEffectWave` is a no-op; a current-gen one
  inflicts a wave.
- **Redaction:** `viewFor` exposes only the recipient's own live `YourEffects`;
  the authoritative `Effects` map never leaks; expired effects are filtered out.
- **Cleanup:** `returnToLobby` and a departed player's `clearRoundData` clear
  effects.
- **Isolation:** classic/flipped never populate `Effects` and never arm the ticker.
- **Frontend:** Fog overlays + Cramp disables input; Lights-Out renders an opaque,
  input-eating blackout; Curtain covers; No Names masks; `useActiveEffects` drops
  expired effects.

## Open tuning (constants, not blockers)

`firstEffectDelay` (5s), `effectInterval` (15s), and `effectDurationMs` (~7s) are
starting values to playtest and tune; they live as named constants.

## Out of scope

- The "wonky output" effect family (alters strokes).
- Defensive items (shields/cleanse/immunity).
- Per-player targeting or any manual firing (replaced by automatic waves).
- Effects in classic/flipped modes.
- Cross-round carry / persistent currency.
