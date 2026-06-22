# Responsive Hosting on Mobile & Tablet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both host modes (Big-screen display + Play-along) work cleanly across phone, tablet, and desktop, and let phones host (as Play-along).

**Architecture:** Mobile-first reflow with responsive shared components. The Big-screen shell scrolls below `lg` and stays locked/fit-to-viewport at `lg+`. Each host phase keeps its existing `lg:` two-pane and gains a natural-height single-column base. The home page un-gates the Host tab and offers Big-screen only at ≥640px. The horizontal-clip culprits (`CodeCard`, `HostConfig`'s `Segmented` rows) are made to fit a narrow column.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4 (with custom `short:` variant), TanStack Router, Vitest + Testing Library, Biome.

## Global Constraints

- **Breakpoints:** Tailwind defaults — `sm` = 640px, `lg` = 1024px. Custom `short:` variant exists (landscape-phone), do not repurpose it. "Big enough for Big-screen" = **≥640px** (`sm`). "Locked/no-scroll TV" = **`lg`+** (≥1024px).
- **Git commits:** The user runs ALL git commits/pushes. Do NOT run `git commit` or `git push`. Each task lists a suggested message and the files to `git add`; stop after staging and let the user commit. (Execution review gates happen on the staged diff.)
- **Verification commands (run from `frontend/`):**
  - Tests: `npm run test` (all) or `npx vitest run <path>` (single file)
  - Types: `npm run typecheck`
  - Lint: `npm run lint`
- **No backend changes.** No protocol/store changes.
- **Preserve all decorative classes** (`tape`, `tilt-*`, `rise`, `reveal-clip`, `ink-block`, `card-arcade`, shadows) when editing layout classes — only add/adjust the layout/responsive utilities called out.

---

## Task 1: Host-mode gating + un-gate the Host tab

**Files:**
- Create: `frontend/src/lib/host-mode.ts`
- Test: `frontend/src/lib/host-mode.test.ts`
- Modify: `frontend/src/routes/index.tsx`
- Modify (comment only): `frontend/src/hooks/use-is-mobile.ts:3-6`

**Interfaces:**
- Produces: `hostModeOptions(isMobile: boolean): { value: "screen" | "play"; label: string }[]` and `type HostMode = "screen" | "play"`.
- Consumes: `useIsMobile(): boolean` (existing, `frontend/src/hooks/use-is-mobile.ts`).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/host-mode.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hostModeOptions } from "./host-mode";

