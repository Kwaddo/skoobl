# Responsive Hosting on Mobile & Tablet — Design

Date: 2026-06-22
Status: Approved (pending spec review)

## Problem

Hosting is currently desktop/tablet-only and not responsive on small screens:

- The home page **hides the Host tab below 640px** (`use-is-mobile.ts`), so phones cannot host at all.
- The **Big-screen display shell** (`bigScreen` in `GameStage.tsx`) is `h-dvh overflow-hidden` — it never scrolls by design (a shared TV that must not jump while players watch). Its phase layouts (`HostStage.tsx`) use `lg:` two-column grids that collapse to one column below 1024px. On a phone/portrait tablet the content (code card + roster + 7-row settings + start button) overflows the viewport with no way to scroll, so it is clipped.
- The **Play-along host lobby** (`PlayingHostStage.tsx`) scrolls vertically but overflows **horizontally**: shared components have min-widths wider than a narrow phone column, and the centered layout under `overflow-hidden` clips the left edge (observed: every settings label cut off on the left).

### Root causes of the horizontal clip (confirmed by reading the components)

1. **`CodeCard`** (`display/CodeCard.tsx`) — a fixed horizontal layout: the room code at `text-3xl` with wide letter-spacing beside a fixed **104px** QR tile. Min-width ≈ 380px; narrower than that it overflows the column.
2. **`Segmented`** (`Segmented.tsx`) — a non-wrapping flex row whose buttons never shrink. The Mode control ("Classic · Whose Doodle · Frenzy") is ~280px wide on its own; on a small phone it exceeds the settings column.
3. **Shell `overflow-hidden`** — clips that overflow (left side unreachable) instead of allowing scroll.

These components are shared by both host modes, so fixing them benefits the Big-screen display, the Play-along lobby, and the home page.

## Decisions (from brainstorming)

- **Both host modes must be responsive across phone / tablet / desktop**, BUT the **Big-screen mode is not offered on phones** — a phone is not a shared TV. Phones host as **Play-along only**.
- **"Big enough" for Big-screen = width ≥ 640px** (tablets and up). Below 640px, only Play-along is offered. This matches the existing mobile breakpoint.
- **Scroll behavior:** on small/portrait the host display **scrolls** so everything is reachable; on large landscape it keeps the current **no-scroll, fit-to-viewport** lock. Lock point = `lg` (1024px), consistent with the existing two-pane breakpoint.
- **Tablet portrait (640–1023px)** shows a stacked, scrollable single-column Big-screen — a propped-up shared screen — not a squished desktop.

## Approach

Mobile-first reflow with responsive shared components. One adaptive shell; each host phase keeps its existing `lg:` two-pane and gains a clean mobile-first single-column base. No duplicated/per-device component trees.

## Changes

### 1. Home gating — `routes/index.tsx`, `hooks/use-is-mobile.ts`

- Stop hiding the Host tab on mobile. The tab list is **Join · Host · History at every size** (remove the `isMobile` branch that drops Host).
- In the Host tab's mode toggle (`Segmented` with "Big screen" / "Play along"):
  - **≥640px:** both options, current default (`"screen"`).
  - **<640px:** show **only "Play along"**, and force `hostMode = "play"`. The big-screen-only explainer copy is not shown; the name field (play-along) is.
- The existing `useEffect` that bounces `tab === "host"` → `join` on mobile is removed (Host is now allowed on mobile).
- `use-is-mobile.ts` keeps the 639px query; only its comment/usage intent changes (it now gates the *mode*, not the *tab*).

### 2. Responsive host shell — `components/game/GameStage.tsx`

- Big-screen shell becomes scroll-below-`lg`, locked-at-`lg+`:
  - from `… h-dvh … overflow-hidden …`
  - to `… h-dvh … overflow-y-auto lg:overflow-hidden …` (keep `max-w-[1700px]`, padding, gap).
- Play-along shell already scrolls within its lobby; verify nothing regresses. No structural change expected.

### 3. Host phase layouts — `components/game/stages/HostStage.tsx`

Each phase root currently is `grid h-full min-h-0 gap-… lg:grid-cols-[…]` (or a flex equivalent). Convert to **mobile-first natural-height that scrolls, fixed-height two-pane at `lg`**:

- Base: `flex flex-col gap-…` (natural height; scrolls with the shell).
- `lg`: `lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[…]` (the existing fit-to-viewport two-pane).
- Panels (roster, leaderboard, gallery): grow with `lg:flex-1`; below `lg` size to content with a sensible `max-h` so long lists scroll **inside** the panel instead of clipping the page.

Applies to: `HostLobby`, `HostDrawing`, `HostGuessing`, `HostReveal`, `HostEnded`. Keep all existing decorative classes (tape, tilt, reveal-clip, etc.).

### 4. Responsive shared components

- **`CodeCard`** (`display/CodeCard.tsx`): stack the code block and QR vertically on narrow widths (and/or reduce the code type scale + QR size) so the card never exceeds its column. Two-up horizontal layout returns at `sm`/`md`.
- **`Segmented`** (`Segmented.tsx`): let options shrink to fit — allow the row to wrap, or let buttons shrink and the label text shrink, so wide option sets (Mode, Draw time) fit a phone column without overflow. The sliding thumb must still measure correctly after wrap/resize (it already re-measures on `resize`; verify it re-measures on wrap).
- **`HostConfig` `Row`** (`stages/HostConfig.tsx`): already `flex-wrap`; ensure the control drops cleanly under its label on narrow widths and the `Segmented` inside fits.

### 5. Tablet portrait verification

Confirm 640–1023px renders the stacked, scrollable single-column display for every phase (lobby, drawing, guessing, reveal, ended) and for both host modes — intentional, readable, no clipping.

## Out of scope

- No backend changes.
- No new host capabilities (drawing/guessing logic unchanged).
- No redesign of the desktop two-pane layouts beyond the mobile-first refactor needed to host them.

## Testing

- **Update** `routes` / home test: Host tab is now present on mobile (was asserted hidden). Assert the mode toggle offers only Play-along below 640px.
- **`stages.test.tsx`**: existing Host phase render tests must still pass; add assertions that phase roots render without requiring `lg` (no crash / content present at narrow widths).
- Manual responsive sweep at 320 / 375 / 640 / 768 / 1024 / 1440 widths, portrait and landscape, for: home Host tab, Play-along lobby + play phases, Big-screen lobby + play phases. No horizontal clipping; vertical scroll only where intended; large landscape stays locked/no-scroll.

## Affected files

- `frontend/src/routes/index.tsx`
- `frontend/src/hooks/use-is-mobile.ts` (comment/intent)
- `frontend/src/components/game/GameStage.tsx`
- `frontend/src/components/game/stages/HostStage.tsx`
- `frontend/src/components/game/stages/PlayingHostStage.tsx` (verify; minor if needed)
- `frontend/src/components/game/stages/HostConfig.tsx`
- `frontend/src/components/game/display/CodeCard.tsx`
- `frontend/src/components/Segmented.tsx`
- Relevant tests (home tab test, `stages.test.tsx`)
