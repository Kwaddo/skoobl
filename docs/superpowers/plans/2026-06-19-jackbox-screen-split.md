# Jackbox-style Screen Split — Implementation Plan

**Status:** ✅ Implemented & verified (backend `go test`/vet/build, frontend
typecheck/test/lint/build all green).

**Goal:** Make `/host` a non-playing spectator "TV" (roster + the drawing to
guess + reveal/scoreboard) and `/play` a phone controller (canvas + guess list),
Jackbox-style. Plus host-only "Play again" that returns the room to the lobby.

**Design:** `docs/superpowers/specs/2026-06-19-jackbox-screen-split-design.md`.

> Note: this is a restored record of the plan. The original bite-sized TDD
> step list was trashed and rebuilt after the work was already implemented, so
> it is captured here as completed tasks rather than re-emitting every code
> block. The spec carries the full design; the code carries the detail.

## Global constraints

- Never run `git commit`/`git push` — the user commits. Tasks stage with `git add`.
- `minPlayers = 4` / `MIN_PLAYERS = 4` — counts players only; the host never counts.
- One host per room. Host name is reserved (no player/spectator name collision).
- No `GameState` wire-shape change; `viewFor` untouched (host view is correct by
  virtue of the host being absent from `Players`/`Featured`/`Guesses`).

## Tasks

### Task 1 — Backend: spectator join model ✅
- `room.go`: `Command.Spectator`, `Room.host *presence`, `hostConnected()`,
  `join` branches to `joinSpectator` (claims `Host`, never enters `Players`,
  rejects 2nd host / name collisions); player `join` reserves the host name;
  dropped player-host assignment. `socket.go`: `join` reads `spectator`
  (+`boolField`).
- Tests: spectator-not-a-player, second-host-rejected, name-collision (both
  directions); updated start/configure/persist tests to use a spectator host.

### Task 2 — Backend: host lifecycle ✅
- `disconnect` host branch + `armHostPrune` + `CmdHostPrune` reap;
  `leave` host→reap; `removePlayer` reap-only-when-no-host (no promotion);
  `CmdReapIfEmpty` host-aware; `onStart` arms host prune on restore.
- Tests: not-reaped-while-host-connected, reaped-on-host-disconnect,
  reaped-on-host-leave, players-remain-but-host-gone-reaps, host-reconnect-keeps-room.

### Task 3 — Frontend: role-aware socket + routes ✅
- `useGameSocket(code, name, { spectator })` emits the flag; exports `GameActions`.
- Routes pass `screen="host" | "player"`.
- Test: host emits `spectator: true`.

### Task 4 — Frontend: shared components module ✅
- `shared.tsx`: `RoomHeader`, `CodeCard`, `Scoreboard`, `LeaderBadge`,
  `PlayerGrid`, `Timer`, `ErrorPanel`, `EndedStage`, and new `Roster`.

### Task 5 — Frontend: HostStage (the TV) ✅
- Lobby (code + roster + settings + Start), drawing (roster + prompt header),
  guessing (large drawing + guessed roster), reveal (drawing + answer +
  scoreboard), ended (scoreboard + **Play again**).

### Task 6 — Frontend: PlayerStage (the controller) ✅
- Lobby (waiting + roster), drawing (canvas + submit), guessing (**pick list
  only**, no drawing), reveal (personal ✓/✗ + score), ended (scoreboard + wait).

### Task 7 — Frontend: GameStage shell + split tests ✅
- Shell wires socket (spectator when host), header, error/leave; routes to
  Host/Player by `screen`; host container is wider.
- `stages.test.tsx`: host guessing shows a canvas; player guessing shows the
  pick list and no canvas; host ended shows "Play again"; player ended does not.

### Task 8 — Play again (follow-up) ✅
- Backend host-only `CmdReturnToLobby` (`ended → lobby`, keep players/host/
  settings, zero scores, clear round data); `returnToLobby` socket event.
- Frontend `returnToLobby` action; `EndedStage` gets optional `onPlayAgain`
  (host renders the button → back to lobby; players see a wait line, nobody
  kicked out).
- Tests: `TestReturnToLobbyResetsAndAllowsRestart`; socket emits `returnToLobby`;
  ended-screen button presence per role.

## Out of scope

Multiple TV displays per room; host also playing from a second device;
mid-game TV-loss resilience beyond grace; restore of old (player-as-host)
snapshots.
