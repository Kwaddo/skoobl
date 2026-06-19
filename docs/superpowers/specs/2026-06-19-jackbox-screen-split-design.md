# Jackbox-style screen split — design

Date: 2026-06-19
Branch: `alimohsen999/sko-7-revamp-game-flow-to-be-more-like-jackbox`

## Problem

Today `/host/$code` and `/play/$code` render the **same** `GameStage`. The host
is just the first player + the room leader; everyone draws and guesses on their
own screen, and the featured drawing is shown to *every* recipient during
guessing.

We want a Jackbox-style split:

- **Host screen** = a shared "TV" display. It shows the roster of who has
  finished drawing, then the drawing to be guessed, then the reveal/scoreboard.
  It does **not** draw or guess.
- **Player screen** = a phone controller. It shows the drawing canvas, and
  during guessing **only** the list of players to pick from. Players look at the
  TV to see the drawing.

## Decisions (from brainstorming)

- The host is a **spectator display**, not a participant. It controls the game
  (settings / start / next) but never draws, guesses, or scores.
- **Single host-display model**: there is exactly one host per room. A second
  `/host` connection with a different name is rejected.
- **min-players stays 4**, now meaning 4 *joined players* (the host no longer
  counts toward it).
- **Host TV is required**: if it disconnects past the 60s grace (a real close,
  not a refresh), the room ends. A refresh / brief blip reconnects by name
  within grace and is seamless.
- The **prompt word is shown on the TV during drawing** as a subtle header. It
  is shared, non-secret knowledge (every player draws it).

## Flow (unchanged)

`lobby → drawing → guessing → reveal → (next round) drawing … → ended`

Only *who sees what* changes.

## Screen matrix

| Phase | Host TV (`/host`, spectator) | Player phone (`/play`) |
|---|---|---|
| **lobby** | room code · live player roster · game settings · Start button | "you're in" + your avatar/name · live player roster · "waiting for host" |
| **drawing** | roster with ✓ *finished* vs *drawing…* · timer · prompt word (subtle header) | the word · **canvas** · timer · Lock-in button → "locked in, look at the screen" |
| **guessing** | **the featured drawing, large** · "Who drew this?" · who-has-guessed roster · timer | "look at the screen — who drew it?" · **list of players to pick** · artist sees "this one's yours" · after guessing: "guessed X, waiting" |
| **reveal** | the drawing · "drawn by X" · who guessed right · **full scoreboard** | personal result: ✓/✗ + your score · "waiting for host to continue" |
| **ended** | winner + full scoreboard + **Play again** (host only) | winner + full scoreboard + "waiting for the host to start a new game" |

## Architecture

### Key property: no `GameState` shape change

The spectator reuses existing fields. During guessing/reveal it receives the
same `currentDrawing` and `reveal` that players already get; the roster flags
(`hasDrawn`, `hasGuessed`, `correct`, `connected`, `score`) already exist. The
prompt-on-TV reuses `yourPrompt`. So the wire protocol (`protocol.ts`,
`GameState`) is unchanged except for the inbound `join` payload gaining a
`spectator` flag. Because the host is never in `Players`/`Featured`/`Guesses`,
the existing `viewFor` already produces a correct redacted host view with no
changes.

### Backend (`backend/internal/...`)

1. **Join flag.** `realtime/socket.go` `join` reads a `spectator` bool from the
   payload and sets `Command.Spectator`. `game.Command` gains `Spectator bool`.

2. **Single host-display model.** The spectator *is* the room `Host`
   (existing `GameState.Host` field). Presence is tracked by one new field on
   `Room`, `host *presence`, kept **out of** `Players` and out of the
   player-presence map. Because the host is never in `Players`, it is
   automatically excluded from `connectedCount` (min-players), `allDrawn`,
   `allGuessed`, `pickFeatured`, and scoring — no per-call `if spectator`
   guards needed.

