import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { HexColorInput, HexColorPicker } from "react-colorful";
import { createPortal } from "react-dom";
import {
  BRUSHES,
  CANVAS_H,
  CANVAS_W,
  drawStrokes,
  PALETTE,
  rgbToHex,
  strokePath,
} from "@/lib/canvas";
import type { Point, Powerup, Stroke } from "@/lib/protocol";
import { EffectLayer } from "../display/EffectLayer";
import { Brush, Bucket, Pipette, Trash, Undo } from "../icons";

// DrawingCanvas is the interactive drawing surface plus its toolbar (color
// picker, pen/fill/eyedropper tools, brush sizes, undo, clear). It owns the strokes in a
// ref and reports them up via onChange / onDraftAppend / onDraftReplace so the
// parent can submit them. When `disabled`, input is ignored (used after the
// player locks in their drawing). `footer` (e.g. the Lock-in button) is
// rendered with the toolbar — under the tools when tall, in the side column
// when short — so it's never stranded at the bottom of the page.
export function DrawingCanvas({
  disabled = false,
  effects = new Set<Powerup>(),
  onChange,
  onDraftAppend,
  onDraftReplace,
  footer,
}: {
  disabled?: boolean;
  effects?: Set<Powerup>;
  onChange?: (strokes: Stroke[]) => void;
  onDraftAppend?: (strokes: Stroke[]) => void;
  onDraftReplace?: (strokes: Stroke[]) => void;
  footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState<string>(PALETTE[1]);
  const [width, setWidth] = useState<number>(BRUSHES[1]);
  const [tool, setTool] = useState<"pen" | "fill" | "eyedrop">("pen");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  // `count` drives only the undo/clear enabled state — it updates once per
  // committed change (stroke end / fill / undo / clear), never per point.
  const [count, setCount] = useState(0);
  const colorRef = useRef<HTMLDivElement>(null);
  const penRef = useRef<HTMLDivElement>(null);

  // Strokes are the source of truth, held imperatively so the hot pointer path
  // never touches React state.
  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef(false);
  const rectRef = useRef<DOMRect | null>(null);
  // Offscreen baseline buffer holding every stroke committed BEFORE the active
  // one. While drawing we restore this and repaint only the live stroke over it
  // each frame, so overlapping segments of the stroke are never double-painted.
  const offRef = useRef<HTMLCanvasElement | null>(null);
  // Offscreen compositor. Each frame we assemble `baseline + live stroke` here,
  // then present the visible (desynchronized) canvas with a SINGLE drawImage of
  // this buffer. A desynchronized backbuffer can scan out to the screen
  // asynchronously to our JS, so wiping-then-repainting directly on it lets the
  // display catch the half-cleared intermediate state (a tear/flicker on fast
  // strokes). Composing off-screen and blitting once means the visible canvas
  // only ever transitions between two complete frames — nothing half-drawn to
  // tear to.
  const frameRef = useRef<HTMLCanvasElement | null>(null);
  // Draft-sync bookkeeping: how many strokes the server already has, and whether
  // the last change was destructive (undo/clear → must replace, not append).
  const syncedRef = useRef(0);
  const destructiveRef = useRef(false);
  const flushTimerRef = useRef<number | null>(null);
  const pendingRef = useRef(false);
  // True once the active stroke has moved: while a stroke is being drawn we can't
  // append it (it's still growing — an append would freeze it at its current
  // points and later additions would be lost or duplicated), so a live stroke is
  // synced with a full replace instead. A pure tap never moves, so it still uses
  // the cheap append path.
  const liveRef = useRef(false);

  const crampLocked = effects.has("cramp");
  const inputDisabled = disabled || crampLocked;

  // On a short, wide viewport (a low browser window in landscape) a bottom bar
  // would steal the scarce vertical room from the canvas. Past this breakpoint we
  // move the bar into a side column so the canvas can take the full height.
  const [sideBar, setSideBar] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(
      "(max-height: 700px) and (orientation: landscape)",
    );
    const sync = () => setSideBar(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // `desynchronized` is the low-latency inking hint: it lets the browser skip
  // some compositing sync so strokes track the pointer with minimal lag. We do
  // NOT set `willReadFrequently` — that would pin the canvas to the CPU backend
  // (killing GPU acceleration on the hot pen path); the only pixel reads are a
  // single getImageData per flood-fill or eyedropper tap, fine on a GPU context.
  const getCtx = useCallback(
    () => ref.current?.getContext("2d", { desynchronized: true }) ?? null,
    [],
  );

  const redrawAll = useCallback(() => {
    const ctx = getCtx();
    if (ctx) drawStrokes(ctx, strokesRef.current);
  }, [getCtx]);

  // offCtx returns the offscreen baseline buffer's context, allocating lazily.
  const offCtx = useCallback(() => {
    let off = offRef.current;
    if (!off) {
      off = document.createElement("canvas");
      off.width = CANVAS_W;
      off.height = CANVAS_H;
      offRef.current = off;
    }
    return off.getContext("2d");
  }, []);

  // frameCtx returns the offscreen compositor's context, allocating lazily.
  const frameCtx = useCallback(() => {
    let frame = frameRef.current;
    if (!frame) {
      frame = document.createElement("canvas");
      frame.width = CANVAS_W;
      frame.height = CANVAS_H;
      frameRef.current = frame;
    }
    return frame.getContext("2d");
  }, []);

  // snapshotCommitted copies the live canvas (everything already painted) into the
  // offscreen buffer — the baseline restored behind each frame of the live stroke.
  const snapshotCommitted = useCallback(() => {
    const main = ref.current;
    const octx = offCtx();
    if (!main || !octx) return;
    octx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    octx.drawImage(main, 0, 0);
  }, [offCtx]);

  // paintLive assembles one frame in the offscreen compositor — the committed
  // baseline plus the in-progress stroke — then presents it to the visible
  // (desynchronized) canvas in a SINGLE drawImage, so the screen never catches a
  // half-cleared state mid-stroke (see frameRef). We draw only the REAL sampled
  // points — no speculative predicted tail. Browser pointer prediction
  // (getPredictedEvents) overshoots on fast strokes, painting a ghost line ahead
  // of the cursor that flickers as it's corrected and wiped each frame; the
  // coalesced real samples already keep fast strokes smooth, so prediction isn't
  // worth that artifact. Drawing the whole live stroke each frame keeps it pixel-
  // identical to drawStrokes (so smoothing matches what everyone else renders) at
  // a cost of just one stroke.
  const paintLive = useCallback(() => {
    const ctx = getCtx();
    if (!ctx) return;
    const off = offRef.current;
    const fctx = frameCtx();
    const frame = frameRef.current;
    if (!off || !fctx || !frame) {
      drawStrokes(ctx, strokesRef.current); // no buffer yet: full redraw
      return;
    }
    // Lay the opaque baseline down first — it covers the whole buffer, so it
    // fully overwrites the prior frame and no clear is needed — then the live
    // stroke over it.
    fctx.drawImage(off, 0, 0);
    const cur = strokesRef.current[strokesRef.current.length - 1];
    if (cur && !cur.fill) {
      strokePath(fctx, cur.color, cur.width, cur.points);
    }
    ctx.drawImage(frame, 0, 0); // single atomic present to the visible canvas
  }, [getCtx, frameCtx]);

  // Paint the background once on mount and keep the cached rect fresh on resize
  // (instead of reading getBoundingClientRect on every pointer move).
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    redrawAll();
    rectRef.current = c.getBoundingClientRect();
    const ro = new ResizeObserver(() => {
      rectRef.current = c.getBoundingClientRect();
    });
    ro.observe(c);
    return () => {
      ro.disconnect();
      if (flushTimerRef.current != null)
        window.clearTimeout(flushTimerRef.current);
    };
  }, [redrawAll]);

  // doFlush emits one draft delta: a full replace after a destructive edit or
  // while a stroke is being drawn live (its last stroke is still growing), else
  // the completed strokes appended since the last sync.
  const doFlush = useCallback(() => {
    const strokes = strokesRef.current;
    if (destructiveRef.current || liveRef.current) {
      destructiveRef.current = false;
      syncedRef.current = strokes.length;
      onDraftReplace?.(strokes);
    } else if (strokes.length > syncedRef.current) {
      const tail = strokes.slice(syncedRef.current);
      syncedRef.current = strokes.length;
      onDraftAppend?.(tail);
    }
  }, [onDraftAppend, onDraftReplace]);

  // scheduleFlush throttles draft emits to ~120ms, coalescing bursts (rapid points
  // mid-stroke, or rapid taps) into a single trailing delta. Destructive changes
  // (undo/clear) bypass throttling and flush immediately.
  const scheduleFlush = useCallback(() => {
    if (destructiveRef.current) {
      // Cancel any pending throttle and flush now so the replace fires immediately.
      if (flushTimerRef.current != null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
        pendingRef.current = false;
      }
      doFlush();
      return;
    }
    if (flushTimerRef.current != null) {
      pendingRef.current = true;
      return;
    }
    doFlush();
    flushTimerRef.current = window.setTimeout(function tick() {
      flushTimerRef.current = null;
      if (pendingRef.current) {
        pendingRef.current = false;
        doFlush();
        flushTimerRef.current = window.setTimeout(tick, 120);
      }
    }, 120);
  }, [doFlush]);

  const commit = useCallback(() => {
    setCount(strokesRef.current.length);
    onChange?.(strokesRef.current);
    scheduleFlush();
  }, [onChange, scheduleFlush]);

  const toCanvas = useCallback((clientX: number, clientY: number): Point => {
    const rect = rectRef.current ?? ref.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const x = ((clientX - rect.left) / rect.width) * CANVAS_W;
    const y = ((clientY - rect.top) / rect.height) * CANVAS_H;
    return {
      x: Math.max(0, Math.min(CANVAS_W, x)),
      y: Math.max(0, Math.min(CANVAS_H, y)),
    };
  }, []);

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (inputDisabled || !e.isPrimary) return;
    rectRef.current = ref.current?.getBoundingClientRect() ?? rectRef.current;
    const p = toCanvas(e.clientX, e.clientY);
    if (tool === "eyedrop") {
      // Sample the single pixel under the tap and adopt its color. The canvas is
      // painted on an opaque background, so every point yields a real color (the
      // backdrop where empty, a stroke's color where drawn) — never transparent.
      // Then snap straight back to the pen so the next stroke uses the new color.
      const ctx = getCtx();
      if (ctx) {
        const x = Math.min(CANVAS_W - 1, Math.max(0, Math.floor(p.x)));
        const y = Math.min(CANVAS_H - 1, Math.max(0, Math.floor(p.y)));
        const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
        setColor(rgbToHex(r, g, b));
      }
      setTool("pen");
      return;
    }
    if (tool === "fill") {
      strokesRef.current = [
        ...strokesRef.current,
        { color, width, points: [p], fill: true },
      ];
      redrawAll(); // a fill must replay to flood under existing pixels
      commit();
      return;
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drawingRef.current = true;
    liveRef.current = false; // a fresh stroke; stays a tap until it moves
    // Freeze the committed picture, then start the new stroke over that baseline.
    snapshotCommitted();
    strokesRef.current = [...strokesRef.current, { color, width, points: [p] }];
    paintLive(); // paints the initial dot
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (inputDisabled || !drawingRef.current || !e.isPrimary) return;
    const cur = strokesRef.current[strokesRef.current.length - 1];
    if (!cur) return;
    const native = e.nativeEvent as globalThis.PointerEvent;
    // Coalesced events recover the high-frequency samples the OS batched into this
    // frame's single move — drawing them all keeps fast strokes smooth, not jagged.
    const coalesced = native.getCoalescedEvents?.() ?? [native];
    for (const ev of coalesced) {
      cur.points.push(toCanvas(ev.clientX, ev.clientY));
    }
    paintLive();
    // Mark the stroke live and sync it: onChange keeps the parent's copy current
    // (so an auto-submit at the buzzer captures the in-progress stroke), and the
    // throttled flush streams the draft for resilience if the drawer drops off.
    liveRef.current = true;
    onChange?.(strokesRef.current);
    scheduleFlush();
  };

  const end = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    paintLive(); // settle on the final stroke
    commit();
  };

  const undo = () => {
    if (strokesRef.current.length === 0) return;
    strokesRef.current = strokesRef.current.slice(0, -1);
    destructiveRef.current = true;
    redrawAll();
    commit();
  };

  const clear = () => {
    if (strokesRef.current.length === 0) return;
    strokesRef.current = [];
    destructiveRef.current = true;
    redrawAll();
    commit();
  };

  // Two layouts. Tall (column): the canvas is a direct flex child (its wrapper is
  // `contents`, so it adds no box) centered by two equal flex-1 spacers, the bar
  // hugging beneath. Short + wide (row): the canvas gets a flex-1 slot on the left
  // so it fills the height and fits the leftover width, and the bar moves to a
  // side column on the right — no vertical space wasted on a bottom bar.
  const rootCls = sideBar
    ? "flex h-full min-h-0 flex-row gap-4"
    : "flex h-full min-h-0 flex-col gap-3";
  const canvasWrapCls = sideBar
    ? "flex min-h-0 min-w-0 flex-1 items-center justify-center"
    : "contents";
  const canvasCls = sideBar
    ? "mx-auto aspect-4/3 max-h-full max-w-full rounded-2xl"
    : "mx-auto min-h-0 aspect-4/3 w-full max-h-full rounded-2xl landscape:h-full landscape:w-auto landscape:max-w-full";
  const barCls = sideBar
    ? "flex w-fit shrink-0 flex-col items-stretch justify-center gap-3"
    : "mx-auto flex w-fit max-w-full shrink-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-center sm:gap-3";
  // In the side-column (short) layout, scale the tool controls down so the bar
  // stays compact and hands more room to the canvas. The descendant variants only
  // reach the tool buttons/icons here — the popovers render through a portal to
  // <body>, and Lock-in is a sibling, so neither is affected.
  const toolsCls = sideBar
    ? "flex flex-wrap items-center justify-center gap-1.5 [&_button]:h-8 [&_button]:w-8 [&_button]:rounded-md [&_button>span]:h-4 [&_button>span]:w-4 [&_svg]:h-4 [&_svg]:w-4"
    : "flex flex-wrap items-center justify-center gap-2";

  return (
    <div className={rootCls}>
      {!sideBar && <div className="min-h-0 flex-1" aria-hidden />}
      <div className={canvasWrapCls}>
        <EffectLayer effects={effects} className={canvasCls}>
          <canvas
            ref={ref}
            width={CANVAS_W}
            height={CANVAS_H}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerLeave={end}
            onPointerCancel={end}
            className={`h-full w-full touch-none select-none rounded-2xl border-2 border-border bg-surface ${
              inputDisabled ? "opacity-70" : "cursor-crosshair"
            }`}
          />
        </EffectLayer>
      </div>

      {!disabled && (
        <div className={barCls}>
          {/* One bottom action bar at every size: the tool cluster and the Lock-in
              sit together, centered — tools then button, close, not flung to
              opposite edges. The bar is w-fit (shrink-wrapped to its widest child,
              the tool row) and centered; stacked, items-stretch makes Lock-in span
              that same width, so it's never wider than the toolbar nor a tiny pill.
              shrink-0 keeps it pinned while the canvas above flexes; Lock-in is
              never pushed below the fold. Every control is a fixed 40px square. */}
          <div className={toolsCls}>
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
                className="flex h-10 w-10 items-center justify-center rounded-lg border-2 border-border transition-colors hover:border-muted"
              >
                <span
                  className="h-5 w-5 rounded-md border border-black/20"
                  style={{ backgroundColor: color }}
                />
              </button>
              <ToolPopover
                open={paletteOpen}
                anchorRef={colorRef}
                width={208}
                onClose={() => setPaletteOpen(false)}
              >
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
                {/* Universal in-app picker (react-colorful) — renders the same
                      on every OS/browser, unlike the native <input type=color>. */}
                <div className="cc-picker mt-3">
                  <HexColorPicker color={color} onChange={setColor} />
                </div>
                <div className="mt-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-muted">
                  <span
                    className="h-5 w-5 shrink-0 rounded-md border border-black/20"
                    style={{ backgroundColor: color }}
                  />
                  <HexColorInput
                    color={color}
                    onChange={setColor}
                    prefixed
                    aria-label="hex color"
                    className="w-full rounded-md border-2 border-border bg-surface px-2 py-1 text-foreground uppercase tracking-widest outline-none focus:border-foreground"
                  />
                </div>
              </ToolPopover>
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
              <ToolPopover
                open={sizeOpen}
                anchorRef={penRef}
                width={176}
                onClose={() => setSizeOpen(false)}
              >
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
              </ToolPopover>
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
            {/* Eyedropper — a one-shot tool: the next tap samples that pixel's
                color and snaps back to the pen, so picking a color off the art
                is a tap rather than a hunt through the palette. */}
            <ToolButton
              label="eyedropper tool"
              title="Eyedropper — pick a color from the canvas"
              active={tool === "eyedrop"}
              onClick={() => {
                setPaletteOpen(false);
                setSizeOpen(false);
                setTool("eyedrop");
              }}
            >
              <Pipette className="h-5 w-5" />
            </ToolButton>

            <ToolButton
              label="undo"
              title="Undo"
              onClick={undo}
              disabled={count === 0}
            >
              <Undo className="h-5 w-5" />
            </ToolButton>
            <ToolButton
              label="clear"
              title="Clear all"
              onClick={clear}
              disabled={count === 0}
            >
              <Trash className="h-5 w-5" />
            </ToolButton>
          </div>

          {footer && (
            <div
              className={
                sideBar
                  ? "flex justify-center [&>button]:h-9 [&>button]:px-4 [&>button]:text-sm"
                  : "sm:shrink-0"
              }
            >
              {footer}
            </div>
          )}
        </div>
      )}
      {!sideBar && <div className="min-h-0 flex-1" aria-hidden />}
    </div>
  );
}

