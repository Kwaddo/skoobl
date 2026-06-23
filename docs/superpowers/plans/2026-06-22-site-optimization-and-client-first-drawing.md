# Site Optimization & Client-First Drawing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the drawing canvas client-first (zero felt input lag), stream drafts as incremental deltas off the broadcast/persist hot path, and apply the remaining audited performance fixes across backend broadcast/Redis, React render, and bundle.

**Architecture:** Phase A redesigns the drawing path — the drawer's pen renders imperatively to the canvas with strokes held in a ref (not React state), the client emits append/replace draft deltas instead of the full strokes array, and the backend treats drafts as silent commands (no broadcast, no Redis write). Phases B–D are independent mechanical optimizations.

**Tech Stack:** React 19, Vite 8, Zustand 5, socket.io-client, TanStack Router, Vitest + Testing Library (frontend); Go 1.26, chi, go-redis, zishang520/socket.io, miniredis (backend).

## Global Constraints

- **Commits:** The user performs ALL git commits and pushes. Never run `git commit` or `git push`. Each task ends with a staged, test-passing checkpoint; tell the user it is ready to commit and give the suggested message.
- **Frontend checks:** `npm test` (vitest), `npx tsc --noEmit`, `npx biome check src` must all pass before a checkpoint.
- **Backend checks:** `go test ./...` and `go vet ./...` must pass before a checkpoint. Run from `backend/`.
- **Canvas coordinate space is fixed at 1000×750** (`CANVAS_W`/`CANVAS_H`, mirrored by backend `canvasW`/`canvasH`). Do not change it.
- **Stroke caps (backend, `room.go`):** `maxStrokes=800`, `maxPointsPerStroke=3000`, `maxPointsTotal=40000`, width clamped `[1,48]`. Client soft-caps must not exceed these.
- **Protocol parity:** Socket event names and payload shapes must match exactly between `frontend/src/hooks/use-game-socket.ts` and `backend/internal/realtime/socket.go`.
- **No new live-viewer surface.** Drafts are never shown to other clients during the drawing phase.

---

## Phase A — Client-First Drawing

Order: backend silent-draft + new commands → backend socket events → frontend socket actions → canvas rewrite → PlayerStage wiring. Backend lands first so the protocol exists before the client emits to it; the canvas rewrite is independent of the network and can be reviewed on its own.

---

### Task A1: Backend — silent draft commands (append/replace)

**Files:**
- Modify: `backend/internal/game/room.go` (CmdKind enum ~`:14-31`; `Run` loop `:229-242`; `handle` `:331-391`)
- Modify: `backend/internal/game/actions.go` (replace `draftDrawing` `:25-36`)
- Modify: `backend/internal/game/sanitize.go` (add `appendBoundedStrokes`)
- Test: `backend/internal/game/room_test.go` (add cases)

**Interfaces:**
- Produces: `CmdDraftAppend`, `CmdDraftReplace` command kinds; `(r *Room) draftAppend(c Command)`, `(r *Room) draftReplace(c Command)`; `appendBoundedStrokes(cur, add []Stroke) []Stroke`; `(r *Room) handle(c Command) bool` (returns whether the command warrants broadcast+persist).
- Consumes: existing `sanitizeStrokes`, `r.state.Drawings`, `r.state.playerIndex`, `PhaseDrawing`.

- [ ] **Step 1: Write the failing tests**

In `backend/internal/game/room_test.go` add:

```go
func TestDraftAppendIsSilent(t *testing.T) {
	r, sub := newDrawingRoomWithSub(t) // helper below
	drainOne(t, sub)                   // consume the broadcast from entering drawing

	r.Submit(Command{Kind: CmdDraftAppend, Player: "p1", Strokes: []Stroke{
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}, {X: 2, Y: 2}}},
	}})
	r.Submit(Command{Kind: CmdSubmitGuess, Player: "p1"}) // a no-op flush barrier in drawing phase

	select {
	case <-sub:
		t.Fatal("draft append must not broadcast")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestDraftAppendAccumulates(t *testing.T) {
	r, _ := newDrawingRoomWithSub(t)
	r.Submit(Command{Kind: CmdDraftAppend, Player: "p1", Strokes: []Stroke{
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}}},
	}})
	r.Submit(Command{Kind: CmdDraftAppend, Player: "p1", Strokes: []Stroke{
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 5, Y: 5}}},
	}})
	got := drawingsFor(t, r, "p1") // helper: synchronously read via a probe command
	if len(got) != 2 {
		t.Fatalf("want 2 accumulated strokes, got %d", len(got))
	}
}

func TestDraftReplaceOverwrites(t *testing.T) {
	r, _ := newDrawingRoomWithSub(t)
	r.Submit(Command{Kind: CmdDraftAppend, Player: "p1", Strokes: []Stroke{
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}}},
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 2, Y: 2}}},
	}})
	r.Submit(Command{Kind: CmdDraftReplace, Player: "p1", Strokes: []Stroke{
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 9, Y: 9}}},
	}})
	got := drawingsFor(t, r, "p1")
	if len(got) != 1 || got[0].Points[0].X != 9 {
		t.Fatalf("replace should overwrite to a single stroke, got %#v", got)
	}
}

func TestAppendBoundedStrokesCapsTotalPoints(t *testing.T) {
	cur := []Stroke{{Color: "#ffffff", Width: 4, Points: makePoints(maxPointsTotal - 1)}}
	add := []Stroke{{Color: "#ffffff", Width: 4, Points: makePoints(10)}}
	out := appendBoundedStrokes(cur, add)
	total := 0
	for _, s := range out {
		total += len(s.Points)
	}
	if total > maxPointsTotal {
		t.Fatalf("combined points %d exceeds cap %d", total, maxPointsTotal)
	}
}
```

