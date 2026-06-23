# Changelog — branch `alimohsen999/sko-12-implement-frenzy-gamemode`

Full delta of this branch versus `main`.

- **Base (merge-base with `main`):** `91e3ffd`
- **Tip:** `8d4850a` + uncommitted working-tree changes (Frenzy v2)
- **Span:** 2026-06-21 → 2026-06-23
- **Authors:** Kwaddo (24 commits), Moataz Ibrahim (1 commit)
- **Committed:** 25 commits, 88 files, **+14,523 / −1,022**
- **Uncommitted (Frenzy v2, not yet committed):** 5 files, **+259 / −63** + 3 new untracked files

The branch bundles several features on top of `main`: a multi-drawing round redesign, the "Whose Doodle" (flipped) game mode, the Frenzy game mode (v1 → room-wide waves → the v2 redesign below), a drawing-canvas performance/UX rework, and history/UI polish.

---

## A. Core gameplay redesign — multi-drawing rounds & play-along host

- `75b14db` 2026-06-21 — feat: multi-drawing rounds, play-along host, and a hand-drawn redesign _(Moataz Ibrahim)_
- `5474bdd` 2026-06-21 — Clear departed players' round data

Rounds now feature several drawings ("who drew this?" repeated per featured drawing over one prompt), the host can play along instead of only running the TV, and the whole UI moved to a hand-drawn visual style. Departed players' round data is cleared so a leaver can't spoil scoring or featured selection.

## B. Game-mode foundation & "Whose Doodle" (flipped) mode

- `14bee18` 2026-06-22 — chore: baseline in-progress work + mode specs/plans
- `d15d07c` 2026-06-22 — feat(game): add mode foundation (classic default, flipped enum)
- `ea2560a` 2026-06-22 — feat(lobby): add game-mode selector and store plumbing
- `6b78e59` 2026-06-22 — feat(game): flipped guessing view with anonymized doodle pool
- `43e5bd6` 2026-06-22 — feat(game): resolve and score flipped doodle guesses
- `0716da5` 2026-06-22 — feat(ui): flipped doodle-grid guessing and reveal on the player
- `8bed42a` 2026-06-22 — feat(ui): flipped doodle-grid guessing on the host screen
- `8ddc351` 2026-06-22 — test(game): full flipped-round integration coverage
- `341c940` 2026-06-22 — test(game): strengthen flipped-round redaction assertion

Adds the `Config.Mode` / `GameState.Mode` foundation (`classic` default + `flipped` enum), a lobby mode selector, and the full flipped mode: guessers pick which anonymized doodle belongs to whom from a grid, with server-side resolution, scoring, and redaction (no client sees who drew what until reveal).

## C. Frenzy mode (v1)

- `d02c4aa` 2026-06-22 — feat(game): frenzy powerup catalog, state, and redacted views
- `77cc163` 2026-06-22 — feat(game): frenzy drop ticker (generation-gated, per-phase)
- `7808a8a` 2026-06-22 — feat(game): fire a powerup at a random rival
- `cdcba39` 2026-06-22 — feat(game): clear frenzy state on game-end, lobby, and departure
- `fc38d3b` 2026-06-22 — feat(ui): frenzy plumbing, effects hook, and lobby option
- `8f57900` 2026-06-22 — feat(ui): frenzy powerup tray with fire + hit toasts
- `4072cf0` 2026-06-22 — fix(ui): scope frenzy tray lint suppression + fix toast dedup on round reset
- `592df94` 2026-06-22 — feat(ui): frenzy drawing-phase effects (fog/lights/flip/cramp)
- `1f2a428` 2026-06-22 — feat(ui): frenzy guess-phase effects (squint/curtain/shuffle)
- `1ade6aa` 2026-06-22 — Replace powerups with room-wide effect waves