// ToolButton is one 40px-square control in the drawing toolbar — a toggle (pen /
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
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border-2 transition-colors disabled:opacity-40 ${
        active
          ? "border-primary bg-surface-2 text-foreground"
          : "border-border text-muted hover:border-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

// ToolPopover floats a toolbar panel (color presets / stroke size) above its
// trigger. It renders through a portal to <body> with fixed positioning, so no
// ancestor can clip it — not the toolbar's own scroll area in the short
// (landscape) layout, nor the page's overflow-hidden shell. It opens above the
// trigger, flips below when there isn't room, and clamps to the viewport edges,
// so the whole panel always stays on-screen at any size. Dismisses on an outside
// pointer or Escape.
function ToolPopover({
  open,
  anchorRef,
  width,
  onClose,
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLDivElement | null>;
  width: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Measure the trigger + panel and pin the panel in fixed coordinates; keep it
  // placed across resize/scroll (capture phase catches scrolls in any ancestor).
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const pop = popRef.current;
      if (!a || !pop) return;
      const m = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const h = pop.offsetHeight;
      // Prefer opening above the trigger; flip below if the top would clip.
      let top = a.top - m - h;
      if (top < m) {
        const below = a.bottom + m;
        top = below + h + m <= vh ? below : Math.max(m, vh - h - m);
      }
      // Align to the trigger's left edge, then clamp within the viewport.
      const left = Math.max(m, Math.min(a.left, vw - width - m));
      setPos({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || popRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchorRef, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      ref={popRef}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width,
        // Last-resort guard: on a viewport too short to hold the panel, scroll it
        // internally rather than letting any part spill off-screen.
        maxHeight: "calc(100dvh - 16px)",
        // Hidden for the first layout pass (before its size is known) so it never
        // flashes at the wrong spot, then revealed once positioned.
        visibility: pos ? "visible" : "hidden",
      }}
      className="fixed z-50 overflow-y-auto rounded-xl border-2 border-border bg-surface-2 p-3 shadow-lg"
    >
      {children}
    </div>,
    document.body,
  );
}