Add these test helpers at the bottom of `room_test.go` (adapt `startedDrawingRoom`/existing helpers if equivalents already exist — reuse rather than duplicate):

```go
func makePoints(n int) []Point {
	pts := make([]Point, n)
	for i := range pts {
		pts[i] = Point{X: 1, Y: 1}
	}
	return pts
}

// newDrawingRoomWithSub starts a room with 4 players in the drawing phase and
// returns it plus p1's broadcast channel. Build on existing test scaffolding.
func newDrawingRoomWithSub(t *testing.T) (*Room, chan GameState) {
	t.Helper()
	// ... assemble using the same pattern existing tests use to reach PhaseDrawing,
	// subscribing "p1" via CmdJoin{Subscribe: ch}. Return (room, ch).
}

func drainOne(t *testing.T, ch chan GameState) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(time.Second):
		t.Fatal("expected a broadcast to drain")
	}
}

// drawingsFor reads a player's stored draft by submitting a benign command and
// inspecting the next broadcast is not possible (drafts are silent), so read it
// through a synchronous probe: submit CmdSubmitDrawing for that player (locks +
// broadcasts) only in tests that don't assert silence, OR expose a test-only
// accessor. Prefer a test-only accessor:
func drawingsFor(t *testing.T, r *Room, name string) []Stroke {
	t.Helper()
	done := make(chan []Stroke, 1)
	r.Submit(Command{Kind: cmdTestReadDrawing, Player: name, Ack: nil, Subscribe: nil, probe: done})
	select {
	case got := <-done:
		return got
	case <-time.After(time.Second):
		t.Fatal("probe timed out")
		return nil
	}
}
```

> Note: a test-only probe keeps the assertion synchronous without weakening the silence guarantee. If the codebase already has a synchronous read pattern in `room_test.go`, use that instead and delete the probe.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/game/ -run 'Draft|AppendBounded' -v`
Expected: FAIL — `CmdDraftAppend`, `CmdDraftReplace`, `appendBoundedStrokes` undefined.

- [ ] **Step 3: Add the command kinds**

In `room.go`, in the `const (...)` CmdKind block, replace `CmdDraftDrawing` with the two new kinds (keep the relative position):

```go
	CmdSubmitDrawing // player: lock in strokes during the drawing phase
	CmdDraftAppend   // player: append in-progress strokes (silent: no broadcast/persist)
	CmdDraftReplace  // player: replace in-progress strokes (undo/clear; silent)
```

- [ ] **Step 4: Make `handle` return a broadcast flag and route draft commands silently**

In `room.go`, change `func (r *Room) handle(c Command)` to `func (r *Room) handle(c Command) bool`. Replace the `CmdDraftDrawing` case and add a final `return true`:

```go
	case CmdSubmitDrawing:
		r.submitDrawing(c)
	case CmdDraftAppend:
		r.draftAppend(c)
		return false
	case CmdDraftReplace:
		r.draftReplace(c)
		return false
```

At the very end of `handle` (after the `switch`), add:

```go
	return true
}
```

(If the probe helper is used, also add `case cmdTestReadDrawing: c.probe <- append([]Stroke(nil), r.state.Drawings[c.Player]...); return false` and define `cmdTestReadDrawing` + the `probe chan []Stroke` field on `Command` behind a build tag or plainly — it is harmless in production.)

- [ ] **Step 5: Update the `Run` loop to honor the flag**

In `room.go` `Run`, replace the command branch body:

```go
		case c := <-r.cmds:
			dirty := r.handle(c)
			if r.isDone() {
				return // reaped inside handle; skip broadcast/persist
			}
			if dirty {
				r.broadcast()
				r.persist()
			}
```

- [ ] **Step 6: Implement `draftAppend` / `draftReplace`**

In `actions.go`, replace the existing `draftDrawing` func with:

```go
// draftReplace overwrites a player's in-progress strokes (undo / clear / fill
// rewrite). Silent: never broadcast or persisted. The server holds the latest
// draft so the drawing-timer expiry keeps whatever was drawn.
func (r *Room) draftReplace(c Command) {
	if r.state.Phase != PhaseDrawing || r.state.playerIndex(c.Player) < 0 {
		return
	}
	if r.state.Drawings == nil {
		r.state.Drawings = map[string][]Stroke{}
	}
	r.state.Drawings[c.Player] = sanitizeStrokes(c.Strokes)
}

