import { useEffect, useRef } from "react";
import { CANVAS_H, CANVAS_W, drawStrokes } from "@/lib/canvas";
import type { Stroke } from "@/lib/protocol";

// StrokesView is a read-only render of a drawing — used in the guessing and
// reveal phases. It scales responsively while keeping the fixed logical
// resolution, so the picture looks identical to how the artist drew it.
export function StrokesView({
  strokes,
  className,
}: {
  strokes: Stroke[];
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (ctx) drawStrokes(ctx, strokes ?? []);
  }, [strokes]);

  return (
    <canvas
      ref={ref}
      width={CANVAS_W}
      height={CANVAS_H}
      className={
        className ??
        "aspect-[4/3] w-full rounded-2xl border-2 border-border bg-surface"
      }
    />
  );
}
