# Local Drawing History — Design

**Date:** 2026-06-21
**Status:** Approved (design); spec pending user review

## Problem

Drawings are ephemeral. A player's strokes live only in the zustand store
(`myDrawings`, `store.ts:42`/`recordDrawing`, `store.ts:105`) and the host's full
room gallery in `galleryHistory` (`store.ts:50`). Both are wiped back to lobby on a
new game (`store.ts:152`) and never survive a reload or a closed tab. Players have
no way to look back at drawings from past games.

## Goal

Persist each device's drawings to `localStorage` so a player can browse past games
from a new **History** tab on the landing page, with full replay and per-round
thumbnails. Host devices may opt in to also archive the whole room gallery.

## Decisions (from brainstorming)

- **Scope = own drawings + opt-in host gallery.** Every device always saves the
  drawings it made. A host (display or play-along) gets a lobby toggle to also
  archive every player's drawing per round (the host already receives the full
  `gallery`). Player devices only ever receive their own strokes, so they save own.
- **Location = third tab on the landing page** (`index.tsx`), next to Join/Host in
  the existing `Segmented` control. Visible on mobile (unlike Host, which is
  desktop-only) so phone players can browse their history.
- **Format = strokes + cached PNG thumbnail.** Store the replayable `Stroke[]` plus
  a small flattened PNG data URL per drawing — strokes drive full replay via the
  existing `StrokesView`; the thumbnail drives a fast grid.
- **Retention = cap at last N games** (`MAX_GAMES = 20`), newest-first, drop oldest
  when full or on a quota error. Plus a manual "Clear all" / per-game delete.
- **Capture = incremental per round** (not save-once-at-`ended`) so abandoned games
  (host leaves, tab closed mid-game) still persist. Cost: a cheap thumbnail
  re-render per round.

## Storage budget note

`localStorage` is ~5 MB. Strokes are tiny (point arrays); the PNG thumbnails
dominate. Thumbnails are rendered small (~240×180) to keep ~20 games × a few rounds
well under budget. `upsertGame` catches `QuotaExceededError`, drops the oldest game,
and retries; if it still fails it gives up silently (history is best-effort, never
blocks gameplay).

## Data model (`localStorage` key `skoobl:history`)

```ts
interface SavedDrawing {
  prompt: string;        // the word, "" if unknown (e.g. unrevealed gallery art)
  strokes: Stroke[];     // replayable, logical CANVAS_W×CANVAS_H space
  thumb: string;         // small PNG data URL
}

interface SavedGame {
  id: string;            // `${code}:${startedAt}` — stable across reload
  code: string;          // room code
  playedAt: number;      // unix ms (first capture)
  you: string;           // this device's player name
  mine: Record<number, SavedDrawing>;                      // own drawing, keyed by round
  gallery?: Record<number, Record<string, SavedDrawing>>;  // opt-in: others' art, round → name → drawing
}

// stored value: SavedGame[], newest-first, length <= MAX_GAMES
```

`id` reuses the room `code` plus a per-game `startedAt` stamp so the same room code
played twice yields two entries, and a reload mid-game re-targets the same entry.

## Design

### New module `src/lib/history.ts` (no React, unit-testable)

Mirrors the existing storage helpers (`theme.ts`, `identity.ts`): a focused module
owning all `localStorage` access and the thumbnail render. Public surface:

- `loadHistory(): SavedGame[]` — parse `skoobl:history`; returns `[]` on missing or
  corrupt JSON (try/catch, never throws).
- `upsertGame(game: SavedGame): void` — merge by `id` (shallow-merge `mine` /
  `gallery` rounds into any existing entry), move to front, prune to `MAX_GAMES`.
  Wrap the `setItem` in try/catch: on `QuotaExceededError`, drop the oldest entry
  and retry; give up silently if still failing.
