# Clean History Saving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the History tab save cleanly — merge same-room/same-day replays into one card, never store a drawing twice, label every drawing with its artist, and let users download any drawing as a PNG.

**Architecture:** Entirely device-local (localStorage). Change the saved-game id from a per-session timestamp to a deterministic `{code}:{localDate}` so replays merge. Drop the host from the saved `gallery` map (the host's art already lives in `mine`) so nothing is duplicated. Rewrite the History tab's thumbnail grid into a per-round, artist-labeled layout and add a per-drawing PNG download to the viewer.

**Tech Stack:** React + TypeScript, Vite, Vitest + @testing-library/react, Biome (lint/format). All drawing data is `Stroke[]` rendered via `drawStrokes` (canvas.ts).

## Global Constraints

- **Never run `git commit` or `git push`.** The user commits manually. End each task by running the verification commands green; leave the working tree for the user to review and commit. (Where the plan says "hand off for commit", that means: stop, report green, wait.)
- **Test command:** `npm test` (= `vitest run`) from `frontend/`. Run a single file with `npm test -- src/lib/history.test.ts`.
- **Gate per task:** `npm test`, `npm run typecheck`, and `npm run lint` must all pass before handing off.
- **No backend / protocol / store changes.** Display + device-local storage only.
- **Canvas logical size is fixed** (`CANVAS_W`/`CANVAS_H` from `canvas.ts`); thumbnails come from `renderThumb`, full PNGs from `downloadStrokesPng`.
- **Dates are local**, formatted `YYYY-MM-DD` from local `Date` components (never `toISOString`, which is UTC).

---

### Task 1: Deterministic per-room/per-day game id

Replace the per-session minted id with a deterministic `{code}:{YYYY-MM-DD}` so a room replayed on the same day merges into one saved card. Remove the now-dead sessionStorage machinery.

**Files:**
- Modify: `frontend/src/lib/history.ts` (rewrite `currentGameId`, remove `GAME_ID_KEY` and `clearGameId`)
- Modify: `frontend/src/hooks/use-drawing-history.ts` (drop `clearGameId` import + call; keep the thumb-cache reset)
- Test: `frontend/src/lib/history.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `currentGameId(code: string): string` → returns `` `${code}:${YYYY-MM-DD}` `` using the local date. `clearGameId` no longer exists.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/lib/history.test.ts`. First add `currentGameId` to the existing top import from `./history`:

```ts
import {
  buildSavedGame,
  clearHistory,
  currentGameId,
  deleteGame,
  getSaveGalleryPref,
  loadHistory,
  MAX_GAMES,
  type SavedGame,
  saveHistory,
  setSaveGalleryPref,
  upsertGame,
} from "./history";
```

Then append a new describe block at the end of the file:

```ts
describe("currentGameId", () => {
  it("is deterministic per code+local-day (YYYY-MM-DD)", () => {
    vi.useFakeTimers();
    // A fixed local wall-clock instant.
    vi.setSystemTime(new Date(2026, 5, 22, 9, 30, 0)); // 2026-06-22 local
    const id = currentGameId("OD57CF");
    expect(id).toMatch(/^OD57CF:\d{4}-\d{2}-\d{2}$/);
    expect(id.endsWith(":2026-06-22")).toBe(true);
    // Same day, later time → same id (so a replay merges).
    vi.setSystemTime(new Date(2026, 5, 22, 23, 0, 0));
    expect(currentGameId("OD57CF")).toBe(id);
    vi.useRealTimers();
  });

  it("changes with the room code and with the day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 22, 12, 0, 0));
    const a = currentGameId("AAA");
    expect(currentGameId("BBB")).not.toBe(a);
    vi.setSystemTime(new Date(2026, 5, 23, 12, 0, 0));
    expect(currentGameId("AAA")).not.toBe(a);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/history.test.ts`
Expected: FAIL — `currentGameId` returns the old `code:<timestamp>` shape (no `-` date), so the regex/`endsWith` assertions fail.

- [ ] **Step 3: Rewrite `currentGameId` and remove the dead code**

In `frontend/src/lib/history.ts`:

Remove the constant (line ~26):

```ts
const GAME_ID_KEY = "skoobl:gameid";
```

Replace the entire `currentGameId` function and the `clearGameId` function (the block from the `// currentGameId returns...` comment through the end of `clearGameId`) with:

```ts
// currentGameId is this game's stable id: the room code plus the local
// calendar date (YYYY-MM-DD). Deterministic, so replaying the same room on the
// same day merges into one saved entry instead of piling up new cards.
export function currentGameId(code: string): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${code}:${day}`;
}
```

(There is no longer any `clearGameId` — the id is derived, not stored.)

- [ ] **Step 4: Drop `clearGameId` from the hook**

In `frontend/src/hooks/use-drawing-history.ts`:

Remove `clearGameId,` from the import block (lines 2-9).

Replace the lobby branch (lines ~26-32) so it still resets the thumb cache but no longer calls `clearGameId`:

```ts
    // Back in the lobby a fresh game begins: forget cached thumbs. The saved-game
    // id is derived from code + date, so there is nothing else to reset.
    if (phase === "lobby") {
      thumbCache.current = new WeakMap();
      return;
    }
