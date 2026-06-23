# Clean history saving — design

Date: 2026-06-22
Status: approved, ready for implementation plan

## Goal

The History tab saves too much and presents it messily. Make saved games clean,
verbose about whose art each drawing is, and downloadable per-drawing. No backend
changes — history is entirely device-local.

## Problems (confirmed from code + screenshots)

1. **Host art is duplicated.** A host's own drawings are stored in both `mine`
   (their own art) and `gallery[round][hostName]` (the reveal gallery includes
   the host as a player). They appear twice in the grid.
2. **Flat, unlabeled grid.** `Thumbs` renders all drawings into one
   `grid-cols-3 sm:grid-cols-4`. Artist names exist only in the thumbnail `alt`
   text, so the viewer cannot tell whose art is whose.
3. **No PNG download in the viewer.** Only `EndedStage` can download; the History
   viewer cannot.
4. **Replays pile up.** `currentGameId` mints `{code}:{Date.now()}` per session,
   so replaying the same room creates a new card every time (e.g. 4 cards for one
   room on one day).

## Decisions

- **Gallery layout:** group by round, label each thumbnail with its artist name.
- **Replays:** merge the same room played on the same day into a single card.
- **No composite images, no backend, EndedStage left as-is.**

## Storage model — `frontend/src/lib/history.ts`

### Deterministic game id (merge per room/day)

`currentGameId(code)` returns `` `${code}:${localDate}` `` where `localDate` is the
local calendar date as `YYYY-MM-DD` (e.g. `OD57CF:2026-06-22`). Consequences:

- Same room, same day → same id → `upsertGame` merges into the existing card.
  Per-round merge keeps the latest drawing for a round (existing `{...prev.mine,
  ...game.mine}` semantics), which is the intended "fewer, cleaner entries".
- New day or new room → new card.

The id is now fully derivable, so `GAME_ID_KEY` / sessionStorage minting is
removed. `clearGameId` is no longer needed to rotate ids; the lobby-reset branch
in `useDrawingHistory` keeps resetting the thumbnail cache (and may drop the
`clearGameId` call). `playedAt` keeps the first value seen for that id (existing
`upsertGame` behavior), which is fine since the card shows date only.

### No duplication on disk

In `buildSavedGame`, when `saveGallery` is on, build the `gallery` map from
`galleryHistory` **excluding the host** — skip any artist whose name equals `you`.
The host's own art lives solely in `mine`. Nothing is stored twice.

`mergeGallery` is unchanged (deep-merge of other artists; latest wins per round).
Because the host is never written into `gallery`, no migration of the merge logic
is needed.

## Display — `frontend/src/components/history/HistoryTab.tsx`

`Thumbs` gets two render paths:

- **Gallery present (host saved everyone):** group by round, ascending. Each
  round renders a `ROUND n` heading and a row of tiles:
  - host's own drawing first (`mine[n]`), captioned **"you"**;
  - then each other artist from `gallery[n]`, captioned with the artist **name**.

  Each tile is a button opening the viewer. A visible caption under each tile
  carries the artist label (the "verbose whose art" requirement).
- **No gallery (normal players, or host with the toggle off):** the simple strip
  — one tile per round captioned `Round n`.

A round may have a `mine[n]` entry, gallery entries, or both; render whichever
exist. Sort rounds numerically.

## Viewer — the per-drawing overlay

- Title stays verbose: `Round n` for own art, `Round n · Alice` for gallery art,
  with ` — {prompt}` appended when the prompt is known.
- Add a **Download PNG** button beside **Close**. It calls
  `downloadStrokesPng(selected.drawing.strokes, filename)`.
- Filename is verbose and filesystem-safe:
  - own art: `skoobl-{code}-round{n}.png`
  - gallery art: `skoobl-{code}-round{n}-{artist}.png`
  - the artist segment is slugified (lowercased, non-alphanumerics → `-`).

  A small helper builds this name. `pngFilename(round)` in `canvas.ts` stays for
  `EndedStage`; the history name builder can live in `history.ts` or `HistoryTab`.

`Selected` carries enough to build the title and filename (round, optional
artist, code, and the `SavedDrawing`).

## Out of scope

- `EndedStage` download buttons — already work.
- Composite-image-per-round — rejected in favor of grouped layout.
- Server / protocol / `store.ts` accumulation — unchanged; this is display +
  device-local storage only.

## Testing (TDD)

`frontend/src/lib/history.test.ts` (or equivalent):
- `currentGameId` returns `{code}:{YYYY-MM-DD}` and is stable within a day;
  same room/day upserts merge into one entry.
- `buildSavedGame` with `saveGallery` true excludes the `you` artist from
  `gallery`, keeps the host's art in `mine`, and stores no drawing twice.
- `buildSavedGame` with `saveGallery` false is unchanged (mine only, no gallery).

`HistoryTab.test.tsx`:
- A game with a gallery renders per-round headings and visible artist captions,
  with the host's art shown once (under "you"), not duplicated.
- A game without a gallery renders the `Round n` strip.
- Opening the viewer and clicking Download calls `downloadStrokesPng` with the
  expected verbose, slugified filename.