describe("hostModeOptions", () => {
  it("offers big-screen and play-along on large screens", () => {
    expect(hostModeOptions(false).map((o) => o.value)).toEqual([
      "screen",
      "play",
    ]);
  });

  it("offers only play-along on mobile (a phone is not a shared TV)", () => {
    expect(hostModeOptions(true).map((o) => o.value)).toEqual(["play"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/host-mode.test.ts`
Expected: FAIL — `Failed to resolve import "./host-mode"` / `hostModeOptions is not a function`.

- [ ] **Step 3: Create the helper**

Create `frontend/src/lib/host-mode.ts`:

```ts
// Host mode: "screen" ⇒ the host is the shared big screen (doesn't play);
// "play" ⇒ the host joins the game as a player too.
export type HostMode = "screen" | "play";

export type HostModeOption = { value: HostMode; label: string };

// The big-screen display assumes a real shared screen (tablet/desktop). On a
// phone (isMobile) there's no shared screen to be, so only Play-along is offered;
// tablets and up get both modes.
export function hostModeOptions(isMobile: boolean): HostModeOption[] {
  if (isMobile) return [{ value: "play", label: "Play along" }];
  return [
    { value: "screen", label: "Big screen" },
    { value: "play", label: "Play along" },
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/host-mode.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the helper into the home page**

In `frontend/src/routes/index.tsx`:

(a) Add the import near the other `@/lib` imports (after line 9):

```ts
import { hostModeOptions, type HostMode } from "@/lib/host-mode";
```

(b) Type the `hostMode` state (line 45) using the shared type:

```ts
const [hostMode, setHostMode] = useState<HostMode>("screen");
```

(c) DELETE the mobile→join bounce effect (lines 50-52):

```ts
  useEffect(() => {
    if (isMobile && tab === "host") setTab("join");
  }, [isMobile, tab]);
```

(If `useEffect` is now unused elsewhere in the file, remove it from the React import on line 2.)

(d) Add a derived effective mode just after `cleanCode` (around line 55), so mobile is always treated as play-along without a render flash:

```ts
  // On phones only Play-along is offered, so the effective mode is pinned to
  // "play" there regardless of the (desktop-only) toggle's last value.
  const effectiveHostMode = isMobile ? "play" : hostMode;
```

(e) In `host()` (line 58), use the derived value:

```ts
    const playing = effectiveHostMode === "play";
```

(f) Replace the tabs `Segmented` options (lines 158-170) so Host shows at every size, with short labels on mobile:

```tsx
            options={
              isMobile
                ? [
                    { value: "join" as const, label: "Join" },
                    { value: "host" as const, label: "Host" },
                    { value: "history" as const, label: "History" },
                  ]
                : [
                    { value: "join" as const, label: "Join a room" },
                    { value: "host" as const, label: "Host a game" },
                    { value: "history" as const, label: "History" },
                  ]
            }
```

(g) Replace the host-mode `Segmented` (lines 220-231) to use the helper and the derived value:

```tsx
                <Segmented
                  value={effectiveHostMode}
                  onChange={(v) => {
                    setHostMode(v);
                    setError(null);
                  }}
                  options={hostModeOptions(isMobile)}
                  itemClassName="flex-1 px-4 py-2.5 text-sm font-bold"
                />
```

(h) Change the copy conditional (line 232) from `hostMode === "play"` to the derived value:

```tsx
                {effectiveHostMode === "play" ? (
```

(i) Change the host button label (lines 274-276) to the derived value:

```tsx
                  : effectiveHostMode === "play"
                    ? "Host & play"
                    : "Host a game"
```

- [ ] **Step 6: Update the gate comment**

In `frontend/src/hooks/use-is-mobile.ts`, replace the comment on lines 3-6 (the hook itself is unchanged):

```ts
// Big-screen hosting needs a real shared screen, so on phones we offer only the
// Play-along host mode (the big-screen option is hidden). Mobile is anything
// below Tailwind's `sm` breakpoint (640px). Tracks live so a resize or rotate
// flips the gate.
```

- [ ] **Step 7: Verify**

Run: `cd frontend && npx vitest run src/lib/host-mode.test.ts && npm run typecheck && npm run lint`
Expected: tests PASS, typecheck clean, lint clean.

- [ ] **Step 8: Stage (user commits)**

```bash
git add frontend/src/lib/host-mode.ts frontend/src/lib/host-mode.test.ts frontend/src/routes/index.tsx frontend/src/hooks/use-is-mobile.ts
```

Suggested message: `feat(home): allow hosting on mobile (play-along), gate big-screen at sm`

---

## Task 2: Responsive Big-screen shell (scroll below lg, lock at lg+)

**Files:**
- Modify: `frontend/src/components/game/GameStage.tsx:115-129`

**Interfaces:**
- No exported API change. Only the `shell` class string for `bigScreen` and its explaining comment change.

- [ ] **Step 1: Update the shell + comment**

In `frontend/src/components/game/GameStage.tsx`, replace the comment block and the `bigScreen` branch of `shell` (lines 115-129).

Replace the comment (lines 115-123) with:

```tsx
  // The host is a shared "TV". On a large landscape screen (lg+) it locks to the
  // viewport height and never scrolls, so nothing jumps for the players watching.
  // On smaller/portrait screens that no-scroll fit can't hold all the content
  // (e.g. the lobby's settings form), so below lg the shell grows past the
  // viewport and the page scrolls instead. The player/play-along shell is the
  // narrow controller: it widens into a two-pane workspace on wide desktops and
  // keeps the side-by-side canvas room on short/landscape phones.
```

Change the `bigScreen` shell string (line 125) from:

```tsx
    ? "mx-auto flex h-dvh w-full max-w-[1700px] flex-col gap-5 overflow-hidden px-6 py-5 sm:px-10"
```

to:

```tsx
    ? "mx-auto flex min-h-dvh w-full max-w-[1700px] flex-col gap-5 px-6 py-5 sm:px-10 lg:h-dvh lg:min-h-0 lg:overflow-hidden"
```

Leave the non-`bigScreen` (play-along/player) shell string unchanged.

- [ ] **Step 2: Verify existing tests + types still pass**

Run: `cd frontend && npx vitest run src/components/game/stages/stages.test.tsx && npm run typecheck`
Expected: PASS, clean. (jsdom does not apply CSS, so this only guards against breakage; visual behavior is checked in Task 6.)

- [ ] **Step 3: Stage (user commits)**

```bash
git add frontend/src/components/game/GameStage.tsx
```

Suggested message: `fix(host): scroll the big-screen shell below lg, keep it locked at lg+`

---

## Task 3: Mobile-first host phase layouts

The host canvas box (`HOST_CANVAS_BOX`) has no intrinsic height — it fills a `flex-1` cell. Below `lg` (natural height) that collapses to 0 and the drawing disappears, so every big-canvas call site gets an explicit `aspect-[4/3]` on small and reverts to `flex-1` at `lg`. Each phase root becomes a natural-height flex column that scrolls, upgrading to the existing fixed-height two-pane at `lg`. Panels grow only at `lg` (`lg:flex-1`); below they size to content.

**Files:**
- Modify: `frontend/src/components/game/stages/HostStage.tsx` (HostEnded, HostLobby, HostDrawing, HostGuessing, HostReveal)
- Modify: `frontend/src/components/game/display/DrawingCarousel.tsx:30`

**Interfaces:**
- No API change. Pure class-string edits.

- [ ] **Step 1: HostEnded** (`HostStage.tsx`)

Root grid (line 93): from
```tsx
    <div className="grid h-full min-h-0 gap-6 lg:grid-cols-[1.6fr_1fr]">
```
to
```tsx
    <div className="flex flex-col gap-6 lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[1.6fr_1fr]">
```

Scoreboard Panel (line 115): from `<Panel className="flex-1" title="Final scores">` to `<Panel className="lg:flex-1" title="Final scores">`.

- [ ] **Step 2: DrawingCarousel canvas box** (`DrawingCarousel.tsx`)

Line 30: from
```tsx
      <div className={`relative min-h-0 flex-1 ${HOST_CANVAS_BOX}`}>
```
to
```tsx
      <div
        className={`relative aspect-[4/3] lg:aspect-auto lg:min-h-0 lg:flex-1 ${HOST_CANVAS_BOX}`}
      >
```

- [ ] **Step 3: HostLobby** (`HostStage.tsx`)

Root grid (line 137): from
```tsx
    <div className="grid h-full min-h-0 gap-6 lg:grid-cols-[1.05fr_0.95fr]">
```
to
```tsx
    <div className="flex flex-col gap-6 lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[1.05fr_0.95fr]">
```

"In the lobby" Panel (line 144): from `className="flex-1"` to `className="lg:flex-1"`.

HostConfig wrapper (line 161): from
```tsx
        <div className="flex min-h-0 flex-1 flex-col">
```
to
```tsx
        <div className="flex flex-col lg:min-h-0 lg:flex-1">
```

- [ ] **Step 4: HostDrawing** (`HostStage.tsx`)

Root (line 190): from
```tsx
    <div className="flex h-full min-h-0 flex-col gap-5">
```
to
```tsx
    <div className="flex flex-col gap-5 lg:h-full lg:min-h-0">
```

"Sketching…" Panel (line 208): from `className="flex-1"` to `className="lg:flex-1"`.

- [ ] **Step 5: HostGuessing** (`HostStage.tsx`, classic path — the `FlippedGuessing` branch is unchanged)

Root grid (line 255): from
```tsx
    <div className="grid h-full min-h-0 gap-6 lg:grid-cols-[1.6fr_1fr]">
```
to
```tsx
    <div className="flex flex-col gap-6 lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[1.6fr_1fr]">
```

Canvas box (line 270): from
```tsx
        <div
          key={featureIndex}
          className={`tape reveal-clip flex-1 ${HOST_CANVAS_BOX}`}
        >
```
to
```tsx
        <div
          key={featureIndex}
          className={`tape reveal-clip aspect-[4/3] lg:aspect-auto lg:min-h-0 lg:flex-1 ${HOST_CANVAS_BOX}`}
        >
```

"Players" Panel (line 275): from `className="flex-1"` to `className="lg:flex-1"`.

- [ ] **Step 6: HostReveal** (`HostStage.tsx`)

Root grid (line 320): from
```tsx
    <div className="grid h-full min-h-0 gap-6 lg:grid-cols-[1.6fr_1fr]">
```
to
```tsx
    <div className="flex flex-col gap-6 lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[1.6fr_1fr]">
```

noArtist box (lines 322-324): from
```tsx
        <div
          className={`flex flex-col items-center justify-center gap-3 p-8 text-center ${HOST_CANVAS_BOX}`}
        >
```
to
```tsx
        <div
          className={`flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center lg:min-h-0 ${HOST_CANVAS_BOX}`}
        >
```

Featured-drawing canvas box (line 340): from
```tsx
          <div
            key={featureIndex}
            className={`tape reveal-clip min-h-0 flex-1 ${HOST_CANVAS_BOX}`}
          >
```
to
```tsx
          <div
            key={featureIndex}
            className={`tape reveal-clip aspect-[4/3] lg:aspect-auto lg:min-h-0 lg:flex-1 ${HOST_CANVAS_BOX}`}
          >
```

"Leaderboard" Panel (line 443): from `<Panel className="flex-1" title="Leaderboard">` to `<Panel className="lg:flex-1" title="Leaderboard">`.

- [ ] **Step 7: Verify existing render tests + types still pass**

Run: `cd frontend && npx vitest run src/components/game/stages/stages.test.tsx && npm run typecheck && npm run lint`
Expected: PASS (the guessing test still finds a `<canvas>`; the drawing-roster test still passes), typecheck/lint clean.

- [ ] **Step 8: Stage (user commits)**

```bash
git add frontend/src/components/game/stages/HostStage.tsx frontend/src/components/game/display/DrawingCarousel.tsx
```

Suggested message: `fix(host): mobile-first phase layouts so the big screen reflows below lg`

---

## Task 4: Responsive CodeCard

`CodeCard` is a fixed two-up row (code + 104px QR) with a min-width wider than a narrow phone column. Stack it vertically below `sm`, restore the row at `sm+`.

**Files:**
- Modify: `frontend/src/components/game/display/CodeCard.tsx:21,47`
- Test (existing, must keep passing): `frontend/src/components/game/display/CodeCard.test.tsx`

**Interfaces:**
- No API change.

- [ ] **Step 1: Stack on narrow**

Outer card (line 21): from
```tsx
    <div className="ink-block flex shrink-0 items-center justify-between gap-4 p-5">
```
to
```tsx
    <div className="ink-block flex shrink-0 flex-col items-start gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
```

QR tile wrapper (line 47): from
```tsx
      <div className="tape shrink-0 rotate-2 rounded-lg border-2 border-[#1b1813] bg-white p-2">
```
to
```tsx
      <div className="tape shrink-0 self-center rotate-2 rounded-lg border-2 border-[#1b1813] bg-white p-2 sm:self-auto">
```

- [ ] **Step 2: Verify the existing CodeCard test still passes**

Run: `cd frontend && npx vitest run src/components/game/display/CodeCard.test.tsx && npm run typecheck`
Expected: PASS (renders the QR `svg`, the code text, and the "scan to join" hint), typecheck clean.

- [ ] **Step 3: Stage (user commits)**

```bash
git add frontend/src/components/game/display/CodeCard.tsx
```

Suggested message: `fix(host): stack CodeCard vertically on narrow screens`

---

## Task 5: HostConfig Segmented controls fit a narrow column

The settings `Segmented` controls use the default `itemClassName` (intrinsic width, no `flex-1`), so wide option sets (e.g. "Classic · Whose Doodle · Frenzy") overflow a phone column. Make each settings `Segmented` full-width on narrow with `flex-1` buttons, reverting to its natural inline size at `sm`. The `Row` already wraps (`flex-wrap`), so a `w-full` child drops onto its own full-width line below `sm`.

**Files:**
- Modify: `frontend/src/components/game/stages/HostConfig.tsx` (the six `Segmented` usages: Mode, Category language, Draw time, Guess time, Categories, Save art)

**Interfaces:**
- No API change. `Segmented` already accepts `className` and `itemClassName`.

- [ ] **Step 1: Add responsive classes to each settings Segmented**

For EACH of the six `<Segmented …>` elements in `HostConfig.tsx` (Mode ~line 91, Category language ~line 118, Draw time ~line 132, Guess time ~line 143, Categories ~line 157, Save art ~line 171), add these two props (keep all existing props — `value`, `options`, `onChange`):

```tsx
          className="w-full sm:w-auto"
          itemClassName="flex-1 px-3 py-1.5 text-sm font-semibold"
```

Concretely, the Mode control becomes:

```tsx
      <Row label="Mode">
        <Segmented
          value={gameMode}
          className="w-full sm:w-auto"
          itemClassName="flex-1 px-3 py-1.5 text-sm font-semibold"
          options={[
            { value: "classic" as const, label: "Classic" },
            { value: "flipped" as const, label: "Whose Doodle" },
            { value: "frenzy" as const, label: "Frenzy" },
          ]}
          onChange={(v) => {
            setGameMode(v);
            sync({ gameMode: v });
          }}
        />
      </Row>
```

Apply the identical two props to the other five `Segmented` controls. (The `px-3 py-1.5 text-sm font-semibold` matches the component's current default `itemClassName`, so desktop sizing is unchanged; the only additions are `flex-1` and the `w-full sm:w-auto` wrapper.)

- [ ] **Step 2: Verify types/lint + the host stage tests**

Run: `cd frontend && npx vitest run src/components/game/stages/stages.test.tsx && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 3: Stage (user commits)**

```bash
git add frontend/src/components/game/stages/HostConfig.tsx
```

Suggested message: `fix(host): let settings Segmented controls fill a narrow column`

---

## Task 6: Full verification sweep (responsive + regression)

No code changes unless the sweep finds a defect. Confirm the whole feature holds together.

**Files:**
- None expected. If a defect is found, fix in the owning file and re-run.

- [ ] **Step 1: Full automated suite**

Run: `cd frontend && npm run test && npm run typecheck && npm run lint`
Expected: all tests PASS, typecheck clean, lint clean.

- [ ] **Step 2: Manual responsive sweep**

Start the app (`cd frontend && npm run dev`) and, using browser responsive mode, check each width in **portrait and landscape**: **320, 375, 640, 768, 1024, 1440**.

Verify, with NO horizontal clipping at any width (no content cut off the left/right edge), vertical scroll only where intended, and the drawing canvas always visible (never 0-height):

1. **Home → Host tab** is present at every width. Below 640px the mode toggle shows only "Play along" (no "Big screen"); at ≥640px both show.
2. **Play-along host** (host → "Play along"): lobby (code card, settings, roster, start) reachable and uncliped on a phone; then drawing / guessing / reveal phases.
3. **Big-screen host** (host → "Big screen", ≥640px): lobby scrolls on portrait tablet (768) and is reachable; locks/fits with no page scroll at ≥1024px landscape.
4. **Big-screen play phases** (drawing, guessing, reveal, ended): canvas renders at a sensible size on tablet portrait; two-pane and locked at ≥1024px. Confirm the end-game **carousel** drawing is visible on tablet portrait.

- [ ] **Step 3: Stage any fixes (user commits)**

If Step 2 surfaced fixes, `git add` the touched files.
Suggested message (only if fixes were made): `fix(host): responsive sweep follow-ups`

---

## Self-Review (completed by plan author)

- **Spec coverage:** Home un-gate + mode gating → Task 1. Responsive shell (scroll small / lock large) → Task 2. Mobile-first phase layouts (lobby/drawing/guessing/reveal/ended) → Task 3. CodeCard responsive → Task 4. Segmented/HostConfig fit → Task 5. Tablet-portrait verification + PlayingHostStage verification → Task 6. PlayingHostStage needs no edits because its only overflow sources (CodeCard, HostConfig Segmented) are fixed in Tasks 4–5; its lobby already scrolls vertically (`overflow-y-auto`) and its play phases reuse the already-responsive PlayerStage.
- **Placeholder scan:** none — every step has concrete class strings / code.
- **Type consistency:** `HostMode` and `hostModeOptions` defined in Task 1 are the only new symbols; used consistently in `index.tsx`. No other cross-task symbols.
- **Note:** Tasks 2–5 are CSS-class changes; jsdom applies no layout, so they cannot be unit-tested by width. They are guarded by existing render tests (no breakage) + typecheck/lint, and validated by the Task 6 manual responsive sweep. Only Task 1 (pure gating logic) is TDD-tested.
