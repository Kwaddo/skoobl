import { useCallback, useEffect, useState } from "react";
import type { Stroke } from "@/lib/protocol";
import { StrokesView } from "../canvas/StrokesView";
import { HOST_CANVAS, HOST_CANVAS_BOX } from "./host-canvas";

// DrawingCarousel cycles through every drawing of the game on the host TV,
// auto-advancing every few seconds with manual prev/next. Each slide names the
// artist and round.
export function DrawingCarousel({
  items,
}: {
  items: { round: number; artist: string; strokes: Stroke[] }[];
}) {
  const [idx, setIdx] = useState(0);
  const n = items.length;
  const go = useCallback((d: number) => setIdx((p) => (p + d + n) % n), [n]);

  useEffect(() => {
    if (n <= 1) return;
    const t = setInterval(() => setIdx((p) => (p + 1) % n), 3200);
    return () => clearInterval(t);
  }, [n]);

  const safe = Math.min(idx, n - 1);
  const cur = items[safe];
  if (!cur) return null;

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div
        className={`relative aspect-[4/3] lg:aspect-auto lg:min-h-0 lg:flex-1 ${HOST_CANVAS_BOX}`}
      >
        <StrokesView strokes={cur.strokes} className={HOST_CANVAS} />
        {n > 1 && (
          <>
            <button
              type="button"
              aria-label="previous drawing"
              onClick={() => go(-1)}
              className="absolute left-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border-2 border-border bg-surface-2/80 text-2xl leading-none text-foreground backdrop-blur transition-colors hover:border-foreground"
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="next drawing"
              onClick={() => go(1)}
              className="absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border-2 border-border bg-surface-2/80 text-2xl leading-none text-foreground backdrop-blur transition-colors hover:border-foreground"
            >
              ›
            </button>
          </>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-baseline justify-center gap-x-2 text-center">
        <span className="font-display text-xl font-bold">
          drawn by{" "}
          <span dir="auto" className="text-primary">
            {cur.artist}
          </span>
        </span>
        <span className="font-mono text-xs uppercase tracking-widest text-muted">
          round {cur.round} · {safe + 1}/{n}
        </span>
      </div>
    </div>
  );
}