```

- [ ] **Step 5: Run the gate**

Run: `npm test -- src/lib/history.test.ts` → Expected: PASS
Run: `npm run typecheck` → Expected: no errors (confirms no remaining `clearGameId` reference)
Run: `npm run lint` → Expected: no errors

- [ ] **Step 6: Hand off for commit** (do NOT commit — report green and wait)

---

### Task 2: Exclude the host from the saved gallery (no duplication)

The reveal gallery includes the host as a player, so a host who saves "everyone's art" stores their own drawing twice — once in `mine`, once in `gallery[round][hostName]`. Drop the host (`you`) from the saved gallery; `mine` remains the single source of the host's own art.

**Files:**
- Modify: `frontend/src/lib/history.ts` (`buildSavedGame` gallery loop)
- Test: `frontend/src/lib/history.test.ts`

**Interfaces:**
- Consumes: existing `buildSavedGame(input: BuildInput): SavedGame | null`.
- Produces: same signature; behavior change — gallery never contains an artist whose name equals `input.you`.

- [ ] **Step 1: Write the failing test**

Append to the existing `describe("buildSavedGame", ...)` block in `frontend/src/lib/history.test.ts`:

```ts
  it("excludes the host (you) from gallery; host art stays only in mine", () => {
    const stroke = [{ color: "#fff", width: 5, points: [{ x: 1, y: 1 }] }];
    const g = buildSavedGame({
      id: "a:2026-06-22",
      code: "a",
      you: "Host",
      playedAt: 7,
      myDrawings: { 1: stroke },
      galleryHistory: {
        1: { Host: stroke, bob: stroke },
      },
      saveGallery: true,
      thumb,
    });
    expect(g).not.toBeNull();
    // Host's own art lives in mine...
    // biome-ignore lint/style/noNonNullAssertion: g asserted non-null above
    expect(Object.keys(g!.mine)).toEqual(["1"]);
    // ...and the gallery holds only the OTHER artists.
    // biome-ignore lint/style/noNonNullAssertion: gallery present when saveGallery true with art
    expect(Object.keys(g!.gallery![1])).toEqual(["bob"]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/history.test.ts`
Expected: FAIL — `Object.keys(g!.gallery![1])` is `["Host", "bob"]`, not `["bob"]`.

- [ ] **Step 3: Skip the host in the gallery loop**

In `frontend/src/lib/history.ts`, inside `buildSavedGame`, update the gallery-building inner loop (currently lines ~208-214) so it skips the host:

```ts
  let gallery: SavedGame["gallery"];
  if (saveGallery) {
    const acc: Record<number, Record<string, SavedDrawing>> = {};
    for (const [rStr, byArtist] of Object.entries(galleryHistory)) {
      const roundMap: Record<string, SavedDrawing> = {};
      for (const [artist, strokes] of Object.entries(byArtist)) {
        // The host's own art is already stored in `mine`; never duplicate it
        // into the gallery.
        if (artist === you) continue;
        if (!strokes.length) continue;
        roundMap[artist] = { prompt: "", strokes, thumb: thumb(strokes) };
      }
      if (Object.keys(roundMap).length) acc[Number(rStr)] = roundMap;
    }
    if (Object.keys(acc).length) gallery = acc;
  }
```

- [ ] **Step 4: Run the gate**

Run: `npm test -- src/lib/history.test.ts` → Expected: PASS (new test + the existing "includes gallery only when saveGallery is true" test, whose artist `bob` ≠ host `Host`, still passes)
Run: `npm run typecheck` → Expected: no errors
Run: `npm run lint` → Expected: no errors

- [ ] **Step 5: Hand off for commit** (do NOT commit — report green and wait)

---

### Task 3: Verbose, filesystem-safe PNG filename helper

Add a helper that builds the download filename for a saved drawing, including the room code, round, and (for gallery art) the slugified artist name.

**Files:**
- Modify: `frontend/src/lib/history.ts` (add `historyPngName`)
- Test: `frontend/src/lib/history.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `historyPngName(code: string, round: number, artist?: string): string`.
  - own art (`artist` undefined/empty): `` `skoobl-${code}-round${round}.png` ``
  - gallery art: `` `skoobl-${code}-round${round}-${slug}.png` `` where `slug` is `artist` lowercased with every run of non-alphanumeric chars collapsed to a single `-` and leading/trailing `-` trimmed.

- [ ] **Step 1: Write the failing test**

Add `historyPngName` to the top import from `./history` in `frontend/src/lib/history.test.ts`, then append:

```ts
describe("historyPngName", () => {
  it("names own art with code and round", () => {
    expect(historyPngName("OD57CF", 2)).toBe("skoobl-OD57CF-round2.png");
  });
  it("names gallery art with a slugified artist", () => {
    expect(historyPngName("OD57CF", 1, "Alice")).toBe(
      "skoobl-OD57CF-round1-alice.png",
    );
    expect(historyPngName("OD57CF", 3, "Big Bob 99!")).toBe(
      "skoobl-OD57CF-round3-big-bob-99.png",
    );
  });
  it("treats an empty artist as own art", () => {
    expect(historyPngName("AAA", 1, "")).toBe("skoobl-AAA-round1.png");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/history.test.ts`
Expected: FAIL — `historyPngName` is not exported / not a function.

- [ ] **Step 3: Implement the helper**

Add to `frontend/src/lib/history.ts` (near the other pure helpers, e.g. just below `renderThumb`):

```ts
// historyPngName builds the download filename for a saved drawing: the room
// code and round, plus a slugified artist name for gallery art (own art has
// none). Slug = lowercase, non-alphanumerics collapsed to single dashes.
export function historyPngName(
  code: string,
  round: number,
  artist?: string,
): string {
  const base = `skoobl-${code}-round${round}`;
  const slug = (artist ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${base}-${slug}.png` : `${base}.png`;
}
```

- [ ] **Step 4: Run the gate**

Run: `npm test -- src/lib/history.test.ts` → Expected: PASS
Run: `npm run typecheck` → Expected: no errors
Run: `npm run lint` → Expected: no errors

- [ ] **Step 5: Hand off for commit** (do NOT commit — report green and wait)

---

### Task 4: Per-round, artist-labeled History layout + PNG download in the viewer

Rewrite `Thumbs` so a host's saved game groups drawings by round with visible artist captions (host's own labeled "you", shown once), while a normal game keeps the simple `Round n` strip. Add a Download PNG button to the viewer.

**Files:**
- Modify: `frontend/src/components/history/HistoryTab.tsx`
- Test: `frontend/src/components/history/HistoryTab.test.tsx`

**Interfaces:**
- Consumes: `historyPngName` (Task 3), `downloadStrokesPng` (from `@/lib/canvas`), `SavedGame`/`SavedDrawing`.
- Produces: internal only. `Selected` becomes `{ title: string; filename: string; drawing: SavedDrawing }`.

- [ ] **Step 1: Write the failing tests**

Replace the body of `frontend/src/components/history/HistoryTab.test.tsx` with the following (keeps the existing three tests, adds gallery-layout + download coverage, and mocks only `downloadStrokesPng` so `StrokesView`'s real canvas helpers keep working):

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertGame } from "@/lib/history";
import { HistoryTab } from "./HistoryTab";

// Mock only downloadStrokesPng; keep drawStrokes/CANVAS_* real for StrokesView.
const downloadSpy = vi.fn();
vi.mock("@/lib/canvas", async (orig) => ({
  ...(await orig<typeof import("@/lib/canvas")>()),
  downloadStrokesPng: (...args: unknown[]) => downloadSpy(...args),
}));

const stroke = [{ color: "#fff", width: 5, points: [{ x: 1, y: 1 }] }];

beforeEach(() => {
  localStorage.clear();
  downloadSpy.mockClear();
});
afterEach(() => localStorage.clear());

describe("HistoryTab", () => {
  it("shows an empty state when there is no history", () => {
    render(<HistoryTab />);
    expect(screen.getByText(/no saved drawings/i)).toBeTruthy();
  });

  it("lists a saved game with its room code", () => {
    upsertGame({
      id: "abc:2026-06-22",
      code: "abc",
      playedAt: 1_000_000,
      you: "me",
      mine: { 1: { prompt: "cat", strokes: stroke, thumb: "" } },
    });
    render(<HistoryTab />);
    expect(screen.getByText(/abc/i)).toBeTruthy();
  });

  it("closes the viewer when Escape is pressed on the focused backdrop", () => {
    upsertGame({
      id: "esc:2026-06-22",
      code: "esc",
      playedAt: 2_000_000,
      you: "me",
      mine: {
        1: { prompt: "dog", strokes: stroke, thumb: "data:image/png;base64,abc" },
      },
    });
    render(<HistoryTab />);
    const tileButton = screen
      .getByRole("img", { name: /round 1/i })
      .closest("button") as HTMLElement;
    act(() => fireEvent.click(tileButton));
    expect(screen.queryByRole("button", { name: /close/i })).toBeTruthy();
    const backdrop = document.activeElement as HTMLElement;
    act(() => fireEvent.keyDown(backdrop, { key: "Escape" }));
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });

  it("groups a gallery game by round with artist captions, host shown once", () => {
    upsertGame({
      id: "OD57CF:2026-06-22",
      code: "OD57CF",
      playedAt: 3_000_000,
      you: "Host",
      mine: { 1: { prompt: "", strokes: stroke, thumb: "" } },
      gallery: {
        1: {
          alice: { prompt: "", strokes: stroke, thumb: "" },
          bob: { prompt: "", strokes: stroke, thumb: "" },
        },
      },
    });
    render(<HistoryTab />);
    // Round heading is visible.
    expect(screen.getByText(/round 1/i)).toBeTruthy();
    // Artist captions are visible text.
    expect(screen.getByText(/alice/i)).toBeTruthy();
    expect(screen.getByText(/bob/i)).toBeTruthy();
    // Host's own art shows once, labeled "you" (not the literal name "Host").
    expect(screen.getByText(/^you$/i)).toBeTruthy();
    expect(screen.queryByText(/^host$/i)).toBeNull();
  });

  it("downloads a PNG with a verbose, slugified filename from the viewer", () => {
    upsertGame({
      id: "OD57CF:2026-06-22",
      code: "OD57CF",
      playedAt: 4_000_000,
      you: "Host",
      mine: {},
      gallery: { 2: { Alice: { prompt: "", strokes: stroke, thumb: "" } } },
    });
    render(<HistoryTab />);
    // Open the only tile (Alice, round 2).
    const tile = screen.getAllByRole("button")[0];
    // The artist tile is among the buttons; open via its caption's tile.
    const aliceTile = screen.getByText(/alice/i).closest("li")
      ?.querySelector("button") as HTMLElement;
    act(() => fireEvent.click(aliceTile ?? tile));
    const dl = screen.getByRole("button", { name: /download/i });
    act(() => fireEvent.click(dl));
    expect(downloadSpy).toHaveBeenCalledWith(
      stroke,
      "skoobl-OD57CF-round2-alice.png",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npm test -- src/components/history/HistoryTab.test.tsx`
Expected: FAIL — no round heading text / no artist captions are rendered, and the viewer has no Download button.

- [ ] **Step 3: Rewrite `HistoryTab.tsx`**

Replace the whole file `frontend/src/components/history/HistoryTab.tsx` with:

```tsx
import { useEffect, useRef, useState } from "react";
import { StrokesView } from "@/components/game/canvas/StrokesView";
import { downloadStrokesPng } from "@/lib/canvas";
import {
  clearHistory,
  deleteGame,
  historyPngName,
  loadHistory,
  type SavedDrawing,
  type SavedGame,
} from "@/lib/history";

// One tile in the history grid: a drawing plus the label shown beneath it, the
// viewer title, and the download filename. `caption` is the small label under
// the thumbnail ("you", an artist name, or "Round n").
interface Tile {
  caption: string;
  title: string;
  filename: string;
  drawing: SavedDrawing;
}

// One round's worth of tiles, used when a host saved everyone's art.
interface RoundGroup {
  round: number;
  tiles: Tile[];
}

const sortedRounds = (obj: Record<number, unknown> | undefined): number[] =>
  Object.keys(obj ?? {})
    .map(Number)
    .sort((a, b) => a - b);

// HistoryTab is the landing-page History panel: a newest-first list of past
// games saved on THIS device. A normal game shows one thumbnail per round; a
// host's "everyone's art" game groups drawings by round with artist captions.
// Tapping a thumbnail opens a full-resolution viewer with a PNG download.
export function HistoryTab() {
  const [games, setGames] = useState<SavedGame[]>(loadHistory);
  const [selected, setSelected] = useState<Tile | null>(null);

  const refresh = () => setGames(loadHistory());
  const remove = (id: string) => {
    deleteGame(id);
    refresh();
  };
  const clearAll = () => {
    clearHistory();
    setGames([]);
  };

  if (games.length === 0) {
    return (
      <p className="rounded-xl border-2 border-dashed border-border px-5 py-10 text-center font-hand text-xl leading-snug text-muted">
        no saved drawings yet — play a game and your art shows up here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs uppercase tracking-widest text-muted">
          {games.length} saved {games.length === 1 ? "game" : "games"}
        </span>
        <button
          type="button"
          className="btn-ghost px-3 py-1.5 text-sm"
          onClick={clearAll}
        >
          Clear all
        </button>
      </div>

      <ul className="flex max-h-[50vh] flex-col gap-4 overflow-auto pr-1">
        {games.map((g) => (
          <li key={g.id} className="card-arcade flex flex-col gap-3 p-3">
            <div className="flex items-center justify-between">
              <span className="font-display text-sm font-bold uppercase tracking-widest">
                {g.code}
              </span>
              <div className="flex items-center gap-3">
                <span className="font-hand text-lg text-muted">
                  {new Date(g.playedAt).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  aria-label={`Delete game ${g.code}`}
                  className="btn-ghost px-2 py-1 text-sm"
                  onClick={() => remove(g.id)}
                >
                  ✕
                </button>
              </div>
            </div>
            <GameBody game={g} onPick={setSelected} />
          </li>
        ))}
      </ul>

      {selected && (
        <Viewer selected={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// GameBody picks the layout: a host game with saved gallery art groups by round
// (artist captions, host's own shown once as "you"); any other game is the
// simple one-per-round strip.
function GameBody({
  game,
  onPick,
}: {
  game: SavedGame;
  onPick: (t: Tile) => void;
}) {
  if (game.gallery && Object.keys(game.gallery).length > 0) {
    return <GalleryRounds game={game} onPick={onPick} />;
  }
  return <OwnStrip game={game} onPick={onPick} />;
}

// OwnStrip renders the player's own drawings, one tile per round.
function OwnStrip({
  game,
  onPick,
}: {
  game: SavedGame;
  onPick: (t: Tile) => void;
}) {
  const tiles: Tile[] = sortedRounds(game.mine).map((r) => ({
    caption: `Round ${r}`,
    title: `Round ${r}`,
    filename: historyPngName(game.code, r),
    drawing: game.mine[r],
  }));
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {tiles.map((t) => (
        <TileButton key={t.title} tile={t} onPick={onPick} />
      ))}
    </ul>
  );
}

// GalleryRounds renders a host's "everyone's art" game grouped by round: the
// host's own drawing first (captioned "you"), then each other artist.
function GalleryRounds({
  game,
  onPick,
}: {
  game: SavedGame;
  onPick: (t: Tile) => void;
}) {
  const rounds = Array.from(
    new Set([...sortedRounds(game.mine), ...sortedRounds(game.gallery)]),
  ).sort((a, b) => a - b);

  const groups: RoundGroup[] = rounds.map((r) => {
    const tiles: Tile[] = [];
    const own = game.mine[r];
    if (own) {
      tiles.push({
        caption: "you",
        title: `Round ${r} · you`,
        filename: historyPngName(game.code, r),
        drawing: own,
      });
    }
    const byArtist = game.gallery?.[r] ?? {};
    for (const artist of Object.keys(byArtist)) {
      tiles.push({
        caption: artist,
        title: `Round ${r} · ${artist}`,
        filename: historyPngName(game.code, r, artist),
        drawing: byArtist[artist],
      });
    }
    return { round: r, tiles };
  });

  return (
    <div className="flex flex-col gap-4">
      {groups.map((grp) => (
        <div key={grp.round} className="flex flex-col gap-2">
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            Round {grp.round}
          </span>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {grp.tiles.map((t) => (
              <TileButton key={t.title} tile={t} onPick={onPick} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// TileButton is one clickable thumbnail with its caption beneath.
function TileButton({
  tile,
  onPick,
}: {
  tile: Tile;
  onPick: (t: Tile) => void;
}) {
  return (
    <li className="flex flex-col gap-1">
      <button
        type="button"
        className="block w-full overflow-hidden rounded-lg border-2 border-border bg-surface"
        onClick={() => onPick(tile)}
      >
        {tile.drawing.thumb ? (
          <img
            src={tile.drawing.thumb}
            alt={tile.title}
            className="aspect-4/3 w-full object-contain"
          />
        ) : (
          <StrokesView strokes={tile.drawing.strokes} />
        )}
      </button>
      <span className="truncate text-center font-hand text-base text-muted">
        {tile.caption}
      </span>
    </li>
  );
}

// Viewer is the full-resolution replay overlay for one picked drawing, with a
// PNG download.
function Viewer({
  selected,
  onClose,
}: {
  selected: Tile;
  onClose: () => void;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    backdropRef.current?.focus();
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss on click/key is intentional; focused on mount so Escape fires here
    <div
      ref={backdropRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 outline-none"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stop-propagation guard, not a semantic element */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stop-propagation guard only; Close button handles keyboard dismiss */}
      <div
        className="flex w-full max-w-2xl flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="font-display text-lg font-bold">
            {selected.title}
            {selected.drawing.prompt ? ` — ${selected.drawing.prompt}` : ""}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-ghost px-3 py-1.5 text-sm"
              onClick={() =>
                downloadStrokesPng(selected.drawing.strokes, selected.filename)
              }
            >
              Download PNG
            </button>
            <button
              type="button"
              className="btn-ghost px-3 py-1.5 text-sm"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
        <StrokesView strokes={selected.drawing.strokes} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/components/history/HistoryTab.test.tsx`
Expected: PASS (all five tests). Note: the "closes the viewer" test still finds the tile via `getByRole("img", { name: /round 1/i })` — the own-strip tile's `<img alt>` is the title `Round 1`.

- [ ] **Step 5: Run the full gate**

Run: `npm test` → Expected: PASS (whole suite, including `history.test.ts`)
Run: `npm run typecheck` → Expected: no errors
Run: `npm run lint` → Expected: no errors

- [ ] **Step 6: Hand off for commit** (do NOT commit — report green and wait)

---

## Self-Review

**Spec coverage:**
- Merge replays per room/day → Task 1 (deterministic id). ✓
- No duplication on disk (host excluded from gallery) → Task 2. ✓
- Group by round + artist captions ("verbose whose art") → Task 4 (`GalleryRounds`, `TileButton` caption). ✓
- Normal player = simple `Round n` strip → Task 4 (`OwnStrip`). ✓
- Per-drawing PNG download in viewer, verbose slugified filename → Task 3 (helper) + Task 4 (Download button). ✓
- Verbose viewer title with prompt when known → Task 4 (`Viewer` title). ✓
- Out of scope (EndedStage, composite, backend) → untouched. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows full test bodies. ✓

**Type consistency:** `historyPngName(code, round, artist?)` defined in Task 3, consumed identically in Task 4. `Selected`→`Tile` shape `{ caption, title, filename, drawing }` defined and used consistently in Task 4. `currentGameId(code)` returns string, no `clearGameId` referenced anywhere post-Task-1. ✓