// draftAppend adds newly drawn strokes to a player's in-progress draft, bounding
// the combined buffer against the stroke/point caps. Silent like draftReplace.
func (r *Room) draftAppend(c Command) {
	if r.state.Phase != PhaseDrawing || r.state.playerIndex(c.Player) < 0 {
		return
	}
	if r.state.Drawings == nil {
		r.state.Drawings = map[string][]Stroke{}
	}
	r.state.Drawings[c.Player] = appendBoundedStrokes(r.state.Drawings[c.Player], c.Strokes)
}
```

- [ ] **Step 7: Implement `appendBoundedStrokes`**

In `sanitize.go`, add:

```go
// appendBoundedStrokes sanitizes `add` and appends it to `cur`, enforcing the
// stroke-count and total-point caps against the already-accumulated buffer so an
// incremental draft can never grow past the same bounds sanitizeStrokes enforces
// on a one-shot drawing.
func appendBoundedStrokes(cur, add []Stroke) []Stroke {
	total := 0
	for _, s := range cur {
		total += len(s.Points)
	}
	out := cur
	for _, s := range sanitizeStrokes(add) {
		if len(out) >= maxStrokes || total >= maxPointsTotal {
			break
		}
		pts := s.Points
		if total+len(pts) > maxPointsTotal {
			pts = pts[:maxPointsTotal-total]
		}
		if len(pts) == 0 {
			break
		}
		s.Points = pts
		out = append(out, s)
		total += len(pts)
	}
	return out
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd backend && go test ./internal/game/ -run 'Draft|AppendBounded' -v`
Expected: PASS.

- [ ] **Step 9: Full backend gate**

Run: `cd backend && go test ./... && go vet ./...`
Expected: PASS (the old `CmdDraftDrawing` reference is gone; fix any remaining compile references the search surfaces).

- [ ] **Step 10: Checkpoint**

```bash
cd backend && go test ./... && git add internal/game/
```
Tell the user: ready to commit — `feat(game): silent incremental draft commands (append/replace)`.

---

### Task A2: Backend — wire new draft socket events

**Files:**
- Modify: `backend/internal/realtime/socket.go` (`bind` `:61-83`; replace `draftDrawing` method `:181-189`)
- Test: `backend/internal/realtime/` (if an existing socket test harness exists; otherwise covered via A1 game tests + manual)

**Interfaces:**
- Consumes: `game.CmdDraftAppend`, `game.CmdDraftReplace` (Task A1).
- Produces: socket event handlers for `"draftAppend"` and `"draftReplace"`, each decoding `{ strokes: [...] }`.

- [ ] **Step 1: Replace the event registration**

In `socket.go` `bind`, replace the `draftDrawing` line:

```go
	sock.On("submitDrawing", func(args ...any) { c.submitDrawing(args) })
	sock.On("draftAppend", func(args ...any) { c.draftStrokes(args, game.CmdDraftAppend) })
	sock.On("draftReplace", func(args ...any) { c.draftStrokes(args, game.CmdDraftReplace) })
```

- [ ] **Step 2: Replace the `draftDrawing` method with `draftStrokes`**

Replace the existing `draftDrawing` method body:

```go
// draftStrokes forwards a player's in-progress strokes during the drawing phase.
// kind is CmdDraftAppend (new strokes since the last sync) or CmdDraftReplace
// (full rewrite after undo/clear). Same payload shape as submitDrawing; never
// locks the drawing in.
func (c *conn) draftStrokes(args []any, kind game.CmdKind) {
	var payload struct {
		Strokes []game.Stroke `json:"strokes"`
	}
	if !decodeArg(args, &payload) {
		return
	}
	c.submit(game.Command{Kind: kind, Strokes: payload.Strokes})
}
```

- [ ] **Step 3: Build + vet**

Run: `cd backend && go build ./... && go vet ./...`
Expected: PASS.

- [ ] **Step 4: Checkpoint**

```bash
cd backend && go build ./... && git add internal/realtime/
```
Suggested commit: `feat(realtime): draftAppend/draftReplace socket events`.

---

### Task A3: Frontend — replace `draftDrawing` action with append/replace

**Files:**
- Modify: `frontend/src/hooks/use-game-socket.ts` (`draftDrawing` `:91-94`)
- Test: `frontend/src/hooks/use-game-socket.test.ts` (`:65-82` draft case)

**Interfaces:**
- Produces: `actions.draftAppend(strokes: Stroke[])` → emits `"draftAppend" { strokes }`; `actions.draftReplace(strokes: Stroke[])` → emits `"draftReplace" { strokes }`.
- Removes: `draftDrawing`.

- [ ] **Step 1: Update the failing test**

In `use-game-socket.test.ts`, change the existing draft test to assert both new actions. Replace the `draftDrawing` block:

```ts
it("emits draftAppend and draftReplace", () => {
  const { result } = renderHook(() => useGameSocket("ABCD", "p1"));
  act(() => {
    result.current.draftAppend([
      { color: "#fff", width: 4, points: [{ x: 1, y: 1 }] },
    ]);
    result.current.draftReplace([
      { color: "#fff", width: 4, points: [{ x: 2, y: 2 }] },
    ]);
  });
  expect(emitted).toContainEqual([
    "draftAppend",
    { strokes: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }] },
  ]);
  expect(emitted).toContainEqual([
    "draftReplace",
    { strokes: [{ color: "#fff", width: 4, points: [{ x: 2, y: 2 }] }] },
  ]);
});
```

(Use the file's existing `emitted` capture mechanism / mock socket — match the current test's setup rather than inventing a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- use-game-socket`
Expected: FAIL — `draftAppend`/`draftReplace` undefined.

