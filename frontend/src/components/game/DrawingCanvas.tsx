import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { BRUSHES, CANVAS_H, CANVAS_W, drawStrokes, PALETTE } from "@/lib/canvas";
import type { Point, Stroke } from "@/lib/protocol";

// DrawingCanvas is the interactive drawing surface plus its toolbar (color
// palette, brush sizes, undo, clear). It owns the strokes and reports them up via
// onChange so the parent can submit them. When `disabled`, input is ignored
// (used after the player locks in their drawing).
export function DrawingCanvas({
  disabled = false,
  onChange,
}: {
  disabled?: boolean;
  onChange?: (strokes: Stroke[]) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [color, setColor] = useState<string>(PALETTE[1]);
  const [width, setWidth] = useState<number>(BRUSHES[1]);
  const drawingRef = useRef(false);

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (ctx) drawStrokes(ctx, strokes);
  }, [strokes]);

  useEffect(() => {
    onChange?.(strokes);
  }, [strokes, onChange]);

  const toCanvas = useCallback((e: PointerEvent): Point => {
    const c = ref.current;
    if (!c) return { x: 0, y: 0 };
    const rect = c.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
    const y = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
    return {
      x: Math.max(0, Math.min(CANVAS_W, x)),
      y: Math.max(0, Math.min(CANVAS_H, y)),
    };
  }, []);

  const start = (e: PointerEvent) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drawingRef.current = true;
    const p = toCanvas(e);
    setStrokes((prev) => [...prev, { color, width, points: [p] }]);
  };

  const move = (e: PointerEvent) => {
    if (disabled || !drawingRef.current) return;
    const p = toCanvas(e);
    setStrokes((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      const cur = next[next.length - 1];
      next[next.length - 1] = { ...cur, points: [...cur.points, p] };
      return next;
    });
  };

  const end = () => {
    drawingRef.current = false;
  };

  return (
    <div className="flex flex-col gap-3">
      <canvas
        ref={ref}
        width={CANVAS_W}
        height={CANVAS_H}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
        className={`aspect-[4/3] w-full touch-none rounded-2xl border-2 border-border bg-surface ${
          disabled ? "opacity-70" : "cursor-crosshair"
        }`}
      />

      {!disabled && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`color ${c}`}
                onClick={() => setColor(c)}
                className={`h-8 w-8 rounded-full border-2 transition-transform ${
                  color === c
                    ? "scale-110 border-foreground"
                    : "border-border hover:scale-105"
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {BRUSHES.map((b) => (
              <button
                key={b}
                type="button"
                aria-label={`brush ${b}`}
                onClick={() => setWidth(b)}
                className={`flex h-9 w-9 items-center justify-center rounded-lg border-2 ${
                  width === b
                    ? "border-primary bg-surface-2"
                    : "border-border hover:border-muted"
                }`}
              >
                <span
                  className="rounded-full bg-foreground"
                  style={{
                    width: `${Math.max(4, b / 2)}px`,
                    height: `${Math.max(4, b / 2)}px`,
                  }}
                />
              </button>
            ))}
            <button
              type="button"
              className="btn-ghost px-3 py-2 text-sm"
              onClick={() => setStrokes((prev) => prev.slice(0, -1))}
              disabled={strokes.length === 0}
            >
              Undo
            </button>
            <button
              type="button"
              className="btn-ghost px-3 py-2 text-sm"
              onClick={() => setStrokes([])}
              disabled={strokes.length === 0}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
