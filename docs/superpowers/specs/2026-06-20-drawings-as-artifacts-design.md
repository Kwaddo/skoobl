# Drawings as First-Class Artifacts — Design

**Date:** 2026-06-20
**Status:** Approved (design); spec pending user review

## Problem

Drawings in this "guess who drew it" game are treated as disposable:

1. **All non-featured drawings are hidden then discarded.** Every player draws the
   same prompt, but only the one *featured* drawing is ever shown. At round end
   nobody learns who drew what.
2. **Unlocked drawings are lost.** Strokes live only on the client until an explicit
   `submitDrawing`. The server's drawing timer fires `advance()` at `PhaseEndsAt` and
   flips the phase to guessing; a `submitDrawing` arriving after that is rejected
   (`r.state.Phase != PhaseDrawing`, `room.go:750`). The client's buzzer auto-submit
   races the server timer and frequently loses, so a drawing that was never locked in
   vanishes.
3. **Thin tool set.** 8 fixed colors, no fill, no custom color.
4. **No keepsake.** Players never see or download their own art; at game end they only
   get a leaderboard.

## Goals

Make drawings first-class artifacts: **reliably captured**, **shown to everyone**,
**richer to make**, and **exportable**. Keep the UI uncluttered (Jackbox TV/phone
split stays intact).

## Decisions (from brainstorming)

- **Fill = flood-fill enclosed regions**, stored as a replayable op (seed point +
  color), not a raster image — preserves the vector-stroke model end to end.
- **Round-end gallery is host-TV only.** Each player sees only their own drawing on
  their phone. Lightest payload, matches "TV is the shared screen."
- **Game-end player phone shows their own drawings + download**, not the leaderboard.
  The final leaderboard stays on the host TV.

---

## Part A — Auto-lock via server draft-sync (fixes problem 2)

The fix must be server-authoritative: the server can only keep what it has received,
so the client must stream strokes continuously instead of only at lock time.

### Wire / protocol

- **New inbound event `draftDrawing`** (`realtime/socket.go`), payload
  `{ strokes: Stroke[] }`, same shape as `submitDrawing`. Maps to a new
  `CmdDraftDrawing`.
- Client (`use-game-socket.ts`) gains `draftDrawing(strokes)` action. `PlayerDrawing`
  emits it **on every stroke-end (`pointerup`/`pointercancel`)** and once more at lock.
  Throttling beyond per-stroke is optional and out of scope.

### Server state (`game/state.go`, `game/room.go`)

- **`GameState.Locked map[string]bool`** (server-only, redacted) — players who
  explicitly locked in this round.
- **`CmdDraftDrawing`** handler: if `Phase == PhaseDrawing` and player is in the room,
  write `Drawings[player] = sanitizeStrokes(strokes)`. **Does not** trigger
  early-advance (drafts are not locks).
- **`submitDrawing`** (existing): unchanged storage, plus set `Locked[player] = true`.
  Early-advance now gated on `allLocked()` instead of `allDrawn()`.
- **`allDrawn()` → `allLocked()`**: every *connected* player present in `Locked`.
- **`advance()` from drawing** (timer expiry): keep `Drawings` as-is (drafts included);
  do not clear or require locks. Nothing is discarded. Empty drawings stay empty, so an
  idle player is still excluded from the featured pick (`room.go:614`, unchanged).
- **`beginRound`** clears `Locked` alongside `Drawings`.

### View flags (`state.go` `viewFor`)

- `HasDrawn` keeps its current meaning — *drew something non-empty*
  (`len(g.Drawings[p.Name]) > 0`) — still used for featured eligibility and the
  guess-options list.
- **New view field `Player.Locked bool`** (`omitempty`) from `g.Locked[name]`. The host
  TV roster's "finished ✓ vs drawing…" indicator switches to read `Locked`, so the ✓
  means *locked in*, not *has any draft stroke*.

### Client

- `PlayerDrawing` keeps the existing buzzer auto-submit (`remaining === 0 → submit`) as
  a belt-and-suspenders lock; it is no longer the safety net — draft-sync is.

---

## Part B — Round-end gallery on the host TV (fixes problem 1)

The backend already retains every drawing for the round in `Drawings`; only redaction
hides them.

### Backend

- **New view field `GameState.Gallery map[string][]Stroke`** (`omitempty`). Populated in
  `viewFor` **reveal case, host recipient only** (`name == g.Host`), set to a copy of
  all entries in `g.Drawings`. Players continue to receive only `CurrentDrawing` (the
  featured one). No change to the persisted `Drawings`; `Gallery` is view-derived and
  marshals away from snapshots.

### Frontend (`HostStage.tsx` `HostReveal`)

- Render a labeled grid of `StrokesView` thumbnails — one per `gallery` entry,
  captioned "drawn by {name}". Highlight the featured artist's tile. The existing
  reveal scoreboard stays beside/below the gallery. Grid is scrollable; thumbnails are
  smaller `StrokesView` instances (a `className` override gives the compact size).
- `store.ts` / `protocol.ts` gain `gallery: Record<string, Stroke[]>`.

---

## Part C — Player views + downloads own drawings (fixes problem 4)

The player's client already holds the strokes it drew, so its own gallery needs **no**
backend history.

### Client accumulation

- The player's store accumulates its locked strokes per round: `myDrawings: Stroke[][]`
  (index = round number), captured at lock/auto-lock time from the canvas state. Reset
  on `returnToLobby` / new game.

### Reveal screen (`PlayerStage.tsx` `PlayerReveal`)

- Add the player's own-drawing thumbnail (`StrokesView`) and a **Download PNG** button
  next to the existing result card (artist + points). Compact — result summary stays
  primary.