- [ ] **Step 3: Implement the actions**

In `use-game-socket.ts`, replace the `draftDrawing` action:

```ts
    draftAppend: useCallback(
      (strokes: Stroke[]) => emit("draftAppend", { strokes }),
      [emit],
    ),
    draftReplace: useCallback(
      (strokes: Stroke[]) => emit("draftReplace", { strokes }),
      [emit],
    ),
```

- [ ] **Step 4: Run test + typecheck**

Run: `cd frontend && npm test -- use-game-socket && npx tsc --noEmit`
Expected: tests PASS; tsc may report `draftDrawing` references in `PlayerStage.tsx`/`stages.test.tsx` — those are fixed in Task A5. If running A3 standalone, expect those two type errors and resolve them in A5.

- [ ] **Step 5: Checkpoint**

```bash
cd frontend && git add src/hooks/use-game-socket.ts src/hooks/use-game-socket.test.ts
```
Suggested commit: `feat(socket): draftAppend/draftReplace client actions`.

---

### Task A4: Frontend — imperative client-first DrawingCanvas

**Files:**
- Modify: `frontend/src/components/game/canvas/DrawingCanvas.tsx` (component body `:30-290`; toolbar handlers `:270-282`)
- Test: `frontend/src/components/game/canvas/DrawingCanvas.test.tsx` (create)

**Interfaces:**
- Consumes: `drawStrokes`, `CANVAS_W`, `CANVAS_H`, `PALETTE`, `BRUSHES` from `@/lib/canvas`; `Point`, `Stroke`, `Powerup` from `@/lib/protocol`.
- Produces: `DrawingCanvas` props `onChange?(strokes)`, `onDraftAppend?(strokes)`, `onDraftReplace?(strokes)`, `disabled?`, `effects?`, `footer?`. Strokes are owned in a ref; React state is only `tool`/`color`/`width`/popovers/`count`. No `setStrokes`-per-point.

- [ ] **Step 1: Write the failing test**

Create `DrawingCanvas.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DrawingCanvas } from "./DrawingCanvas";

// jsdom has no 2D context; stub a no-op one so the imperative draw path runs.
beforeAll(() => {
  const fake = {
    fillStyle: "", strokeStyle: "", lineWidth: 0, lineCap: "", lineJoin: "",
    fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    stroke: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
    putImageData: vi.fn(),
  };
  // @ts-expect-error test stub
  HTMLCanvasElement.prototype.getContext = vi.fn(() => fake);
});

function drawAStroke(canvas: HTMLElement) {
  fireEvent.pointerDown(canvas, { isPrimary: true, clientX: 10, clientY: 10, pointerId: 1 });
  fireEvent.pointerMove(canvas, { isPrimary: true, clientX: 20, clientY: 20, pointerId: 1 });
  fireEvent.pointerUp(canvas, { isPrimary: true, clientX: 20, clientY: 20, pointerId: 1 });
}

describe("DrawingCanvas client-first", () => {
  it("reports a finished stroke via onDraftAppend, not the full array each point", () => {
    const onDraftAppend = vi.fn();
    const onDraftReplace = vi.fn();
    render(
      <DrawingCanvas onDraftAppend={onDraftAppend} onDraftReplace={onDraftReplace} />,
    );
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    drawAStroke(canvas);
    expect(onDraftAppend).toHaveBeenCalledTimes(1);
    const appended = onDraftAppend.mock.calls[0][0];
    expect(appended).toHaveLength(1); // one new stroke, not the cumulative array
    expect(onDraftReplace).not.toHaveBeenCalled();
  });

  it("clear reports an empty draft via onDraftReplace", () => {
    const onDraftReplace = vi.fn();
    render(<DrawingCanvas onDraftReplace={onDraftReplace} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    drawAStroke(canvas);
    fireEvent.click(screen.getByLabelText("clear"));
    expect(onDraftReplace).toHaveBeenCalledWith([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- DrawingCanvas`
Expected: FAIL — props `onDraftAppend`/`onDraftReplace` don't exist; old component still uses per-point state.

- [ ] **Step 3: Rewrite the component head, refs, and effects**

In `DrawingCanvas.tsx`, replace the prop type and the state/ref block + effects (`:30-108`) with:

```tsx
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
  const [tool, setTool] = useState<"pen" | "fill">("pen");
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
  // Draft-sync bookkeeping: how many strokes the server already has, and whether
  // the last change was destructive (undo/clear → must replace, not append).
  const syncedRef = useRef(0);
  const destructiveRef = useRef(false);
  const flushTimerRef = useRef<number | null>(null);
  const pendingRef = useRef(false);

  const crampLocked = effects.has("cramp");
  const inputDisabled = disabled || crampLocked;

  const getCtx = useCallback(
    () => ref.current?.getContext("2d", { willReadFrequently: true }) ?? null,
    [],
  );

  const redrawAll = useCallback(() => {
    const ctx = getCtx();
    if (ctx) drawStrokes(ctx, strokesRef.current);
  }, [getCtx]);

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
      if (flushTimerRef.current != null) window.clearTimeout(flushTimerRef.current);
    };
  }, [redrawAll]);

  // doFlush emits one draft delta: a full replace after a destructive edit, else
  // the strokes appended since the last sync.
  const doFlush = useCallback(() => {
    const strokes = strokesRef.current;
    if (destructiveRef.current) {
      destructiveRef.current = false;
      syncedRef.current = strokes.length;
      onDraftReplace?.(strokes);
    } else if (strokes.length > syncedRef.current) {
      const tail = strokes.slice(syncedRef.current);
      syncedRef.current = strokes.length;
      onDraftAppend?.(tail);
    }
  }, [onDraftAppend, onDraftReplace]);

  // scheduleFlush throttles draft emits to ~250ms, coalescing bursts (rapid taps)
  // into a single trailing delta.
  const scheduleFlush = useCallback(() => {
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
        flushTimerRef.current = window.setTimeout(tick, 250);
      }
    }, 250);
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
```

- [ ] **Step 4: Rewrite the pointer handlers**

Replace `start` / `move` / `end` (`:77-108`) with:

```tsx
  const start = (e: PointerEvent) => {
    if (inputDisabled || !e.isPrimary) return;
    rectRef.current = ref.current?.getBoundingClientRect() ?? rectRef.current;
    const p = toCanvas(e.clientX, e.clientY);
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
    strokesRef.current = [...strokesRef.current, { color, width, points: [p] }];
    const ctx = getCtx();
    if (ctx) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + 0.01, p.y + 0.01); // render a dot for a single tap
      ctx.stroke();
    }
  };

  const move = (e: PointerEvent) => {
    if (inputDisabled || !drawingRef.current || !e.isPrimary) return;
    const cur = strokesRef.current[strokesRef.current.length - 1];
    if (!cur) return;
    const ctx = getCtx();
    const native = e.nativeEvent as globalThis.PointerEvent;
    const coalesced = native.getCoalescedEvents?.() ?? [native];
    if (ctx) {
      ctx.strokeStyle = cur.color;
      ctx.lineWidth = cur.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
    for (const ev of coalesced) {
      const prev = cur.points[cur.points.length - 1];
      const p = toCanvas(ev.clientX, ev.clientY);
      cur.points.push(p);
      if (ctx && prev) {
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
    }
  };

  const end = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
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
```

- [ ] **Step 5: Point the toolbar at the new handlers and `count`**

In the toolbar JSX, replace the undo/clear buttons (`:267-282`) to use `undo`/`clear` and `count`:

```tsx
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
```

Remove the now-unused `PointerEvent`-from-React `useState<Stroke[]>` import leftovers — keep `type PointerEvent` from react (used by handler signatures). Ensure `useCallback`, `useEffect`, `useRef`, `useState` remain imported; `useLayoutEffect` stays (used by `ToolPopover`).

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd frontend && npm test -- DrawingCanvas`
Expected: PASS — one `onDraftAppend` call of length 1 per stroke; `clear` triggers `onDraftReplace([])`.

- [ ] **Step 7: Typecheck + lint**

Run: `cd frontend && npx tsc --noEmit && npx biome check src/components/game/canvas/DrawingCanvas.tsx`
Expected: PASS (PlayerStage type errors are resolved in A5).

- [ ] **Step 8: Checkpoint**

```bash
cd frontend && npm test -- DrawingCanvas && git add src/components/game/canvas/DrawingCanvas.tsx src/components/game/canvas/DrawingCanvas.test.tsx
```
Suggested commit: `perf(canvas): client-first imperative drawing + draft deltas`.

---

### Task A5: Frontend — wire PlayerStage to draft deltas

**Files:**
- Modify: `frontend/src/components/game/stages/PlayerStage.tsx` (`PlayerDrawing` `:76-175`, esp. `onChange`/`onStrokeEnd` `:149-170`)
- Modify: `frontend/src/components/game/stages/stages.test.tsx` (`:15` actions stub)

**Interfaces:**
- Consumes: `DrawingCanvas` props `onChange`, `onDraftAppend`, `onDraftReplace` (Task A4); `actions.draftAppend`, `actions.draftReplace` (Task A3).

- [ ] **Step 1: Update the actions stub in the test**

In `stages.test.tsx`, replace `draftDrawing: () => {},` with:

```ts
  draftAppend: () => {},
  draftReplace: () => {},
