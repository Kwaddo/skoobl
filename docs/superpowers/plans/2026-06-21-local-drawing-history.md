# Local Drawing History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist each device's drawings to `localStorage` and add a History tab on the landing page to browse, replay, and delete past games.

**Architecture:** A React-free `lib/history.ts` module owns all `localStorage` access, thumbnail rendering, the per-game session id, and the host gallery opt-in pref. A pure `buildSavedGame` shapes store data into a `SavedGame`; a thin `useDrawingHistory` hook (mounted in `GameStage`) feeds the live store into it and upserts incrementally. The landing page (`index.tsx`) gains a third Segmented tab rendering a new `HistoryTab` component that reads saved games and replays them with the existing `StrokesView`.

**Tech Stack:** React 19, TypeScript, zustand, TanStack Router, Vitest + jsdom, Biome. Spec: `docs/superpowers/specs/2026-06-21-local-drawing-history-design.md`.

## Global Constraints

- **Storage keys:** `skoobl:history` (localStorage, games), `skoobl:savegallery` (localStorage, host pref), `skoobl:gameid` (sessionStorage, per-game session id). Follow the existing `skoobl:*` namespace (`theme.ts`, `identity.ts`).
- **Retention cap:** `MAX_GAMES = 20`, newest-first. Oldest dropped on overflow or `QuotaExceededError`.
- **Thumbnail size:** 240×180 (matches the 4:3 logical canvas 1000×750). PNG data URL.
- **Best-effort:** history must never throw into gameplay. All `localStorage`/canvas access is wrapped in try/catch and degrades to `[]`/`""`/no-op (matching `theme.ts`'s private-mode handling).
- **Logical coordinate space:** strokes are stored in `CANVAS_W`×`CANVAS_H` space (`lib/canvas.ts`); render via `drawStrokes`. Do not rescale stroke points.
- **Git:** Claude does NOT run `git commit`/`git push` (project rule). Each "Checkpoint" step lists the files to stage and the suggested message — the user commits.
- **Verify before done:** `npm run typecheck`, `npm run lint`, `npm test` all pass.

---

### Task 1: History storage module

**Files:**
- Create: `frontend/src/lib/history.ts`
- Test: `frontend/src/lib/history.test.ts`

**Interfaces:**
- Consumes: `Stroke` from `./protocol`; `CANVAS_W`, `CANVAS_H`, `drawStrokes` from `./canvas`.
- Produces:
  - `interface SavedDrawing { prompt: string; strokes: Stroke[]; thumb: string }`
  - `interface SavedGame { id: string; code: string; playedAt: number; you: string; mine: Record<number, SavedDrawing>; gallery?: Record<number, Record<string, SavedDrawing>> }`
  - `MAX_GAMES: number`
  - `loadHistory(): SavedGame[]`
  - `saveHistory(games: SavedGame[]): boolean`
  - `upsertGame(game: SavedGame): void`
  - `deleteGame(id: string): void`
  - `clearHistory(): void`
  - `renderThumb(strokes: Stroke[]): string`
  - `getSaveGalleryPref(): boolean`
  - `setSaveGalleryPref(on: boolean): void`
  - `currentGameId(code: string): string`
  - `clearGameId(): void`
  - `buildSavedGame(input: BuildInput): SavedGame | null` where
    `interface BuildInput { id: string; code: string; you: string; playedAt: number; myDrawings: Record<number, Stroke[]>; galleryHistory: Record<number, Record<string, Stroke[]>>; saveGallery: boolean; thumb: (strokes: Stroke[]) => string }`

- [ ] **Step 1: Write failing tests**

Create `frontend/src/lib/history.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SavedGame,
  buildSavedGame,
  clearHistory,
  deleteGame,
  getSaveGalleryPref,
  loadHistory,
  MAX_GAMES,
  saveHistory,
  setSaveGalleryPref,
  upsertGame,
} from "./history";

const game = (id: string, over: Partial<SavedGame> = {}): SavedGame => ({
  id,
  code: "abc",
  playedAt: 1000,
  you: "me",
  mine: { 1: { prompt: "cat", strokes: [], thumb: "t" } },
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("loadHistory", () => {
  it("returns [] when empty", () => {
    expect(loadHistory()).toEqual([]);
  });
  it("returns [] on corrupt JSON", () => {
    localStorage.setItem("skoobl:history", "{not json");
    expect(loadHistory()).toEqual([]);
  });
  it("returns [] when stored value is not an array", () => {
    localStorage.setItem("skoobl:history", '{"id":"x"}');
    expect(loadHistory()).toEqual([]);
  });
});

describe("upsertGame", () => {
  it("prepends a new game", () => {
    upsertGame(game("a"));
    upsertGame(game("b"));
    expect(loadHistory().map((g) => g.id)).toEqual(["b", "a"]);
  });
  it("merges rounds into an existing game and keeps original playedAt", () => {
    upsertGame(game("a", { playedAt: 5, mine: { 1: { prompt: "", strokes: [], thumb: "x" } } }));
    upsertGame(game("a", { playedAt: 999, mine: { 2: { prompt: "dog", strokes: [], thumb: "y" } } }));
    const [g] = loadHistory();
    expect(g.playedAt).toBe(5);
    expect(Object.keys(g.mine)).toEqual(["1", "2"]);
  });
  it("caps at MAX_GAMES, dropping oldest", () => {
    for (let i = 0; i < MAX_GAMES + 3; i++) upsertGame(game(`g${i}`));
    const ids = loadHistory().map((g) => g.id);
    expect(ids).toHaveLength(MAX_GAMES);
    expect(ids[0]).toBe(`g${MAX_GAMES + 2}`);
    expect(ids).not.toContain("g0");
  });
});

describe("saveHistory quota fallback", () => {
  it("drops the oldest and retries on QuotaExceededError", () => {
    const games = [game("new"), game("old")];
    let calls = 0;
    // Throw once (simulating a full quota), succeed on the retry. The retry
    // happens only after saveHistory drops the tail, so a success proves the
    // fallback ran. We assert on call count, not a write-through read.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      calls++;
      if (calls === 1) throw new DOMException("quota", "QuotaExceededError");
    });
    expect(saveHistory(games)).toBe(true);
    expect(calls).toBe(2);
  });
  it("gives up (returns false) when a single game still won't fit", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(saveHistory([game("solo")])).toBe(false);
  });
});

describe("deleteGame / clearHistory", () => {
  it("removes one game by id", () => {
    upsertGame(game("a"));
    upsertGame(game("b"));
    deleteGame("a");
    expect(loadHistory().map((g) => g.id)).toEqual(["b"]);
  });
  it("clears everything", () => {
    upsertGame(game("a"));
    clearHistory();
    expect(loadHistory()).toEqual([]);
  });
});

describe("gallery pref", () => {
  it("defaults to false and round-trips", () => {
    expect(getSaveGalleryPref()).toBe(false);
    setSaveGalleryPref(true);
    expect(getSaveGalleryPref()).toBe(true);
  });
});

describe("buildSavedGame", () => {
  const thumb = (s: unknown[]) => `thumb:${s.length}`;
  it("returns null when there is nothing to save", () => {
    const g = buildSavedGame({
      id: "a:1", code: "a", you: "me", playedAt: 7,
      myDrawings: {}, galleryHistory: {}, saveGallery: false, thumb,
    });
    expect(g).toBeNull();
  });
  it("builds mine from non-empty drawings and skips empty ones", () => {
    const g = buildSavedGame({
      id: "a:1", code: "a", you: "me", playedAt: 7,
      myDrawings: { 1: [{ color: "#fff", width: 5, points: [{ x: 1, y: 1 }] }], 2: [] },
      galleryHistory: {}, saveGallery: false, thumb,
    });
    expect(g).not.toBeNull();
    expect(Object.keys(g!.mine)).toEqual(["1"]);
    expect(g!.gallery).toBeUndefined();
  });
  it("includes gallery only when saveGallery is true", () => {
    const input = {
      id: "a:1", code: "a", you: "Host", playedAt: 7,
      myDrawings: {},
      galleryHistory: { 1: { bob: [{ color: "#fff", width: 5, points: [{ x: 1, y: 1 }] }] } },
      thumb,
    };
    expect(buildSavedGame({ ...input, saveGallery: false })).toBeNull();
    const g = buildSavedGame({ ...input, saveGallery: true });
    expect(g!.gallery?.[1]?.bob.thumb).toBe("thumb:1");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd frontend && npx vitest run src/lib/history.test.ts`
Expected: FAIL — module `./history` not found / exports undefined.

- [ ] **Step 3: Implement `frontend/src/lib/history.ts`**

```ts
import { CANVAS_H, CANVAS_W, drawStrokes } from "./canvas";
import type { Stroke } from "./protocol";

// One saved drawing: the replayable strokes plus a cached PNG thumbnail and the
// prompt word (when known — gallery art is often unrevealed, so "").
export interface SavedDrawing {
  prompt: string;
  strokes: Stroke[];
  thumb: string;
}

// One past game saved on this device. `mine` is the player's own drawings keyed
// by round; `gallery` (host opt-in) is every player's drawing, round → name.
export interface SavedGame {
  id: string;
  code: string;
  playedAt: number;
  you: string;
  mine: Record<number, SavedDrawing>;
  gallery?: Record<number, Record<string, SavedDrawing>>;
}

export const MAX_GAMES = 20;
const KEY = "skoobl:history";
const PREF_KEY = "skoobl:savegallery";
const GAME_ID_KEY = "skoobl:gameid";
const THUMB_W = 240;
const THUMB_H = 180;

// loadHistory reads and parses the saved games. Any failure (missing key, bad
// JSON, non-array) yields an empty list — history is best-effort, never fatal.
export function loadHistory(): SavedGame[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedGame[]) : [];
  } catch {
    return [];
  }
}

// saveHistory writes the list (newest-first). On QuotaExceededError it drops the
// oldest game (the tail) and retries until it fits or only one game remains.
// Returns whether the write ultimately succeeded.
export function saveHistory(games: SavedGame[]): boolean {
  let attempt = games;
  while (true) {
    try {
      localStorage.setItem(KEY, JSON.stringify(attempt));
      return true;
    } catch {
      if (attempt.length <= 1) return false;
      attempt = attempt.slice(0, -1);
    }
  }
}

// upsertGame merges a game into history by id (folding new rounds into any prior
// entry, keeping the original playedAt), moves it to the front, and prunes to
// MAX_GAMES.
export function upsertGame(game: SavedGame): void {
  const games = loadHistory();
  const i = games.findIndex((g) => g.id === game.id);
  let merged = game;
  if (i >= 0) {
    const prev = games[i];
    merged = {
      ...prev,
      ...game,
      playedAt: prev.playedAt,
      mine: { ...prev.mine, ...game.mine },
      gallery:
        prev.gallery || game.gallery
          ? { ...(prev.gallery ?? {}), ...(game.gallery ?? {}) }
          : undefined,
    };
    games.splice(i, 1);
  }
  games.unshift(merged);
  saveHistory(games.slice(0, MAX_GAMES));
}

export function deleteGame(id: string): void {
  saveHistory(loadHistory().filter((g) => g.id !== id));
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* private mode — nothing to clear */
  }
}

// renderThumb rasterizes strokes at full logical resolution (so drawStrokes'
// flood-fill math stays correct) then scales the result down into a small
// thumbnail canvas. Returns "" where a 2D context is unavailable (jsdom).
export function renderThumb(strokes: Stroke[]): string {
  const full = document.createElement("canvas");
  full.width = CANVAS_W;
  full.height = CANVAS_H;
  const fctx = full.getContext("2d");
  if (!fctx) return "";
  drawStrokes(fctx, strokes);
  const thumb = document.createElement("canvas");
  thumb.width = THUMB_W;
  thumb.height = THUMB_H;
  const tctx = thumb.getContext("2d");
  if (!tctx) return "";
  tctx.drawImage(full, 0, 0, THUMB_W, THUMB_H);
  try {
    return thumb.toDataURL("image/png");
  } catch {
    return "";
  }
}

export function getSaveGalleryPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSaveGalleryPref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {
    /* private mode — pref just won't persist */
  }
}

// currentGameId returns this game-session's stable id, minting one on first use
// and keeping it in sessionStorage so a reload mid-game re-targets the same
// saved entry. Cleared back in the lobby via clearGameId.
export function currentGameId(code: string): string {
  try {
    const existing = sessionStorage.getItem(GAME_ID_KEY);
    if (existing) return existing;
    const id = `${code}:${Date.now()}`;
    sessionStorage.setItem(GAME_ID_KEY, id);
    return id;
  } catch {
    return `${code}:0`;
  }
}

export function clearGameId(): void {
  try {
    sessionStorage.removeItem(GAME_ID_KEY);
  } catch {
    /* nothing to clear */
  }
}

interface BuildInput {
  id: string;
  code: string;
  you: string;
  playedAt: number;
  myDrawings: Record<number, Stroke[]>;
  galleryHistory: Record<number, Record<string, Stroke[]>>;
  saveGallery: boolean;
  thumb: (strokes: Stroke[]) => string;
}

// buildSavedGame shapes the live store slices into a SavedGame. Pure: the
// thumbnail renderer is injected so it's unit-testable without a canvas.
// Empty drawings are skipped; returns null when there is nothing worth saving.
export function buildSavedGame(input: BuildInput): SavedGame | null {
  const { id, code, you, playedAt, myDrawings, galleryHistory, saveGallery, thumb } = input;

  const mine: Record<number, SavedDrawing> = {};
  for (const [rStr, strokes] of Object.entries(myDrawings)) {
    if (!strokes.length) continue;
    mine[Number(rStr)] = { prompt: "", strokes, thumb: thumb(strokes) };
  }

  let gallery: SavedGame["gallery"];
  if (saveGallery) {
    const acc: Record<number, Record<string, SavedDrawing>> = {};
    for (const [rStr, byArtist] of Object.entries(galleryHistory)) {
      const roundMap: Record<string, SavedDrawing> = {};
      for (const [artist, strokes] of Object.entries(byArtist)) {
        if (!strokes.length) continue;
        roundMap[artist] = { prompt: "", strokes, thumb: thumb(strokes) };
      }
      if (Object.keys(roundMap).length) acc[Number(rStr)] = roundMap;
    }
    if (Object.keys(acc).length) gallery = acc;
  }

  if (!Object.keys(mine).length && !gallery) return null;
  return { id, code, you, playedAt, mine, gallery };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd frontend && npx vitest run src/lib/history.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Typecheck + lint**

Run: `cd frontend && npm run typecheck && npm run lint`
Expected: no errors. (If Biome flags the `while (true)` loop, it is intentional — the body always returns or shrinks; add a `// biome-ignore` only if the rule fires.)

- [ ] **Step 6: Checkpoint (user commits)**

Stage: `frontend/src/lib/history.ts frontend/src/lib/history.test.ts`
Suggested message: `feat(history): add local drawing-history storage module`

---

### Task 2: Capture hook wired into GameStage

**Files:**
- Create: `frontend/src/hooks/use-drawing-history.ts`
- Modify: `frontend/src/components/game/GameStage.tsx` (add hook call near the other hooks, before the `if (!name)` return at line 100)

**Interfaces:**
- Consumes: `buildSavedGame`, `upsertGame`, `currentGameId`, `clearGameId`, `getSaveGalleryPref`, `renderThumb` from `@/lib/history`; `useGameStore` from `@/lib/store`.
- Produces: `useDrawingHistory(code: string, you: string): void`.

- [ ] **Step 1: Implement the hook `frontend/src/hooks/use-drawing-history.ts`**

```ts
import { useEffect, useRef } from "react";
import {
  buildSavedGame,
  clearGameId,
  currentGameId,
  getSaveGalleryPref,
  renderThumb,
  upsertGame,
} from "@/lib/history";
import type { Stroke } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";

// useDrawingHistory persists this device's drawings to localStorage as a game
// plays out. It watches the per-round drawing accumulators and upserts after
// each change, so even an abandoned game keeps what was drawn so far. Thumbnails
// are cached by stroke-array identity (the store keeps a stable reference per
// round once recorded) so unchanged drawings are never re-rasterized.
export function useDrawingHistory(code: string, you: string): void {
  const phase = useGameStore((s) => s.phase);
  const myDrawings = useGameStore((s) => s.myDrawings);
  const galleryHistory = useGameStore((s) => s.galleryHistory);

  const thumbCache = useRef(new WeakMap<Stroke[], string>());

  useEffect(() => {
    // Back in the lobby a fresh game begins: drop the session id so the next
    // game gets its own saved entry, and forget cached thumbs.
    if (phase === "lobby") {
      clearGameId();
      thumbCache.current = new WeakMap();
      return;
    }
    if (!you) return;

    const thumb = (strokes: Stroke[]): string => {
      const hit = thumbCache.current.get(strokes);
      if (hit !== undefined) return hit;
      const t = renderThumb(strokes);
      thumbCache.current.set(strokes, t);
      return t;
    };

    const game = buildSavedGame({
      id: currentGameId(code),
      code,
      you,
      playedAt: Date.now(),
      myDrawings,
      galleryHistory,
      saveGallery: getSaveGalleryPref(),
      thumb,
    });
    if (game) upsertGame(game);
  }, [phase, myDrawings, galleryHistory, code, you]);
}
```

- [ ] **Step 2: Wire it into `GameStage.tsx`**

Add the import alongside the existing imports (after line 6, `import { useGameStore } ...`):

```ts
import { useDrawingHistory } from "@/hooks/use-drawing-history";
```

Then call the hook unconditionally with the other hooks, immediately after the recoverable-error `useEffect` (after line 98) and before `if (!name) return <Navigate to="/" />;` (line 100):

```ts
  // Persist this device's drawings to local history as the game plays.
  useDrawingHistory(code, name ?? "");
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd frontend && npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 4: Manual smoke (optional, recommended)**

Run: `cd frontend && npm run dev`. Host a play-along game with one other tab, draw a stroke, finish a round. In DevTools → Application → Local Storage, confirm a `skoobl:history` entry appears with `mine[1]` populated and a `thumb` data URL.

- [ ] **Step 5: Checkpoint (user commits)**

Stage: `frontend/src/hooks/use-drawing-history.ts frontend/src/components/game/GameStage.tsx`
Suggested message: `feat(history): capture drawings into local history during play`

---

### Task 3: Host opt-in gallery toggle

**Files:**
- Modify: `frontend/src/components/game/stages/HostConfig.tsx` (add a "Save gallery" row using the existing `Row` + `Segmented`)

**Interfaces:**
- Consumes: `getSaveGalleryPref`, `setSaveGalleryPref` from `@/lib/history`; existing `Row`, `Segmented`.
- Produces: no new exports (UI only).

- [ ] **Step 1: Add the pref import**

In `HostConfig.tsx`, add after the existing `import { useGameStore } from "@/lib/store";` (line 4):

```ts
import { getSaveGalleryPref, setSaveGalleryPref } from "@/lib/history";
```

- [ ] **Step 2: Add local pref state**

Inside `HostConfig`, after the `categories` state (line 39):

```ts
  // Device-local pref (not a game setting): also archive every player's drawing
  // to THIS device's history. Persisted to localStorage, never sent to the server.
  const [saveGallery, setSaveGallery] = useState(getSaveGalleryPref);
```

- [ ] **Step 3: Render the toggle row**

After the closing `</Row>` of the Categories row (line 142, before the custom-categories animated `<div>`), add:

```tsx
      <Row label="Save everyone's art here">
        <Segmented
          value={saveGallery ? "on" : "off"}
          options={[
            { value: "off" as const, label: "Off" },
            { value: "on" as const, label: "On" },
          ]}
          onChange={(v) => {
            const on = v === "on";
            setSaveGallery(on);
            setSaveGalleryPref(on);
          }}
        />
      </Row>
```

- [ ] **Step 4: Typecheck + lint**

Run: `cd frontend && npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 5: Checkpoint (user commits)**

Stage: `frontend/src/components/game/stages/HostConfig.tsx`
Suggested message: `feat(history): host toggle to archive the room gallery locally`

---

### Task 4: History tab on the landing page

**Files:**
- Create: `frontend/src/components/history/HistoryTab.tsx`
- Create: `frontend/src/components/history/HistoryTab.test.tsx`
- Modify: `frontend/src/routes/index.tsx` (widen `Tab` union, always render `Segmented` with a History option visible on mobile, render `HistoryTab` for the history tab, hide the Join/Host button on history)

**Interfaces:**
- Consumes: `loadHistory`, `deleteGame`, `clearHistory`, `type SavedGame`, `type SavedDrawing` from `@/lib/history`; `StrokesView` from `@/components/game/canvas/StrokesView`.
- Produces: `HistoryTab(): JSX.Element` (default-free named export).

- [ ] **Step 1: Write a failing render test**

Create `frontend/src/components/history/HistoryTab.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertGame } from "@/lib/history";
import { HistoryTab } from "./HistoryTab";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("HistoryTab", () => {
  it("shows an empty state when there is no history", () => {
    render(<HistoryTab />);
    expect(screen.getByText(/no saved drawings/i)).toBeTruthy();
  });

  it("lists a saved game with its room code", () => {
    upsertGame({
      id: "abc:1",
      code: "abc",
      playedAt: 1_000_000,
      you: "me",
      mine: {
        1: { prompt: "cat", strokes: [{ color: "#fff", width: 5, points: [{ x: 1, y: 1 }] }], thumb: "" },
      },
    });
    render(<HistoryTab />);
    expect(screen.getByText(/abc/i)).toBeTruthy();
  });
});
```

Note: `@testing-library/jest-dom` is not a dependency here; assert on truthiness of `getBy*` results (which throw when missing), matching the project's existing tests in `stages.test.tsx`. Verify that pattern there before writing assertions.

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd frontend && npx vitest run src/components/history/HistoryTab.test.tsx`
Expected: FAIL — `./HistoryTab` not found.

- [ ] **Step 3: Implement `frontend/src/components/history/HistoryTab.tsx`**

```tsx
import { useState } from "react";
import { StrokesView } from "@/components/game/canvas/StrokesView";
import {
  clearHistory,
  deleteGame,
  loadHistory,
  type SavedDrawing,
  type SavedGame,
} from "@/lib/history";

// A flat drawing entry for the expanded viewer: a round's own drawing or a
// gallery artist's drawing.
interface Selected {
  title: string;
  drawing: SavedDrawing;
}

// HistoryTab is the landing-page History panel: a newest-first list of past
// games saved on THIS device, each a strip of round thumbnails. Tapping a
// thumbnail opens a full-resolution replay. Games can be removed individually or
// all at once. Reads localStorage into local state on mount; mutations refresh it.
export function HistoryTab() {
  const [games, setGames] = useState<SavedGame[]>(loadHistory);
  const [selected, setSelected] = useState<Selected | null>(null);

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
            <Thumbs game={g} onPick={setSelected} />
          </li>
        ))}
      </ul>

      {selected && (
        <Viewer selected={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// Thumbs renders a game's round thumbnails: the player's own drawings first,
// then any saved gallery art (round → artist). Each opens the viewer on click.
function Thumbs({
  game,
  onPick,
}: {
  game: SavedGame;
  onPick: (s: Selected) => void;
}) {
  const tiles: Selected[] = [];
  for (const r of Object.keys(game.mine).map(Number).sort((a, b) => a - b)) {
    tiles.push({ title: `Round ${r}`, drawing: game.mine[r] });
  }
  for (const r of Object.keys(game.gallery ?? {}).map(Number).sort((a, b) => a - b)) {
    const byArtist = game.gallery?.[r] ?? {};
    for (const artist of Object.keys(byArtist)) {
      tiles.push({ title: `Round ${r} · ${artist}`, drawing: byArtist[artist] });
    }
  }

  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {tiles.map((t) => (
        <li key={t.title}>
          <button
            type="button"
            className="block w-full overflow-hidden rounded-lg border-2 border-border bg-surface"
            onClick={() => onPick(t)}
          >
            {t.drawing.thumb ? (
              <img
                src={t.drawing.thumb}
                alt={t.title}
                className="aspect-[4/3] w-full object-contain"
              />
            ) : (
              <StrokesView strokes={t.drawing.strokes} />
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

// Viewer is the full-resolution replay overlay for one picked drawing.
function Viewer({
  selected,
  onClose,
}: {
  selected: Selected;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="presentation"
    >
      <div
        className="flex w-full max-w-2xl flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
        role="presentation"
      >
        <div className="flex items-center justify-between">
          <span className="font-display text-lg font-bold">
            {selected.title}
            {selected.drawing.prompt ? ` — ${selected.drawing.prompt}` : ""}
          </span>
          <button
            type="button"
            className="btn-ghost px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <StrokesView strokes={selected.drawing.strokes} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd frontend && npx vitest run src/components/history/HistoryTab.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire the tab into `index.tsx`**

(a) Widen the `Tab` type (line 16):

```ts
type Tab = "join" | "host" | "history";
```

(b) Add the import (after line 3, `import { Segmented } ...`):

```ts
import { HistoryTab } from "@/components/history/HistoryTab";
```

(c) Replace the mobile-gated Segmented block (lines 154–165) so the control always renders, History always appears, and Host is desktop-only:

```tsx
          {/* tabs — hosting needs a big screen, so phones only get Join + History */}
          <Segmented
            value={tab}
            onChange={(v) => switchTab(v)}
            options={
              isMobile
                ? [
                    { value: "join" as const, label: "Join" },
                    { value: "history" as const, label: "History" },
                  ]
                : [
                    { value: "join" as const, label: "Join a room" },
                    { value: "host" as const, label: "Host a game" },
                    { value: "history" as const, label: "History" },
                  ]
            }
            itemClassName="flex-1 px-4 py-2.5 text-sm font-bold"
          />
```

(d) Render `HistoryTab` for the history tab. Change the body conditional (line 173, currently `{tab === "join" ? (...) : (...host...)}`) to handle three tabs. Replace the opening of that ternary so history short-circuits first:

```tsx
            {tab === "history" ? (
              <HistoryTab />
            ) : tab === "join" ? (
```

Leave the existing join (`<> ... </>`) and host (`<div> ... </div>`) branches as the remaining `? :` arms.

(e) Hide the primary action button on the history tab. Wrap the `<button ... onClick={tab === "host" ? host : join}>` block (lines 255–270) so it only renders when not on history:

```tsx
          {tab !== "history" && (
            <button
              type="button"
              className="btn-key w-full px-6 py-4 text-lg"
              onClick={tab === "host" ? host : join}
              disabled={busy}
            >
              {tab === "host"
                ? busy
                  ? "Creating room…"
                  : hostMode === "play"
                    ? "Host & play"
                    : "Host a game"
                : busy
                  ? "Joining…"
                  : "Join room"}
            </button>
          )}
```

(f) The existing `useEffect` that pins mobile away from Host (lines 49–51) already keeps mobile off the (now-absent) Host option; leave it. It does not affect History.

- [ ] **Step 6: Typecheck + lint + full test run**

Run: `cd frontend && npm run typecheck && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 7: Manual smoke (recommended)**

Run: `cd frontend && npm run dev`. On the landing page: confirm a "History" tab appears (also when narrowing to mobile width). After playing a game, confirm past drawings list, thumbnails render, clicking opens the full replay, delete and Clear-all work, and a page reload preserves the list.

- [ ] **Step 8: Checkpoint (user commits)**

Stage: `frontend/src/components/history/HistoryTab.tsx frontend/src/components/history/HistoryTab.test.tsx frontend/src/routes/index.tsx`
Suggested message: `feat(history): add History tab to the landing page`

---

## Self-Review

**Spec coverage:**
- Data model (`SavedDrawing`/`SavedGame`, `skoobl:history`) → Task 1. ✓
- Storage module (load/save/upsert/delete/clear/renderThumb/pref/gameId) → Task 1. ✓
- Quota fallback + cap → Task 1 (`saveHistory`, `upsertGame`). ✓
- Capture flow (incremental, session id, lobby reset, decoupled from store) → Task 2. ✓
- Opt-in host gallery → Task 1 pref + Task 3 toggle + Task 2 `saveGallery` wiring. ✓
- History tab (landing, mobile-visible, grid, replay, delete, clear, empty state) → Task 4. ✓
- Strokes + cached PNG thumbnail format → Task 1 `renderThumb` + Task 4 `<img>`/`StrokesView` fallback. ✓
- Testing (history.test.ts: upsert/merge, cap, quota, corrupt-load, pref; build shaping) → Task 1; component render → Task 4. ✓
- Out-of-scope items (no sync, no backfill, no IndexedDB) → not built. ✓

**Type consistency:** `SavedDrawing`/`SavedGame` defined in Task 1 are imported unchanged in Tasks 2 and 4. `buildSavedGame`'s `BuildInput` matches the hook's call site (Task 2). `getSaveGalleryPref`/`setSaveGalleryPref` names consistent across Tasks 1/2/3. `renderThumb`/`currentGameId`/`clearGameId` consistent Tasks 1/2.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows the test body and the exact run command with expected result.

**Note on the quota test (Task 1, Step 1):** the `setItem` mock returns without persisting on the success call, so the test asserts on call count (`calls === 2`), not on a subsequent read — keeping it independent of how the mock writes through. If preferred, simplify by asserting only that `saveHistory` returns `true` after one throw.
