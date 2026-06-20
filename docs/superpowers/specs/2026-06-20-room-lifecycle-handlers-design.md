# Room lifecycle handlers — design

Date: 2026-06-20

Four related handlers for departures and host control in a running room.

## Goals

1. **Departed-player notice** — when a player is removed, everyone sees a brief toast in any phase.
2. **Auto-return below minimum** — if a real departure drops a running game under 4 players, send everyone back to the lobby.
3. **Host-leave kick** — when the host leaves (or its display is gone past grace), eject all players to the main menu with a message.
4. **Host "back to lobby"** — a host control to abandon a running game back to the lobby before it ends.

## Decisions (locked)

- **Bounce trigger:** only on a *real* departure (Leave button or 60s grace expiry). A brief disconnect/refresh keeps the game running — the player stays in the roster, marked `away`. Never bounce on a transient disconnect.
- **Scores on return:** reset to zero. A mid-game return to the lobby is treated as abandoning the game, same as the existing "Play again" flow.
- **Notice scope:** a small toast visible to everyone in every phase (lobby, drawing, guessing, reveal).

## Architecture

Single-goroutine room actor (`room.go`) owns `GameState`; clients get redacted `viewFor` projections over per-socket channels. Frontend store replaces state wholesale on each broadcast. Host is a non-playing spectator (`state.Host`), never in `Players`.

### 1. Departed-player notice — frontend only

Pure roster diff in the store. On each `applyState`, compare the previous player names against the incoming set; any name that disappeared → `pushNotice("{name} left the room")`. A disconnected player stays in the roster (`connected:false`), so they don't disappear and produce no false toast — the toast fires only on actual removal (Leave / grace prune). No protocol change.

New toast system in `store`: `notices: {id:number; text:string}[]`, `pushNotice(text)`, `dismissNotice(id)`. Rendered by a new `<Toasts/>` overlay in `GameStage`; each toast auto-dismisses (~3.5s) via the component, monochrome card styling.

### 2. Auto-return to lobby when < 4 — backend `room.go`

In `removePlayer`, after dropping the player from presence and roster, in order:

1. `len(Players)==0 && !hostConnected()` → `reap()`; return (existing behavior).
2. **else if `phase.inGame()` && `len(Players) < minPlayers` → `returnToLobby()`; return.** (new)
3. else the existing `allDrawn`/`allGuessed` phase-completion checks.

`phase.inGame()` is a new `Phase` helper: true for drawing/guessing/reveal. `returnToLobby()` already zeroes scores, clears round data, and bumps `phaseGen` (cancelling the live advance timer). Because `removePlayer` is only called from `leave` and `prune`, the bounce can never fire on a transient disconnect. Empty roster while a host is connected falls through to case 2 (in-game) and returns to lobby cleanly.

Frontend shows a toast on the in-game→lobby transition (`"Back in the lobby — need 4 players"`), suppressed if a "left" toast already fired in the same `applyState`.

### 3. Host leaves → kick everyone — backend + frontend

A reaped room otherwise just freezes player sockets, so players need an explicit final signal.

- **`state.go`:** add `Closed bool \`json:"closed,omitempty"\`` to `GameState`; `viewFor` copies `v.Closed = g.Closed`. View-only, false normally.
- **`room.go`:** new `closeRoom()` — set `state.Closed = true`, `broadcast()` the final frame, then `reap()`. Wire host departures to it:
  - the host branch of `leave()` (was bare `reap()`),
  - the `CmdHostPrune` handler (host display gone past grace; was bare `reap()`).

  Ordering: `closeRoom` broadcasts *before* `reap()` stops the loop, so the closed frame reaches subscribers' write pumps (still alive — a conn's `done` closes on its own socket disconnect, not on room reap). `Run` skips its post-handle broadcast once reaped, which is fine — the closed frame already went out.
- **Frontend:** `protocol.ts` gains `closed?: boolean`; store mirrors it. `GameStage` effect watches `closed`; on true → `setFlash({message:"The host left — the game ended.", tab:"join"})` + `navigate({to:"/"})`. Home renders the message in its existing red banner.

### 4. Host "back to lobby" mid-game — backend gate + UI

- **Gate change:** `CmdReturnToLobby` is accepted when `c.Player == state.Host && state.Phase != PhaseLobby` (covers drawing/guessing/reveal and the existing ended case). `returnToLobby()` already resets scores and round data.
- **UI:** `RoomHeader` gains an optional `onBackToLobby?: () => void`; `GameStage` passes it only when `screen==='host'` and the phase is in-game, rendered as a "Back to lobby" button beside Leave, behind a `window.confirm()`. The host **Leave** button also gets a `confirm()` since it now closes the room for everyone.

## Testing (`room_test.go`)

- 4-player running game, one player leaves → `Phase==lobby`, all scores 0, `len(Players)==3`.
- Brief `CmdDisconnect` of 1 of 4 → no bounce (roster intact, still in grace).
- Host `CmdLeave` → subscribers receive a view with `Closed==true`, room is reaped.
- `CmdReturnToLobby` from an in-game phase: accepted from the host, ignored from a non-host.

## Touch list

- **Backend:** `state.go` (`Closed` field, `viewFor`, `Phase.inGame`), `room.go` (`removePlayer`, `closeRoom`, `leave`, host-prune, `CmdReturnToLobby` gate), `room_test.go`.
- **Frontend:** `lib/protocol.ts` (`closed`), `lib/store.ts` (notices + roster diff + closed), `components/game/Toasts.tsx` (new), `components/game/GameStage.tsx`, `components/game/shared.tsx` (`RoomHeader`).
</content>
</invoke>