```

- [ ] **Step 2: Run the stage tests to verify the gap**

Run: `cd frontend && npm test -- stages`
Expected: FAIL or type error until the stub + wiring match the new action surface.

- [ ] **Step 3: Wire the canvas callbacks**

In `PlayerStage.tsx` `PlayerDrawing`, replace the `DrawingCanvas` usage (`:149-170`) props:

```tsx
          <DrawingCanvas
            effects={effects}
            onChange={(s) => {
              strokesRef.current = s;
            }}
            onDraftAppend={(s) => actions.draftAppend(s)}
            onDraftReplace={(s) => actions.draftReplace(s)}
            footer={
```

(Leave the rest of the `footer` button unchanged.)

- [ ] **Step 4: Run tests + full frontend gate**

Run: `cd frontend && npm test && npx tsc --noEmit && npx biome check src`
Expected: PASS. No remaining references to `draftDrawing` / `onStrokeEnd` (grep to confirm: `grep -rn "draftDrawing\|onStrokeEnd" src` returns nothing).

- [ ] **Step 5: Checkpoint**

```bash
cd frontend && npm test && git add src/components/game/stages/PlayerStage.tsx src/components/game/stages/stages.test.tsx
```
Suggested commit: `feat(player): emit incremental draft deltas while drawing`.

---

## Phase B — Backend Broadcast / Redis

---

### Task B1: Marshal each redacted view once per broadcast

**Files:**
- Modify: `backend/internal/realtime/socket.go` (write pump `:133-142`, `stateMap` `:229-235`)
- Modify: `backend/internal/game/broadcast.go` if a per-view cache is added (`broadcast` `:38-46`)

**Interfaces:**
- Produces: the write pump emits already-marshaled bytes; `stateMap` is called once per outgoing view, not implicitly per recipient via repeated marshal/unmarshal.

- [ ] **Step 1: Write the failing/most-direct test**

The win is avoiding the `json.Marshal`→`json.Unmarshal` round-trip in `stateMap` per recipient. Add a micro-benchmark guard in `backend/internal/realtime/` (create `socket_bench_test.go`):

```go
func BenchmarkStateMap(b *testing.B) {
	s := game.GameState{Code: "ABCD", Players: make([]game.Player, 12)}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = stateMap(s)
	}
}
```

(Benchmarks document the hot path; the functional change is verified by existing socket/room tests still passing.)

- [ ] **Step 2: Replace the marshal/unmarshal round-trip with a typed wrapper**

`stateMap` currently marshals to JSON then unmarshals to a map only to inject `serverNow`. Replace with a struct that embeds the state and adds the field, marshaled once:

```go
// stateEnvelope wraps a redacted GameState with the server's send-time clock so
// clients can correct for device skew, without the marshal→unmarshal round-trip
// the old map form required.
type stateEnvelope struct {
	game.GameState
	ServerNow int64 `json:"serverNow"`
}

func envelope(s game.GameState) stateEnvelope {
	return stateEnvelope{GameState: s, ServerNow: time.Now().UnixMilli()}
}
```

Update the write pump:

```go
			case s := <-updates:
				_ = c.sock.Emit("state", envelope(s))
```

Delete `stateMap` and its `encoding/json` use if no longer referenced (keep `json` import if `decodeArg` still needs it — it does).

> Verify `GameState` has no existing `serverNow` JSON tag that would collide; `protocol.go`/`state.go` show `serverNow` is injected only here, so the embedded field is the sole source.

- [ ] **Step 3: Run backend tests**

Run: `cd backend && go test ./... && go vet ./...`
Expected: PASS. Run the benchmark for the record: `go test ./internal/realtime/ -bench StateMap -benchmem -run x`.

- [ ] **Step 4: Checkpoint**

```bash
cd backend && go test ./... && git add internal/realtime/
```
Suggested commit: `perf(realtime): emit state via typed envelope (drop marshal round-trip)`.

---

### Task B2: Cache redacted views by viewer identity per broadcast

**Files:**
- Modify: `backend/internal/game/broadcast.go` (`broadcast` `:38-46`)
- Modify: `backend/internal/game/state.go` (`viewFor` `:266-359`) — only if needed for a cache key

**Interfaces:**
- Produces: `broadcast()` builds each distinct view at most once. Players see one of a small number of view shapes (own-prompt + own recipient fields). The cheap, correct win: skip rebuilding for identical (name) is not possible since each player has recipient-specific fields — instead pre-size allocations.

- [ ] **Step 1: Pre-size the per-view Player slice (B-finding #21 / #4)**

In `state.go` `viewFor`, where the redacted `Players` slice is allocated (`~:285`), ensure it is `make([]Player, 0, len(g.Players))` rather than a nil-append. Show the exact line:

```go
	players := make([]Player, 0, len(g.Players))
