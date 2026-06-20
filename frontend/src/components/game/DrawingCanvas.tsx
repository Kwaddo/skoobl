import {
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  BRUSHES,
  CANVAS_H,
  CANVAS_W,
  drawStrokes,
  PALETTE,
} from "@/lib/canvas";
import type { Point, Stroke } from "@/lib/protocol";

// DrawingCanvas is the interactive drawing surface plus its toolbar (color
// palette, brush sizes, undo, clear). It owns the strokes and reports them up via
// onChange so the parent can submit them. When `disabled`, input is ignored
// (used after the player locks in their drawing). `footer` (e.g. the Lock-in
// button) is rendered with the toolbar — under the tools when tall, in the side
// column when short — so it's never stranded at the bottom of the page.
export function DrawingCanvas({
  disabled = false,
  onChange,
  footer,
}: {
  disabled?: boolean;
  onChange?: (strokes: Stroke[]) => void;
  footer?: React.ReactNode;
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
    // Ignore secondary touches (a second finger during a pinch) so they don't
    // start a stray stroke; only the primary pointer draws.
    if (disabled || !e.isPrimary) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drawingRef.current = true;
    const p = toCanvas(e);
    setStrokes((prev) => [...prev, { color, width, points: [p] }]);
  };

  const move = (e: PointerEvent) => {
    if (disabled || !drawingRef.current || !e.isPrimary) return;
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
    // Fills its slot; the canvas scales to fit. When the viewport is short, the
    // toolbar moves to a column beside the canvas (instead of below, where it'd
    // get cut off) so drawing always has room. ↓ tuned at 760px tall.
    <div className="flex h-full min-h-0 flex-col items-stretch justify-center gap-3 short:flex-row short:justify-center short:gap-4">
      {/* Canvas area grows to fill the leftover space (flex-1) in both layouts:
          stacked, it claims the height above the tools so the canvas scales up as
          large as the phone allows; short/landscape, it claims the width beside
          the tools. flex (not grid) makes max-h-full reliably bound the canvas. */}
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <canvas
          ref={ref}
          width={CANVAS_W}
          height={CANVAS_H}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          onPointerCancel={end}
          className={`max-h-full max-w-full touch-none select-none rounded-2xl border-2 border-border bg-surface ${
            disabled ? "opacity-70" : "cursor-crosshair"
          }`}
        />
      </div>

      {!disabled && (
        <div className="flex shrink-0 flex-col gap-3 short:w-44 short:justify-center short:overflow-auto">
          <div className="flex items-center justify-between gap-3 short:flex-col short:items-stretch short:gap-3">
            <div className="flex flex-wrap items-center gap-2 short:justify-center">
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

            <div className="flex items-center gap-2 short:flex-wrap short:justify-center">
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

          {footer && <div className="shrink-0">{footer}</div>}
        </div>
      )}
    </div>
  );
}
