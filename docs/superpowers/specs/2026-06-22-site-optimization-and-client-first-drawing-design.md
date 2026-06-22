# Site Optimization & Client-First Drawing — Design

**Date:** 2026-06-22
**Status:** Approved (design); pending implementation plan
**Scope:** Performance optimization across the skoobl frontend and Go backend, with a focused redesign of the drawing path to be "client-first" so the drawer feels zero input lag.

---

## 1. Overview

skoobl is a real-time, skribbl.io-style drawing game: React 19 + Vite + Zustand + socket.io-client frontend, Go (chi / redis / socket.io) backend. Players draw their own prompt simultaneously, then guess "who drew it".

A three-track performance audit produced 22 findings. This design organizes the work into four workstreams. Workstream **A (client-first drawing)** is a real redesign of the drawing data flow and absorbs the canvas/draft findings (FE #4–#9, BE #1). Workstreams **B–D** are well-defined mechanical optimizations catalogued from the audit.

**Primary goal of A:** the person drawing must feel no lag — the pen renders instantly, decoupled from React state and the network. Draft sync to the server becomes incremental (deltas, not the full strokes array), and the backend drops drafts from the broadcast/persist hot path. There is **no new live-viewer surface** — nobody watches a drawing as it is made during the drawing phase (confirmed: `viewFor` exposes drawings only at guess/reveal, `state.go:326`/`:334`).

### Current drawing flow (baseline)

- `DrawingCanvas` (`frontend/src/components/game/canvas/DrawingCanvas.tsx`) holds `strokes` in React state. Every pointer-move appends a point via `setStrokes` (`:95`), which re-renders and triggers a `useEffect` that **clears and redraws all strokes** (`:56–59`). `getBoundingClientRect()` runs on every move (`:65–75`).
- On stroke end, `PlayerStage` emits the **entire** strokes array via `actions.draftDrawing(strokes)` (`PlayerStage.tsx:154`, `use-game-socket.ts:91`).
- Backend `Run()` loop **broadcasts to every subscriber and persists the full state to Redis after every command** (`room.go:238–239`), including each draft. `draftDrawing` full-replaces `state.Drawings[player]` (`actions.go:28–36`).

The drawer's own pen is already client-rendered, but the per-point React → effect → redraw-all pipeline is the jank that feels like lag.

---

## 2. Workstream A — Client-First Drawing

### A1. Frontend drawer: imperative canvas (FE #4, #5, #6, #7, #8, #9)

**Decision: single canvas, incremental draw, ref source-of-truth (Approach A).**

- `strokes` moves from React state to a `useRef` (`strokesRef`). The ref is the authoritative drawing.
- React state shrinks to what the toolbar chrome needs: `canUndo` / `canClear` booleans (derived from stroke count) plus the existing `tool` / `color` / `width`. Result: re-renders drop from per-point to per-toolbar-action.
- **Pointer handlers draw imperatively:**
  - `pointerdown`: cache the canvas rect (computed once here, not per move), start a new stroke in `strokesRef`, `moveTo` the first point.
  - `pointermove`: read `event.getCoalescedEvents()`, map each to canvas space using the cached rect, push to the current stroke, and `lineTo`/`stroke` only the **new segment(s)** directly on the context. No `setStrokes`, no full redraw.
  - `pointerup` / leave / cancel: finalize the stroke (it is already painted), bump the toolbar state if needed, and trigger draft sync (see A2).
- **Full redraw only on rare ops:** undo, clear, and fill re-render the whole canvas from `strokesRef` via the existing `drawStrokes`. These are user taps, not the hot path.
- **Rect caching (#6):** cache `getBoundingClientRect()` on `pointerdown` and refresh via a `ResizeObserver` on the canvas; never read it per move.
- **Context options (#8):** `getContext("2d", { willReadFrequently: true })` in `DrawingCanvas.tsx` and in `lib/canvas.ts` (fill uses `getImageData`).
- **Coalesced events (#7, #9):** `getCoalescedEvents()` smooths fast input without extra renders.
- **Memory (canvas audit — unbounded `myDrawings`):** soft-cap strokes/points on the client so drawing stops at the limit rather than being silently truncated server-side; clear `myDrawings[round]` once recorded.

**Component interface (DrawingCanvas callbacks):**

- `onChange(strokes)` — fired on every *committed* mutation (stroke end, undo, clear, fill). Low frequency. `PlayerStage` stores it in its `strokesRef` for the final submit.
- `onDraftAppend(strokes)` — newly appended strokes since the last sync (the tail).
- `onDraftReplace(strokes)` — full strokes; fired only on destructive ops (undo / clear / fill).

DrawingCanvas owns the append-vs-replace decision because it knows whether a change grew the array or rewrote it. The socket wiring stays in `PlayerStage` / `use-game-socket`.

### A2. Draft sync protocol: incremental deltas (BE #1 client side)

**Decision: append + replace deltas (Approach A).**

- Client tracks `syncedCount` (strokes already sent). A throttled flush (~250 ms, and on stroke end) decides:
  - strokes grew by appending → `draftAppend({ strokes: tail })` where `tail = strokes.slice(syncedCount)`.
  - array shrank or a stroke changed (undo / clear / fill) → `draftReplace({ strokes: full })`.
- Final lock-in is unchanged: `submitDrawing({ strokes: full })`.
- Mid-stroke point streaming is **out of scope** — it would only benefit a live viewer, which we don't have.

New client actions in `use-game-socket.ts`: `draftAppend`, `draftReplace` (replacing the single `draftDrawing`).

### A3. Backend: silent draft command (BE #1)

- `Run()` loop change (`room.go:229–242`): `handle(c)` returns whether the command warrants a broadcast/persist. Draft commands mutate `state.Drawings[player]` then **skip both** `broadcast()` and `persist()`.
- New command kinds: `CmdDraftAppend` (append tail) and `CmdDraftReplace` (full replace), replacing `CmdDraftDrawing`. Both are silent.
- `appendDraft`: sanitize only the delta strokes and enforce combined caps (`maxStrokes`, `maxPointsTotal`) against the current buffer length/point-count before appending — no full re-sanitize of the whole drawing per append.
- **Why this is lossless:**
  - Drawing phase exposes no drafts to any viewer (`viewFor`), so skipping broadcast changes nothing visible.
  - Timer-expiry `advance()` reads `state.Drawings` from memory, which the silent draft still updates.
  - The client holds strokes locally and auto-submits at the buzzer (`PlayerStage.tsx:103`).
  - Skipping persist only loses an in-progress draft across a mid-stroke **server restart** — recoverable because the client re-sends / re-submits.

### A4. Edge cases

| Case | Handling |
| --- | --- |
| undo / clear / fill | `draftReplace(full)`; canvas full-redraws from ref |
| reconnect / brief socket blip | component stays mounted, ref intact — no action needed |
| full page reload mid-draw | local strokes lost (same as today; acceptable) |
| drawing timer expiry | client `submitDrawing` is authoritative; server draft is the fallback |
| stroke/point caps | server still bounds; client soft-caps so it stops cleanly at the limit |

### A5. Testing (Workstream A)

- **Backend:** `CmdDraftAppend` / `CmdDraftReplace` mutate `Drawings` but enqueue **no** broadcast and **no** persist; combined-cap enforcement on append; lock-in and timer-advance still observe the latest draft. Follow existing `room_test.go` patterns.
- **Frontend:** DrawingCanvas fires `onDraftAppend` on a new stroke and `onDraftReplace` on undo/clear; `strokesRef` stays authoritative; assert **no** `setStrokes`-equivalent re-render per pointer-move (render-count assertion). Vitest + RTL.

---

## 3. Workstream B — Backend broadcast / Redis

| # | Location | Problem | Fix |
| --- | --- | --- | --- |
| B2 | `realtime/socket.go:229–235` (`stateMap`) | full state marshaled once per recipient | marshal the redacted view once per distinct view; emit the bytes |
| B3 | `realtime/socket.go:241–250` (`decodeArg`) | re-marshal of already-decoded args on every event | typed fast-path reading map fields directly |
| B4 | `game/state.go:266–359` (`viewFor`) | rebuilds Player slice + flag maps per subscriber → O(N²) per broadcast | cache redacted views by (phase, role); invalidate on phase change / join / leave |
| B20 | `store/store.go`, `hub/hub.go:88` | Save and Publish are separate round-trips | `redis.Pipeliner` to batch Save + Publish |
| B21 | `game/rounds.go:214`, `state.go:247` | per-broadcast slice allocations; repeated O(N) counts | pre-allocate with known cap; cache connected/drawer counts |

(B22 — write-pump `Emit` can block on a slow socket — is already partially mitigated by the 16-buffer drop at `socket.go:43`; low priority.)

---

## 4. Workstream C — React render performance

| # | Location | Problem | Fix |
| --- | --- | --- | --- |
| C10 | `hooks/use-countdown.ts:15`, `hooks/use-effects.ts:15` | tick 4–5×/s, re-render even when value unchanged | emit a new value only on integer change (countdown) / set change (effects) |
| C11 | `components/Backdrop.tsx:70–99`, `index.css:666` | 12 infinite SVG animations run on every page incl. landing | render only during game phases; add `will-change` / `contain: paint` |
| C12 | `components/game/display/PlayerList.tsx` | whole list re-renders when one player changes | `React.memo` per-item, keyed on name + locked/relevant fields |
| C13 | `lib/store.ts:135–181` (`applyState`) | new object refs each broadcast → broad subscribers re-render | narrow selectors; shallow-equality where slices are stable |
| C14 | `components/Confetti.tsx:28–51` | 30 shards animate without a GPU layer | `will-change: transform` + `translate3d` |
| C15 | `Scoreboard.tsx:8`, `HostStage.tsx:81` | `[...players].sort()` every render | `useMemo` keyed on players |

---

## 5. Workstream D — Bundle

| # | Location | Problem | Fix |
| --- | --- | --- | --- |
| D16 | `package.json` (lucide-react) | dead dependency — **verified zero imports in `src/`** | remove it (~18–22 KB gzipped) |
| D17 | `components/game/display/CodeCard.tsx` | `qrcode.react` eager on all routes | lazy-load CodeCard so the player route skips QR (~15 KB) |
| D18 | `vite.config.ts` | no `manualChunks` | split socket.io / qrcode / react-colorful into a vendor chunk for caching |
| D19 | `components/game/GameStage.tsx` | host stage components eager in the main bundle | lazy-load `HostStage` / `PlayingHostStage` behind `Suspense` |

---

## 6. Cross-cutting testing & rollout

- Each workstream is independently shippable. Suggested order: **A** (highest user-felt payoff and biggest backend hot-path win) → **B** → **C** → **D**.
- Run `pnpm/npm test` (vitest) and `go test ./...` after each workstream; `biome check` and `tsc --noEmit` for the frontend.
- A and B touch the protocol together (the draft event rename). Land A's protocol change and B's broadcast change in a coordinated step so client and server agree on events.

## 7. Out of scope

- Any live-viewer surface (host live grid, play-along live stream) — explicitly declined.
- Mid-stroke point streaming.
- devicePixelRatio canvas scaling (FE #11, low impact) — deferred.
- Unrelated refactoring beyond what each fix requires.