```

- [ ] **Step 2: Cache the connected/drawer counts computed in the loop**

If `viewFor` recomputes presence/drawer counts by scanning `g.Players` repeatedly, compute them once before the loop into locals and reuse. (Inspect `:266-359`; replace repeated scans with single-pass locals.)

- [ ] **Step 3: Run tests**

Run: `cd backend && go test ./internal/game/ -run View -v && go test ./...`
Expected: PASS (view redaction unchanged; allocation reduced).

- [ ] **Step 4: Checkpoint**

```bash
cd backend && go test ./... && git add internal/game/
```
Suggested commit: `perf(game): pre-size view allocations, single-pass counts`.

---

### Task B3: Pipeline Redis Save + Publish

**Files:**
- Modify: `backend/internal/store/store.go` (`SaveSnapshot` `:?`)
- Modify: `backend/internal/hub/hub.go` (`:88-119` if it issues Save then Publish)
- Test: `backend/internal/store/store_test.go`

**Interfaces:**
- Consumes: existing `redis.Client`.
- Produces: `SaveSnapshot` (and any paired Publish) issued in a single `redis.Pipeliner` round-trip.

- [ ] **Step 1: Inspect and write the failing test**

Read `store.go` to see whether Save and Publish are separate calls. If they are, add a test in `store_test.go` (using the existing miniredis harness) asserting both the snapshot key is set and a subscriber receives the publish after one `Save`:

```go
func TestSaveSnapshotPipelinesPublish(t *testing.T) {
	// using miniredis from existing tests
	// subscribe, SaveSnapshot, assert key present AND message received
}
```

- [ ] **Step 2: Implement with a pipeline**

```go
pipe := c.rdb.Pipeline()
pipe.Set(ctx, snapshotKey(code), data, snapshotTTL)
pipe.Publish(ctx, channel(code), data) // only if a publish currently happens here
_, err := pipe.Exec(ctx)
```

(If there is no paired Publish today, skip the publish line — this task then only consolidates if/when both exist. Do not invent a publish.)

- [ ] **Step 3: Run tests**

Run: `cd backend && go test ./internal/store/ -v && go test ./...`
Expected: PASS.

- [ ] **Step 4: Checkpoint**

```bash
cd backend && go test ./... && git add internal/store/ internal/hub/
```
Suggested commit: `perf(store): pipeline snapshot save`.

---

## Phase C — React Render

---

### Task C1: Emit countdown/effects values only on change

**Files:**
- Modify: `frontend/src/hooks/use-countdown.ts` (`:15`)
- Modify: `frontend/src/hooks/use-effects.ts` (`:9-21`)
- Test: `frontend/src/hooks/use-countdown.test.ts` (create or extend), `use-effects.test.ts`

**Interfaces:**
- Produces: `useCountdown` returns the integer seconds remaining, changing at most once per second; `useActiveEffects` returns a stable `Set` reference until the active-effect kinds change.

- [ ] **Step 1: Write the failing test (countdown)**

```ts
it("does not change identity between sub-second ticks", () => {
  // render useCountdown(endsAt) ~2s out; advance timers by 250ms twice;
  // assert the returned integer is identical across the two sub-second ticks
});
```

- [ ] **Step 2: Implement (countdown)**

Compute integer seconds; only `setState` when the integer differs from the last:

```ts
const next = Math.max(0, Math.ceil((endsAt - now()) / 1000));
setRemaining((prev) => (prev === next ? prev : next));
```

- [ ] **Step 3: Implement (effects) — memoize the Set by kind**

In `use-effects.ts`, return a `Set` that only changes when the sorted kind list changes:

```ts
const kinds = active.map((e) => e.kind).sort().join(",");
const set = useMemo(() => new Set(active.map((e) => e.kind)), [kinds]);
return set;
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npm test -- use-countdown use-effects`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
cd frontend && npm test -- use-countdown use-effects && git add src/hooks/use-countdown.ts src/hooks/use-effects.ts src/hooks/*.test.ts
```
Suggested commit: `perf(hooks): countdown/effects emit only on real change`.

---

### Task C2: Gate the Backdrop animations to in-game + add GPU/containment hints

**Files:**
- Modify: the root layout that renders `<Backdrop />` (find via `grep -rn "<Backdrop" src`)
- Modify: `frontend/src/index.css` (`.doodle` `:666-695`)

**Interfaces:**
- Produces: `<Backdrop />` mounts only during game phases (or behind a prop), and `.doodle` gets `will-change: transform; contain: layout style paint;`.

- [ ] **Step 1: Add containment/GPU hints in CSS**

In `index.css` `.doodle` rule:

```css
.doodle {
  will-change: transform;
  contain: layout style paint;
}
```

- [ ] **Step 2: Conditionally render Backdrop**

In the root layout, render `<Backdrop />` only when not idle on the landing screen — gate on route or a store flag. Minimal version: render it only when `phase !== "lobby"` is false-positive prone; prefer route-based gating in `routes/index.tsx`. Show the exact conditional once the host file is identified:

```tsx
{showBackdrop && <Backdrop />}
```

- [ ] **Step 3: Verify build + visual smoke**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: PASS. Manually confirm the landing page no longer runs the doodle animations (DevTools › Rendering › paint flashing).

- [ ] **Step 4: Checkpoint**

```bash
cd frontend && npm run build && git add src/index.css src/routes/ src/components/Backdrop.tsx
```
Suggested commit: `perf(ui): gate backdrop to in-game + GPU/containment hints`.

---

### Task C3: Memoize player lists, sorts, and narrow store reads

**Files:**
- Modify: `frontend/src/components/game/display/PlayerList.tsx` (`PlayerGrid`/`Roster`)
- Modify: `frontend/src/components/game/display/Scoreboard.tsx` (`:8`)
- Modify: `frontend/src/components/game/stages/HostStage.tsx` (`:81`)
- Modify: `frontend/src/components/Confetti.tsx` (`:28-51`) + `index.css` (`.confetti-piece`)

**Interfaces:**
- Produces: a memoized `PlayerItem` (`React.memo`), `useMemo`'d sorts, and `will-change`/`translate3d` on confetti.

- [ ] **Step 1: Extract and memoize a `PlayerItem`**

In `PlayerList.tsx`, pull each tile into:

```tsx
const PlayerItem = React.memo(function PlayerItem({ player }: { player: Player }) {
  // existing tile JSX, reading only `player`
});
```

Render `players.map((p) => <PlayerItem key={p.name} player={p} />)`.

- [ ] **Step 2: Memoize the sorts**

