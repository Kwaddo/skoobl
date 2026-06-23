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

// Deep-merge two galleries (round → artist → drawing): incoming artists win,
// but artists only present in `prev` for a shared round are preserved. Returns
// undefined when neither side has any gallery data.
function mergeGallery(
  prev: SavedGame["gallery"],
  next: SavedGame["gallery"],
): SavedGame["gallery"] {
  if (!prev && !next) return undefined;
  const out: Record<number, Record<string, SavedDrawing>> = {};
  for (const [r, byArtist] of Object.entries(prev ?? {})) {
    out[Number(r)] = { ...byArtist };
  }
  for (const [r, byArtist] of Object.entries(next ?? {})) {
    out[Number(r)] = { ...(out[Number(r)] ?? {}), ...byArtist };
  }
  return out;
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
      gallery: mergeGallery(prev.gallery, game.gallery),
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

// Defaults ON: by default every device archives everyone's revealed art so any
// player can browse the whole game in History (not just the host). Only an
// explicit opt-out ("0") turns it off.
export function getSaveGalleryPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setSaveGalleryPref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {
    /* private mode — pref just won't persist */
  }
}

// currentGameId is this game's stable id: the room code plus the local
// calendar date (YYYY-MM-DD). Deterministic, so replaying the same room on the
// same day merges into one saved entry instead of piling up new cards.
export function currentGameId(code: string): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${code}:${day}`;
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
  const {
    id,
    code,
    you,
    playedAt,
    myDrawings,
    galleryHistory,
    saveGallery,
    thumb,
  } = input;

  const mine: Record<number, SavedDrawing> = {};
  for (const [rStr, strokes] of Object.entries(myDrawings)) {
    if (!strokes?.length) continue;
    mine[Number(rStr)] = { prompt: "", strokes, thumb: thumb(strokes) };
  }

  let gallery: SavedGame["gallery"];
  if (saveGallery) {
    const acc: Record<number, Record<string, SavedDrawing>> = {};
    for (const [rStr, byArtist] of Object.entries(galleryHistory)) {
      const roundMap: Record<string, SavedDrawing> = {};
      for (const [artist, strokes] of Object.entries(byArtist)) {
        // The host's own art is already stored in `mine`; never duplicate it
        // into the gallery.
        if (artist === you) continue;
        if (!strokes?.length) continue;
        roundMap[artist] = { prompt: "", strokes, thumb: thumb(strokes) };
      }
      if (Object.keys(roundMap).length) acc[Number(rStr)] = roundMap;
    }
    if (Object.keys(acc).length) gallery = acc;
  }

  if (!Object.keys(mine).length && !gallery) return null;
  return { id, code, you, playedAt, mine, gallery };
}
