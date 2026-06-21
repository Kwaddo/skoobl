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