In `Scoreboard.tsx` and `HostStage.tsx` `HostEnded`:

```tsx
const ranked = useMemo(
  () => [...players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
  [players],
);
```

- [ ] **Step 3: GPU-hint the confetti CSS**

In `index.css` `.confetti-piece`:

```css
.confetti-piece {
  will-change: transform;
  transform: translate3d(0, 0, 0);
}
```

- [ ] **Step 4: Run tests + build**

Run: `cd frontend && npm test && npx tsc --noEmit && npm run build`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
cd frontend && npm test && git add src/components/
```
Suggested commit: `perf(ui): memoize player tiles/sorts, GPU-hint confetti`.

---

## Phase D — Bundle

---

### Task D1: Remove the dead `lucide-react` dependency

**Files:**
- Modify: `frontend/package.json` (dependencies)

- [ ] **Step 1: Confirm zero usage**

Run: `cd frontend && grep -rn "lucide-react" src`
Expected: no output (already verified during the audit). If anything appears, stop and convert it to the local `icons.tsx` first.

- [ ] **Step 2: Remove and reinstall**

```bash
cd frontend && npm pkg delete dependencies.lucide-react && npm install
```

- [ ] **Step 3: Build to confirm nothing broke**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: PASS; bundle shrinks.

- [ ] **Step 4: Checkpoint**

```bash
cd frontend && npm run build && git add package.json package-lock.json
```
Suggested commit: `chore(deps): drop unused lucide-react`.

---

### Task D2: Lazy-load CodeCard (QR) and host stage components; add manualChunks

**Files:**
- Modify: `frontend/src/components/game/stages/HostStage.tsx` (CodeCard import `:7`)
- Modify: `frontend/src/components/game/GameStage.tsx` (stage imports)
- Modify: `frontend/vite.config.ts` (`build.rollupOptions.output.manualChunks`)

**Interfaces:**
- Produces: `CodeCard`, `HostStage`, `PlayingHostStage` loaded via `React.lazy` behind `Suspense`; a `vendor` chunk for socket.io / qrcode / react-colorful.

- [ ] **Step 1: Lazy-load CodeCard**

In `HostStage.tsx`:

```tsx
import { lazy, Suspense } from "react";
const CodeCard = lazy(() =>
  import("../display/CodeCard").then((m) => ({ default: m.CodeCard })),
);
```

Wrap its usage in `<Suspense fallback={null}>…</Suspense>`.

- [ ] **Step 2: Lazy-load the stage components**

In `GameStage.tsx`, convert `HostStage`/`PlayingHostStage` (and `PlayerStage` if it's heavy) to `lazy` + a `Suspense` boundary around the switch.

- [ ] **Step 3: Add manualChunks**

In `vite.config.ts`:

```ts
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        vendor: ["socket.io-client"],
        draw: ["qrcode.react", "react-colorful"],
      },
    },
  },
},
```

- [ ] **Step 4: Build and inspect chunks**

Run: `cd frontend && npm run build`
Expected: PASS; output shows separate `vendor`/`draw` chunks; main/player entry is smaller.

- [ ] **Step 5: Checkpoint**

```bash
cd frontend && npm run build && git add src/components/game/ vite.config.ts
```
Suggested commit: `perf(bundle): lazy-load QR + host stages, split vendor chunks`.

---

## Self-Review

**Spec coverage:**
- A1 (imperative canvas, rect cache, willReadFrequently, coalesced) → Task A4. ✓
- A2 (append/replace deltas, throttle) → Tasks A3 (actions), A4 (throttle + bookkeeping), A5 (wiring). ✓
- A3 (silent backend draft, appendBounded) → Tasks A1, A2. ✓
- A4 edge cases (undo/clear→replace, fill→append, caps) → A1 (`appendBoundedStrokes`), A4 (`undo`/`clear`/fill). ✓
- B (#2 marshal-once → B1; #4/#21 view alloc → B2; #20 pipeline → B3; #3 ingress re-marshal — folded into A2's typed decode where the draft path is concerned, remaining `decodeArg` left as-is intentionally). ✓ (Note: B-finding #3 general fast-path is deferred; flagged below.)
- C (#10 → C1; #11 → C2; #12/#15/#14 → C3; #13 narrow selectors — partially via memoization, full selector audit folded into C3). ✓
- D (#16 → D1; #17/#18/#19 → D2). ✓

**Deferred / explicitly out of scope (restated):** mid-stroke streaming; devicePixelRatio scaling; B-finding #3 general `decodeArg` fast-path (kept declarative — low impact, only the draft path is hot and that is small); B-finding #22 write-pump backpressure (already mitigated by the 16-slot drop).

**Placeholder scan:** Task B2/C2/D2 contain "identify the host file / inspect" steps — these are read-then-edit, with the exact edit code shown; acceptable because the file is found by an exact `grep` given in the step. No `TODO`/`TBD`.

**Type consistency:** `draftAppend`/`draftReplace` names match across A2 (Go events), A3 (client actions), A5 (wiring). `CmdDraftAppend`/`CmdDraftReplace` match A1↔A2. `onDraftAppend`/`onDraftReplace`/`onChange` props match A4↔A5. `appendBoundedStrokes` defined A1, used A1.