- `deleteGame(id: string): void`, `clearHistory(): void`.
- `renderThumb(strokes: Stroke[]): string` — offscreen `document.createElement(
  "canvas")` at thumbnail size, `drawStrokes(ctx, strokes)` (reused from
  `lib/canvas.ts`), `canvas.toDataURL("image/png")`.
- Gallery opt-in pref (host): `getSaveGalleryPref(): boolean` /
  `setSaveGalleryPref(b: boolean): void` under `skoobl:savegallery`.

### Game session id

Minted on the first non-lobby phase and kept in `sessionStorage`
(`skoobl:gameid`), matching the per-tab identity pattern in `identity.ts`:

- On entering `drawing`/`guessing`/`playing` with no stored id → mint
  `${code}:${Date.now()}`, store it.
- On returning to `lobby` → clear it, so the next game gets a fresh entry.

Helpers `currentGameId(code)` / `clearGameId()` live in `history.ts`.

### Capture flow

A `useEffect` in **both** game routes (`play.$code.tsx`, `host.$code.tsx`) watches
`[myDrawings, galleryHistory, phase]` from the store:

1. If `phase === "lobby"`, `clearGameId()` and return.
2. Otherwise resolve the session id, build a `SavedGame` from `you`, `code`,
   `myDrawings` (→ `mine`, prompt from `yourPrompt` where known), and — only when
   `getSaveGalleryPref()` is true and `galleryHistory` is non-empty —
   `galleryHistory` (→ `gallery`, prompt from reveal data where known).
3. Render thumbnails for any round not already thumbed (memoize by round so we
   don't re-render unchanged drawings), then `upsertGame`.

Writes target `skoobl:history` only — fully decoupled from the zustand store, so
the lobby reset (`store.ts:152`) never touches saved history.

### Opt-in gallery toggle (host)

A checkbox in the lobby host setup (`HostConfig.tsx`): "Save everyone's drawings to
this device." Reads/writes the `skoobl:savegallery` pref via `history.ts`. Shown for
host devices (display and play-along); absent on player join. When off, the capture
effect skips the `gallery` field entirely.

### History tab (landing, `index.tsx` + new component)

- Add `"history"` to the `Tab` union and a third `Segmented` segment. Unlike Host,
  it is **not** hidden on mobile.
- New `src/components/history/HistoryTab.tsx`: reads `loadHistory()` into local
  state. Renders a newest-first list of game cards — each shows `playedAt` (date),
  `code`, and a thumbnail strip of that game's rounds (own `mine`, plus gallery
  entries when present).
- Tap a thumbnail → expanded view using `StrokesView` (full-resolution replay of
  the saved strokes); if a saved gallery exists for that round, show the other
  players' drawings alongside.
- Controls: per-game delete and a global "Clear all" (calls `clearHistory()`),
  each refreshing local state. Empty state when no history.

## Testing

`src/lib/history.test.ts` (vitest + jsdom, matching `store.test.ts`):

- **upsert/merge:** upserting the same `id` merges new rounds into `mine` without
  dropping prior rounds; a new `id` prepends.
- **cap/prune:** writing more than `MAX_GAMES` keeps only the newest `MAX_GAMES`,
  oldest dropped.
- **quota fallback:** stub `setItem` to throw `QuotaExceededError` once → oldest
  game dropped and retried; throw always → no crash, history unchanged.
- **corrupt load:** garbage in `skoobl:history` → `loadHistory()` returns `[]`.
- **pref:** `get/setSaveGalleryPref` round-trips.
- `renderThumb` is stubbed/skipped where jsdom canvas can't rasterize; the data
  logic is what's covered.

## Out of scope

- Server-side / cross-device sync — history is per-device by design.
- Saving anything for spectators or the display host beyond the opt-in gallery.
- Exporting/downloading history (the existing per-drawing download is unchanged).
- Backfilling history for games played before this feature ships.
- IndexedDB — revisit only if the `localStorage` cap proves too small in practice.
