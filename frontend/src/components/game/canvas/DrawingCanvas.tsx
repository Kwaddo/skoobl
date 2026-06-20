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
import { Brush, Bucket, Trash, Undo } from "../icons";

// DrawingCanvas is the interactive drawing surface plus its toolbar (color
// picker, pen/fill tools, brush sizes, undo, clear). It owns the strokes and
// reports them up via
// onChange so the parent can submit them. When `disabled`, input is ignored
// (used after the player locks in their drawing). `footer` (e.g. the Lock-in
// button) is rendered with the toolbar — under the tools when tall, in the side
// column when short — so it's never stranded at the bottom of the page.
export function DrawingCanvas({
  disabled = false,
  onChange,
  onStrokeEnd,
  footer,
}: {
  disabled?: boolean;
  onChange?: (strokes: Stroke[]) => void;
  onStrokeEnd?: (strokes: Stroke[]) => void;
  footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [color, setColor] = useState<string>(PALETTE[1]);
  const [width, setWidth] = useState<number>(BRUSHES[1]);
  const [tool, setTool] = useState<"pen" | "fill">("pen");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  const colorRef = useRef<HTMLDivElement>(null);
  const penRef = useRef<HTMLDivElement>(null);
  const drawingRef = useRef(false);

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (ctx) drawStrokes(ctx, strokes);
  }, [strokes]);

  useEffect(() => {
    onChange?.(strokes);
  }, [strokes, onChange]);

  // Close either toolbar popover (color / stroke size) on an outside click.
  useEffect(() => {
    if (!paletteOpen && !sizeOpen) return;
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (colorRef.current && !colorRef.current.contains(t)) {
        setPaletteOpen(false);
      }
      if (penRef.current && !penRef.current.contains(t)) {
        setSizeOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [paletteOpen, sizeOpen]);

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
    if (disabled || !e.isPrimary) return;
    const p = toCanvas(e);
    if (tool === "fill") {
      // A fill is a complete op on press: append the fill stroke and draft it.
      const next = [...strokes, { color, width, points: [p], fill: true }];
      setStrokes(next);
      onStrokeEnd?.(next);
      return;
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drawingRef.current = true;
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
    if (!drawingRef.current) return;
    drawingRef.current = false;
    onStrokeEnd?.(strokes);
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
        <div className="flex shrink-0 flex-col gap-3 short:w-44 short:justify-center short:overflow-y-auto">
          {/* One wrapping cluster: it reflows to fit any width (a row under the
              canvas when tall, a narrow column beside it when short) so no
              control is ever clipped. Every control is a fixed 36px square. */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            {/* Color — a swatch that opens a popover of presets plus a custom
                picker, so common colors are one tap but anything is reachable. */}
            <div className="relative shrink-0" ref={colorRef}>
              <button
                type="button"
                aria-label="pick color"
                title="Pick a color"
                onClick={() => {
                  setSizeOpen(false);
                  setPaletteOpen((o) => !o);
                }}
                className="flex h-9 w-9 items-center justify-center rounded-lg border-2 border-border transition-colors hover:border-muted"
              >
                <span
                  className="h-5 w-5 rounded-md border border-black/20"
                  style={{ backgroundColor: color }}
                />
              </button>
              {paletteOpen && (
                <div className="absolute bottom-full left-0 z-50 mb-2 w-44 rounded-xl border-2 border-border bg-surface-2 p-3 shadow-lg">
                  <div className="grid grid-cols-4 gap-2">
                    {PALETTE.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={`color ${c}`}
                        onClick={() => {
                          setColor(c);
                          setPaletteOpen(false);
                        }}
                        className={`h-7 w-7 rounded-full border-2 transition-transform ${
                          color === c
                            ? "scale-110 border-foreground"
                            : "border-border hover:scale-105"
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                  <label className="mt-3 flex items-center justify-between gap-2 font-mono text-[11px] uppercase tracking-widest text-muted">
                    Custom
                    <input
                      type="color"
                      aria-label="custom color"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                      className="h-7 w-10 cursor-pointer rounded-md border-2 border-border bg-transparent p-0 [&::-webkit-color-swatch-wrapper]:p-0.5 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-0"
                    />
                  </label>
                </div>
              )}
            </div>

            {/* Pen — selecting it also opens a popover with the stroke-size
                slider, mirroring the color control. */}
            <div className="relative shrink-0" ref={penRef}>
              <ToolButton
                label="pen tool"
                title="Pen — stroke size"
                active={tool === "pen"}
                onClick={() => {
                  setPaletteOpen(false);
                  setTool("pen");
                  setSizeOpen((o) => !o);
                }}
              >
                <Brush className="h-5 w-5" />
              </ToolButton>
              {sizeOpen && (
                <div className="absolute bottom-full left-0 z-50 mb-2 w-44 rounded-xl border-2 border-border bg-surface-2 p-3 shadow-lg">
                  <div className="mb-2 flex items-center justify-between font-mono text-[11px] uppercase tracking-widest text-muted">
                    <span>Size</span>
                    <span className="text-foreground">{width}px</span>
                  </div>
                  <input
                    type="range"
                    min={2}
                    max={40}
                    value={width}
                    aria-label="stroke size"
                    onChange={(e) => setWidth(Number(e.target.value))}
                    className="w-full cursor-pointer accent-primary"
                  />
                  {/* Preview the actual stroke diameter (max 40px fits the popover). */}
                  <div className="mt-2 flex h-11 items-center justify-center">
                    <span
                      className="rounded-full bg-foreground"
                      style={{ width: `${width}px`, height: `${width}px` }}
                    />
                  </div>
                </div>
              )}
            </div>
            <ToolButton
              label="fill tool"
              title="Fill"
              active={tool === "fill"}
              onClick={() => {
                setPaletteOpen(false);
                setSizeOpen(false);
                setTool("fill");
              }}
            >
              <Bucket className="h-5 w-5" />
            </ToolButton>

            <ToolButton
              label="undo"
              title="Undo"
              onClick={() => setStrokes((prev) => prev.slice(0, -1))}
              disabled={strokes.length === 0}
            >
              <Undo className="h-5 w-5" />
            </ToolButton>
            <ToolButton
              label="clear"
              title="Clear all"
              onClick={() => setStrokes([])}
              disabled={strokes.length === 0}
            >
              <Trash className="h-5 w-5" />
            </ToolButton>
          </div>

          {footer && <div className="shrink-0">{footer}</div>}
        </div>
      )}
    </div>
  );
}

// ToolButton is one 36px-square control in the drawing toolbar — a toggle (pen /
// fill / brush size) or an action (undo / clear). Active toggles get a primary
// ring; disabled actions dim. Keeping every control the same square size lets the
// toolbar wrap cleanly at any width without anything getting clipped.
function ToolButton({
  label,
  title,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border-2 transition-colors disabled:opacity-40 ${
        active
          ? "border-primary bg-surface-2 text-foreground"
          : "border-border text-muted hover:border-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
