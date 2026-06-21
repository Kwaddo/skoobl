# Frenzy Mode — Design

**Date:** 2026-06-22
**Status:** Approved (design); spec pending user review

## Problem / Goal

Add a chaotic party variant on top of Skoobl's existing draw → guess → reveal
loop. In Frenzy, every few seconds each player is handed a random **powerup**;
one tap fires it at a **random rival**, inflicting a short, harmless effect that
makes drawing or guessing briefly harder. The loop, prompts, scoring, and
lifecycle are otherwise unchanged — powerups are a new real-time layer.

This mode depends on the **game-mode foundation** defined in
[Whose Doodle](2026-06-22-whose-doodle-flipped-mode-design.md#shared-foundation-game-modes)
(`Config.Mode` / `GameState.Mode`, lobby selector, `viewFor` echo). Frenzy adds
`ModeFrenzy = "frenzy"`.

## Core principle (the safety rule)

**Powerups never read, modify, inject, or delete a victim's stroke data.** They
apply only as **view overlays/transforms** or a **brief input lock** on the
victim's own client, each stamped with an absolute `endsAt` and self-clearing.
The server relays events; it never vandalizes a canvas.

Consequences:
- Drawings stay intact and fully guessable — Frenzy doesn't break the guess
  phase.
- Effects survive a reconnect cleanly (absolute expiry; the client resumes or
  finds it already expired).
- "Temporary nuisances only — drawing itself never altered" stays literally true.

The "wonky output" family (shaky pen, wrong crayon, fat marker) would leave
altered strokes behind, so it is **out of scope** (the declined "light marks"
tier). Flagged only as a possible future opt-in.

## Powerup catalog

All effects are time-boxed (~2–3s, per-kind constant) and purely
perception/input. Each powerup belongs to a phase and only fires in that phase.

**Draw phase:**
| Powerup       | Effect on victim (client-only)                                  |
|---------------|-----------------------------------------------------------------|
| **Fog**       | Canvas clouds over; they draw blind until it clears.            |
| **Lights-Out**| Canvas dims to near-black briefly.                             |
| **Topsy-Turvy**| Canvas *view* flips/rotates 180° (strokes still record true). |
| **Cramp**     | Pointer input disabled ~2s; nothing they drew changes.         |

**Guess phase:**
| Powerup    | Effect on victim (client-only)                            |
|------------|-----------------------------------------------------------|
| **Squint** | The drawing(s) on show blur.                              |
| **Curtain**| The drawing hides behind a sketchy curtain briefly.       |
| **Shuffle**| The guess options (names or doodle grid) jumble order.    |

Catalog and durations are constants in one place (`powerups.go`) so the set can
be trimmed/tuned without touching wiring.

## Acquisition & targeting

- **Drops:** while in a drawing **or** guessing phase, a server timer grants every
  *connected* player one random powerup every **~8s** (`dropInterval`), capped at
  an inventory of **3** (`inventoryCap`) to bound hoarding/AFK. Drops pause during
  reveal; classic/flipped never drop. Constants, tunable.
- **Fire:** tapping a held powerup sends `firePowerup(id)`. The server picks a
  **random connected rival** (never self), removes the item from the firer's
  inventory, and applies the effect. One tap, no target picker.
- **Phase gating:** draw-phase powerups only fire during drawing, guess-phase only
  during guessing (server-validated). A held powerup simply isn't fireable in the
  wrong phase.
- **No defense:** no shields/cleanse/immunity. Effects are short — ride it out.

## Backend architecture

### New file `powerups.go`

Owns the catalog and all powerup logic, keeping it isolated from the round
engine:
- `Powerup` kind enum + table: kind → `{phase, durationMs}`.
- `randomDrop(phase)` — pick a random powerup eligible for the current phase.
- `grantDrops(phase)` — give each connected player a drop up to `inventoryCap`.
- `fire(firer, id, phase)` — validate ownership + phase, pick a random connected
  rival, decrement inventory, append an `ActiveEffect`.
- `pruneEffects(now)` — drop expired effects.

### State (`state.go`)

Authoritative, server-side, **redacted** from views:
```go
Inventory map[string][]Powerup        // player → held powerups
Effects   map[string][]ActiveEffect   // victim → active effects

type ActiveEffect struct {
    Kind   Powerup `json:"kind"`
    EndsAt int64   `json:"endsAt"` // unix ms, absolute
    From   string  `json:"from"`   // attacker name (for the victim's toast)
}
```
`viewFor` copies **only the recipient's own** entries → view fields
`YourPowerups []Powerup` and `YourEffects []ActiveEffect`. No client ever sees
another player's hand or active effects. Expired effects are filtered out as the
view is built.

### Commands (`room.go`)

- `CmdFirePowerup{Player, PowerupID}` — routes to `fire`; rebroadcasts.
- `CmdDropPowerup{Gen}` — internal, self-rescheduling drop ticker.
- Constants: `dropInterval`, `inventoryCap`, per-kind durations.

### Drop ticker

Reuses the existing generation pattern (`armAdvance`/`phaseGen`):
- `startPhase`, when `Mode == ModeFrenzy` and the new phase is drawing or
  guessing, calls `armDrop(phaseGen, dropInterval)`.
- The `CmdDropPowerup` handler ignores stale generations (so it auto-stops when
  the phase changes to reveal / round end / lobby), otherwise calls
  `grantDrops(phase)` and re-arms `armDrop(phaseGen, dropInterval)`.
- Each new guessing feature restarts the drop cadence (acceptable; features are
  short). Reveal arms no ticker, so drops naturally pause there.

### Lifetime: inventory vs. effects

- **Inventory persists** across phases, features, and rounds within a game (you
  keep unfired powerups). It is wiped only when round data is wiped wholesale —
  `endGame` and `returnToLobby` — never per round or per feature.
- **Active effects are phase-scoped.** They are cleared on every `startPhase`
  transition (a draw-phase Fog must not linger into guessing) and pruned by
  expiry within a phase. They are also cleared when their victim leaves, via the
  existing departed-player cleanup.

### Pruning

No per-effect server timers. Within a phase, expired effects are filtered lazily
when `viewFor` builds a view and on each drop tick; absolute `endsAt` drives the
client's own auto-clear.

### Zero-overhead for other modes

Classic and Flipped never arm the ticker, never grant drops, and never populate
`Inventory`/`Effects`. Their behavior and payloads are unchanged.

## Frontend

- **`protocol.ts` / `store.ts`:** add `yourPowerups: Powerup[]` and
  `yourEffects: ActiveEffect[]`; add `firePowerup(id)` to the socket actions.
- **`DrawingCanvas`:** read `yourEffects` and apply — Fog/Lights-Out as overlay
  divs, Topsy-Turvy as a CSS transform on the canvas wrapper, Cramp by disabling
  the pointer + a "frozen" badge. A countdown hook (reusing `use-countdown`)
  clears each at `endsAt`.
- **Guessing views (`PlayerStage` / `HostStage`):** Squint = blur filter on
  `StrokesView`; Curtain = cover overlay; Shuffle = reorder the options/grid for
  the effect's duration.
- **Powerup tray:** a small component showing held powerups as tappable buttons
  (`firePowerup(id)`), with a drop-in animation on arrival. A brief toast on land
  ("You fogged Carol!") and on hit ("Bob fogged you!"), built from the effect's
  `from` field. Reuses the existing `Notice`/toast channel where it fits.
- **Tray visibility:** only in Frenzy, only for players (not the non-playing TV
  host).

## Edge cases

- **No valid rival** (all others disconnected) → fire is a no-op; the item is
  kept.
- **Victim leaves** → their effects + inventory are pruned with them.
- **Reconnect mid-effect** → absolute `endsAt` lets the client resume the
  remaining time, or treat it as expired.
- **Play-along host** → a normal player: drops, fires, and gets hit like anyone.
- **TV host (non-playing)** → no inventory, never targeted, no tray.
- **Inventory full** → further drops to that player are skipped until they fire.
- **Mode switched in lobby** → leftover powerup state (none persists past lobby)
  is irrelevant; drops only ever run in-game under frenzy.

## Testing

- **Drops:** ticker grants during draw + guess only (not reveal/lobby/ended),
  respects `inventoryCap`, only to connected players.
- **Fire:** validates phase + ownership; lands on a random *connected* rival,
  never self; decrements inventory; sets `endsAt = now + duration` and `from`.
- **Phase gating:** a draw-phase powerup can't fire during guessing and vice
  versa.
- **Redaction:** `viewFor` exposes only the recipient's own `YourPowerups` /
  `YourEffects`; never another player's hand or effects.
- **Pruning:** expired effects disappear from views; a departed player's effects
  and inventory are cleared.
- **No-rival no-op:** firing with no eligible rival keeps the item.
- **Isolation:** classic/flipped never populate powerup state and never arm the
  ticker.

## Open tuning (constants, not blockers)

`dropInterval` (~8s), `inventoryCap` (3), and per-kind effect durations (~2–3s)
are starting values to playtest and tune; they live as named constants.

## Out of scope

- The "wonky output" powerup family (alters strokes).
- Defensive items (shields/cleanse/immunity).
- Choosing a specific target; powerups always hit a random rival.
- Powerups in classic/flipped modes.
- Cross-round powerup carry / persistent currency.