3. **`room.join` spectator branch.**
   - Reject if `Phase == ended`.
   - If a host is already present under a different name → reject
     ("This room already has a host.").
   - Same host name returning while disconnected → reconnect (restore presence,
     bump gen, re-subscribe).
   - First spectator: set `state.Host = name`, mark `host` presence connected,
     subscribe, cancel the empty-timer.
   - Reject if `name` is already a player ("That name's taken in this room.").
   - Do **not** append to `Players`.

   **Name uniqueness across host + players.** To keep the host distinguishable
   from players everywhere (auth, view selection), the host name is reserved:
   player `join` rejects a name equal to `state.Host`, and spectator `join`
   rejects a name already in `Players`.

4. **Lifecycle / reaper.** A room is "empty" only when there are **no connected
   players and the host is disconnected**.
   - `CmdReapIfEmpty`: reap only if `len(Players) == 0 && host not connected`.
   - `removePlayer`: when `Players` becomes empty, reap only if the host is not
     connected; otherwise wait (no host promotion — the host is a spectator).
   - Host disconnect: mark `host` presence not-connected and arm a host-prune
     grace timer (`CmdHostPrune`); when it fires, if the host hasn't returned,
     reap the room ("host left → game over"). A host that returns within grace
     bumps the gen and cancels it.
   - `onStart` (restored snapshot): if `Host != ""`, arm a host prune so an
     abandoned restored room reaps.

5. **Play again.** A host-only `CmdReturnToLobby` (`ended → lobby`) keeps the
   players, host, and configured settings but zeroes scores and clears all
   round data, so a group can play again without re-joining. Wired as the
   `returnToLobby` socket event.

6. **Authorization unchanged.** `configure` / `start` / `nextPhase` /
   `returnToLobby` gate on `c.Player == r.state.Host`; the host's commands are
   stamped with its name, so this keeps working.

### Frontend (`frontend/src/...`)

1. **Routes pass a screen role.** `routes/host.$code.tsx` →
   `<GameStage code screen="host" />`; `routes/play.$code.tsx` →
   `screen="player"`. (The prop is named `screen`, not `role`, to avoid a Biome
   ARIA false-positive.)

2. **Socket hook.** `useGameSocket(code, name, { spectator })` includes
   `spectator` in the `join` emit. Host route passes `spectator: true`. Exports
   a `GameActions` type (incl. `returnToLobby`).

3. **Component split.** The 740-line `GameStage.tsx` is split into focused units:
   - `GameStage.tsx` — shell: socket wiring, `RoomHeader`, error/leave, and
     routing to Host vs Player views by `screen`.
   - `HostStage.tsx` — TV phase views + the host settings form.
   - `PlayerStage.tsx` — phone phase views (canvas, pick-list-only guessing).
   - `shared.tsx` — `RoomHeader`, `Timer`, `Scoreboard`, `PlayerGrid`,
     `LeaderBadge`, `CodeCard`, `ErrorPanel`, `EndedStage`, and a new `Roster`.

4. **Player guessing drops the drawing.** `PlayerStage` guessing view does not
   render `StrokesView`; it shows only the pick list. The drawing lives on the
   TV.

5. **EndedStage / Play again.** `EndedStage` takes an optional `onPlayAgain`;
   the host passes `actions.returnToLobby` (renders the "Play again →" button),
   players pass nothing (they see "waiting for the host to start a new game").

## Testing

- **Backend (`room_test.go`):** spectator join sets Host + absent from Players;
  second host rejected; host/player name collisions rejected; min-players counts
  only players; reaper considers the host; host disconnect/leave reaps; host
  reconnect keeps the room; return-to-lobby resets and allows a restart.
- **Frontend:** host join emits `spectator: true`; `returnToLobby` emits;
  host guessing renders the drawing (canvas) while player guessing renders the
  pick list (no canvas); host ended shows "Play again", player ended does not.

## Out of scope

- Multiple simultaneous TV displays per room.
- Letting the host also play from a second device (the organizer can open
  `/play` on a phone with a different name as an ordinary player).
- Resilience to TV loss mid-game beyond the grace window.
- Clean restore of rooms persisted under the old (player-as-host) model.