### Game-end screen (player phone)

- Replace the scoreboard with a **"your drawings" gallery**: one thumbnail per round,
  each with a download button, plus a **Download all** action. Keep a compact winner
  banner so the result is still visible (not a full leaderboard).
- Host ended screen unchanged: full leaderboard stays on the TV. `EndedStage` branches
  on `screen` (host → scoreboard, player → personal gallery) — extends the existing
  host/player split in that component.

### Download util (`lib/canvas.ts`)

- `downloadStrokesPng(strokes, filename)`: render to an offscreen `1000×750` canvas via
  `drawStrokes`, then `toBlob("image/png")` → temporary `<a download>` click. Filenames
  like `skoobl-round-2.png`.

---

## Part D — Fill bucket + hex picker (fixes problem 3)

### Data model

- **`Stroke.Fill bool`** (`json:"fill,omitempty"`), backend (`state.go`) and frontend
  (`protocol.ts`). A fill op is a `Stroke` with `Fill: true`, exactly one `Point` (the
  seed) and `Color` = fill color (`Width` ignored).
- **`sanitizeStrokes` must copy `Fill`** when it rebuilds each `Stroke` (currently drops
  unknown fields). A 1-point stroke already passes its `len(pts)==0` guard, so no other
  sanitize change is needed; `Color` still runs through `sanitizeColor` (hex-validated),
  which also secures the new hex picker server-side.

### Render (`lib/canvas.ts` `drawStrokes`)

- When a stroke has `Fill`, flood-fill from the seed: `getImageData` the current buffer,
  scanline/stack flood over pixels within a color-distance threshold of the seed pixel
  (threshold tolerates anti-aliased edges so the fill stops at drawn borders), paint the
  region with the fill color, `putImageData`. Runs synchronously in stroke order, so
  later strokes draw on top. Deterministic across interactive canvas, `StrokesView`
  (host gallery + player), and the download canvas because all render through
  `drawStrokes` at the same fixed resolution.

### Toolbar (`DrawingCanvas.tsx`)

- **Pen / Fill toggle.** In Fill mode a `pointerdown` adds a single fill stroke at the
  mapped seed point (no drag); brush-size buttons hide (irrelevant to fill).
- **Custom color:** a native `<input type="color">` swatch beside the 8 presets opens
  the OS hex picker; its value becomes the active color for pen and fill. Presets stay
  as quick swatches. Layout stays one compact toolbar row group — no new panel.

---

## Data-model summary

| Field | Where | Lifetime | Notes |
|---|---|---|---|
| `Locked map[string]bool` | `GameState` (server-only) | per round | gates `allLocked`; cleared in `beginRound` |
| `Player.Locked bool` | view (`omitempty`) | reveal/drawing view | drives TV "finished ✓" |
| `Gallery map[string][]Stroke` | view (`omitempty`) | reveal, host only | all drawings, view-derived |
| `Stroke.Fill bool` | `Stroke` (`omitempty`) | persisted with stroke | replayable fill op |
| `myDrawings Stroke[][]` | client store | whole game | player's own art, local only |

`Drawings`/`Locked`/`Gallery` server fields all clear at `endGame` and `returnToLobby`
with the other transient round data (extend the existing nil-out lists).

## Code touch points

- **Backend** (`backend/internal/game`): `state.go` (`Locked`, `Player.Locked`,
  `Gallery`, `Stroke.Fill`, `viewFor` reveal/host branch + roster flag); `room.go`
  (`CmdDraftDrawing`, `submitDrawing` lock, `allDrawn`→`allLocked`, `advance` keeps
  drafts, `beginRound`/`endGame`/`returnToLobby` clear `Locked`, `sanitizeStrokes` copies
  `Fill`); `realtime/socket.go` (`draftDrawing` handler, `Command` plumbing).
- **Frontend** (`frontend/src`): `lib/canvas.ts` (fill render, `downloadStrokesPng`);
  `lib/protocol.ts` + `lib/store.ts` (`gallery`, `Stroke.fill`, `Player.locked`,
  `myDrawings`); `hooks/use-game-socket.ts` (`draftDrawing` action); `DrawingCanvas.tsx`
  (Pen/Fill toggle, hex picker, draft emit on stroke-end); `PlayerStage.tsx`
  (own-drawing + download at reveal, accumulation, game-end gallery); `HostStage.tsx`
  (reveal gallery grid); `shared.tsx` (`EndedStage` host/player branch, `StrokesView`
  compact variant if needed).

## Testing

- **Backend `room_test.go`:** draft writes to `Drawings` without early-advance; explicit
  lock sets `Locked` and `allLocked` triggers early guessing; timer expiry keeps
  unlocked drafts (no discard) and still excludes empty drawings from featured; host
  reveal view carries `Gallery` while player view does not; `sanitizeStrokes` preserves
  `Fill` and rejects a non-hex fill color.
- **Frontend `stages.test.tsx`:** host reveal renders the labeled gallery; player reveal
  renders own drawing + download; player ended shows personal gallery (not scoreboard)
  while host ended shows scoreboard; Fill toggle emits a fill stroke; custom color input
  updates the active color; `draftDrawing` emits on stroke-end.

## Out of scope

- Cross-reconnect persistence of a player's own gallery (local accumulation only; a
  mid-game refresh loses earlier rounds' personal thumbnails — drawings remain on the
  TV at reveal regardless).
- Multiple/undoable fills as discrete history beyond the existing per-stroke undo (undo
  removes the last fill op like any stroke).
- Server-side storage of full per-game drawing history.
- Changing scoring, featuring, or the phase flow.