Frenzy started as a collect-and-fire model (a server ticker dropped powerups into each player's inventory; tapping one fired it at a random rival, with a tray + toasts). `1ade6aa` then **replaced that** with room-wide ambient effect waves: a timer hits every active player at once, each rolling their own short-lived perception/input nuisance (fog, lights, flip, cramp while drawing; squint, curtain, shuffle, hidenames while guessing). Effects are view-only or a brief input lock — they never touch stroke data — and are server-stamped with an absolute expiry and redacted per-recipient.

## D. Drawing-canvas performance & UX rework

- `b861dc9` 2026-06-22 — Client-first drawing and silent draft deltas
- `a45758f` 2026-06-22 — Use offscreen compositor and drop prediction
- `8d4850a` 2026-06-23 — Make drawing canvas single-column with bottom bar

Drawing is now client-first (strokes render locally immediately; draft deltas sync silently without broadcast/persist churn), composited offscreen with prediction dropped for fidelity, and the canvas relaid out as a single column with a bottom bar.

## E. History / UI polish

- `57d0c1d` 2026-06-22 — refactor: slight tailwind improvement in HistoryTab.tsx

(The local drawing-history/gallery feature — `lib/history.ts`, `components/history/HistoryTab.tsx`, `hooks/use-drawing-history.ts` — also lands across this branch's file set.)

---

## F. Frenzy v2 — "Chaotic Survival" (UNCOMMITTED working tree)

Backend-only redesign of the Frenzy wave model. Reviewed READY TO MERGE (0 Critical, 0 Important); tests + `go build` + `go vet` clean. Not yet committed (owner commits).

**What changed vs the v1 room-wide waves:**
- **Shared, not per-player:** a wave now applies **one** tier-selected effect to the whole affectable room at once (was: a different random effect per player). Level field.
- **Severity tiers:** each phase pool is split mild/medium/harsh; the wave's tier is picked by phase progress (cuts at 0.45 / 0.80). Draw — mild `fog`, medium `flip`, harsh `lights`/`cramp`. Guess — mild `squint`/`hidenames`, medium `shuffle`, harsh `curtain`.
- **Escalating cadence:** wave gaps tighten from ~28% → ~10% of the phase (floored 4s); effect duration tracks the gap (floored 2.5s), so late waves run near-continuous — a chaos climax into the buzzer.
- **Early-lock grace (free):** the existing affectable gate already exempts locked-in drawers / already-guessed players, so committing early dodges the harsh late waves. No new code — it's the survival skill.
- **Scoring & frontend untouched.** Old fixed cadence constants removed.

**Files (uncommitted):**
- `backend/internal/game/powerups.go` — tiers + `tierForProgress`/`effectForWave`; `applyEffectWave` → one shared effect
- `backend/internal/game/room.go` — fraction cadence constants + helpers; rewired `CmdEffectWave`
- `backend/internal/game/rounds.go` — `startPhase` arms first wave via `firstWaveDelay`
- `backend/internal/game/powerups_test.go` — shared-effect + escalation + tier tests
- `backend/internal/game/cadence_test.go` _(new)_ — cadence helper unit tests
- `docs/superpowers/specs/2026-06-23-frenzy-chaotic-survival-design.md` _(new)_ — design spec
- `docs/superpowers/plans/2026-06-23-frenzy-chaotic-survival.md` _(new)_ — implementation plan

---

## File-change summary (committed, by area)

Backend (`backend/internal/game/`): mode foundation, flipped resolution/scoring, frenzy catalog/ticker/state/redaction, round-data cleanup, plus matching tests.

Frontend (`frontend/src/`): 88-file total spans —
- **Stages:** `PlayerStage.tsx` (+426), `HostStage.tsx` (+244), new `PlayingHostStage.tsx` (+112), `HostConfig.tsx`, `stages.test.tsx`
- **Frenzy/effects:** `hooks/use-effects.ts` + test, `lib/protocol.ts`, `lib/store.ts`, `overlays/Toasts.tsx`
- **History:** new `lib/history.ts` (+225) + test (+264), new `components/history/HistoryTab.tsx` (+361) + test (+150), `hooks/use-drawing-history.ts`
- **Drawing/canvas:** `lib/canvas.ts`, `display/host-canvas.ts`, `display/Timer.tsx`, `hooks/use-countdown.ts` + test
- **Modes/host:** new `lib/host-mode.ts` + test, new `lib/mode-store.test.ts`, `routes/index.tsx` (+320), `routes/host.$code.tsx`
- **Styling/setup:** `index.css` (+591), `icons.tsx` (+89), new `test-setup.ts`, `vite.config.ts`

Full per-file stat: `git diff --stat 91e3ffd..HEAD`.
Full per-commit diff: `git log -p 91e3ffd..HEAD`.
