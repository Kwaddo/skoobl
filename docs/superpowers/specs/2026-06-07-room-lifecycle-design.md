# skoobl Room Lifecycle & Connection Handlers — Design

**Date:** 2026-06-07
**Status:** Proposed

## Goal

When a room has no connected users, shut it down: stop the room goroutine, free
the code from the hub, and delete its snapshot. Build the family of connection /
room-lifecycle handlers around that core so room state stays correct across
refreshes, drops, host departure, and abusive joins.

## Problem — current gaps

- `Hub.Delete` stops + unregisters a room, but **nothing ever calls it**. Rooms
  and their `Run` goroutines live forever — a goroutine + memory leak that grows
  with every game ever created.
- Disconnect path (`realtime/socket.go`) submits an immediate `CmdLeave`, so a
  **refresh** (or React StrictMode double-mount, or a network blip) yanks the
  player out of `Players` at once and can **demote the host** mid-game.
- No empty detection, no reap, no snapshot deletion. If reap were added naively,
  `Hub.Lookup`'s restore-on-miss would **rehydrate the dead room** from Redis.
- `CmdJoin` silently no-ops a duplicate name (two people collapse into one
  identity). No player cap. Joins are accepted into an already-`ended` room.

## Non-goals (YAGNI)

- Multi-instance reap coordination. Single backend instance; Redis pub/sub stays
  present but unused (matches prior specs).
- Persistent identity beyond the name. **Name = identity**; same name returning
  to a room while the previous holder is disconnected counts as a reconnect.
- Spectators / connections that subscribe without being players.
- Per-room configurable grace. One global default; a `WithGrace` option exists
  for tests and a possible future env knob.

## Confirmed decisions (locked with user)

- **Robust reconnection.** On disconnect the player is kept in the room and marked
  reconnecting; the host stays host. Removed only if they don't return in time.
- **Grace = 60s**, used for both the reconnect window and the room-creation window.
- **Host genuinely leaves** (grace expired) with players remaining → **promote the
  longest-present remaining player** to host.
- **All four edge handlers**: reject duplicate names, cap room at 12, reject joins
  to an `ended` room, stop all rooms on server shutdown.
- **Frontend**: add `start`/`nextPhase` controls to `/play` when `self === host`,
  so a promoted player can actually drive the game.

## Model

Liveness is tracked **outside** the serialized `GameState`, so snapshots stay
clean. The room actor remains the only goroutine touching its state; grace timers
fire commands back into that goroutine, so no locks are introduced.

```go
// room-side, not serialized
type presence struct {
    connected bool
    gen       int // bumped on every disconnect; stale prune timers self-cancel
}
present map[string]*presence
```

`Players` (in `GameState`, broadcast to clients) stays the "in the room" list.
`present` tracks who actually holds a live socket. A player marked
`connected:false` is in their grace window — still shown, still host-eligible —
until pruned.

The **`gen` counter** is what makes reconnection safe. Disconnect bumps `gen` and
arms `AfterFunc(grace, prune{name, gen})`. Reconnect bumps `gen` again, so when
the old timer fires its captured `gen` no longer matches and it does nothing.

### Constants

```go
reconnectGrace = 60 * time.Second // default; overridable via WithGrace (tests)
maxPlayers     = 12
```

## `game` package (`room.go`, `state.go`)

### Commands

- **`CmdJoin`** — decision tree (in `handle`):
  1. `Phase == ended` → emit error *"This game has already ended."*, no change.
  2. name **unknown**: if `len(Players) >= maxPlayers` → error *"This room is
     full."*; else append `Player{Name}`, `present[name] = {connected:true}`, set
     `Host` if empty.
  3. name **known + connected** → duplicate → error *"That name's taken in this
     room."*, no change.
  4. name **known + !connected** → **reconnect**: `connected = true`, `gen++`
     (cancels the pending prune). Host and list position preserved.
- **`CmdDisconnect`** (replaces the instant leave; folds in unsubscribe): remove
  the socket's channel from `subs`; if the player is present + connected, set
  `connected = false`, `gen++`, capture `gen`, arm
  `time.AfterFunc(r.grace, func(){ r.Submit(CmdPrune{name, gen}) })`.
- **`CmdPrune{name, gen}`** (internal, timer-driven): if the player is still
  present, still `!connected`, and `present[name].gen == gen` → remove from
  `Players` and `present`. If the removed player was `Host` and players remain →
  `Host = Players[0].Name` (**promotion**). If `Players` is now empty → **reap**.

`CmdLeave` and `CmdUnsubscribe` are removed — the frontend has no explicit "leave",
and unsubscribe is now part of disconnect.

### Join acknowledgement & subscription ownership

`handle()` runs in the room goroutine and holds only `GameState` broadcast
channels, so it cannot emit a targeted rejection. `CmdJoin` therefore carries an
`Ack chan string` (buffered 1) alongside its `Subscribe` channel: the join handler
sends `""` on accept/reconnect, or the rejection message (full / taken / ended)
otherwise.

Subscription becomes **part of acceptance**. The unconditional "append
`c.Subscribe` before `handle`" block in `Run` is removed; instead the join handler
appends `c.Subscribe` to `subs` only when it accepts or reconnects, and
`CmdDisconnect` removes the channel. A rejected join then leaves no dangling
subscriber.

### Reap + empty detection

- **Creation grace.** When `Run` starts with zero players, arm an empty-room timer
  (`r.grace`). The first join cancels it. If it fires with players still zero →
  reap. Covers "host `POST`ed `/games` then never connected."
- **Post-prune.** The prune that empties `Players` reaps immediately — that
  player's 60s has already elapsed, so no second wait.
- **Reap** = call the injected `onReap()` (hub clears the map + deletes the
  snapshot), then `Stop()` (idempotent via `sync.Once`), then return from `Run`.
  Timers that fire after reap hit the closed `done` channel and drop harmlessly.

### Restore-from-snapshot

A rehydrated room marks **every** restored player `connected:false` and arms a
grace timer for each (same as a disconnect). Reconnecting clients save themselves;
the rest prune out; a fully abandoned restored room reaps. This reuses one
mechanism for restore cleanup.

### Constructors

Collapse the three `NewRoom*` constructors into functional options (matching the
hub's `Option` style), since they're multiplying:

```go
func NewRoom(code string, opts ...RoomOption) *Room
func NewRoomFromSnapshot(code string, data []byte, opts ...RoomOption) (*Room, error)

func WithSnapshotter(s Snapshotter) RoomOption
func WithReaper(fn func()) RoomOption
func WithGrace(d time.Duration) RoomOption
```

`grace` defaults to `reconnectGrace` when no option is given.

## `hub` package (`hub.go`)

- `Create` injects the reaper: `game.WithReaper(func(){ h.reap(code) })`, plus
  `WithGrace(h.grace)` and the snapshotter when a store is set.
- **`reap(code string)`**: take the write lock, delete `code` from the map, unlock;
  then, if a store is configured, `store.DeleteSnapshot(code)` with a short-timeout
  context. (Delete from map first so live `Lookup`s stop resolving it.)
- **`StopAll()`**: lock, `r.Stop()` every room, clear the map — for shutdown.
- `Hub` gains a `grace time.Duration` field (default `reconnectGrace`), set via a
  `WithGrace` hub option if we later want an env knob.

## `store` package (`store.go`)

- Add `DeleteSnapshot(ctx, code) error` → Redis `DEL room:<code>`.
- Add it to the hub's `Store` interface. The `game.Snapshotter` interface stays
  `SaveSnapshot`-only; deletion is orchestrated by the hub, which owns the store.

## `realtime` package (`socket.go`)

- `join` now submits `CmdJoin` with both a `Subscribe` and an `Ack` channel, then
  waits on `Ack` (short timeout). On `""` it wires up the write-pump and per-socket
  state; on a non-empty message it `emitError`s and sets nothing up (the room never
  subscribed it, so there's nothing to tear down). This replaces today's order of
  "set up pump, then submit".
- The disconnect handler submits **`CmdDisconnect`** (carrying the player name and
  the subscription channel) instead of `CmdLeave` + `CmdUnsubscribe`, then closes
  the write-pump `done`.
- Unchanged on the wire: on `connect` the client emits `join`, and the room decides
  new-vs-reconnect-vs-duplicate. socket.io's auto-reconnect drives reconnection with
  no client change.

## `main.go`

- On `SIGINT`/`SIGTERM`, call `h.StopAll()` during graceful shutdown (after the
  HTTP server stops accepting, before Redis close).

## Frontend (`play.$code.tsx`)

- Read `host` from the store; compute `isHost = name === host` (name from
  `recallName()`, already wired). Render `start` (in `lobby`) and `nextPhase`
  (in `inRound`/`reveal`) when `isHost`, reusing the host page's control styling.
- Reconnect and error paths already work: socket.io re-emits `join` on reconnect,
  and `error` events already surface through `ErrorPanel`. No other change.

## Error handling

- Reap during an in-flight `Lookup` restore: see Risks #1 — benign and self-healing.
- A grace timer that fires after reap: `Submit` selects on the closed `done` and
  drops the command. No panic, no leak.
- `DeleteSnapshot` failure: logged, not fatal — the in-memory room is already gone;
  a stale snapshot will TTL out (`SNAPSHOT_TTL`, default 1h) as a backstop.

## Testing — TDD

Inject a tiny grace (`WithGrace(10*time.Millisecond)`) so timer paths run fast.

- **`game` (`room_test.go`)**:
  - disconnect keeps the player, then prune removes them after grace;
  - reconnect before grace cancels the prune (player stays, host preserved);
  - empty room reaps after the creation grace (never-joined) — assert `onReap` called;
  - last player pruned → `onReap` called;
  - host pruned with players remaining → `Host` promoted to `Players[0]`;
  - duplicate connected name → `Ack` receives the rejection message, `Players`
    unchanged, no new subscriber added;
  - join at `maxPlayers` → `Ack` rejection, unchanged;
  - join when `Phase == ended` → `Ack` rejection, unchanged;
  - accepted join → `Ack` receives `""` and the subscriber is registered.
- **`hub` (`hub_test.go`)**: a fake `Store` records deletes; reaping a room removes
  it from the map **and** calls `DeleteSnapshot`; `StopAll` stops every room.
- **`realtime`**: a disconnect submits `CmdDisconnect` (player kept until grace),
  and a same-name reconnect resolves to the same player (no duplicate).

## Risks

1. **Reap ↔ restore race.** Between `reap` removing the room from the map and
   deleting the snapshot, a concurrent `Lookup` could load the (zero-player)
   snapshot and rehydrate a room. It is **self-healing**: the rehydrated room has
   no players, arms the creation grace, and reaps again in one grace period.
   Documented and accepted rather than locked over a Redis round-trip.
2. **Grace tuning.** 60s trades faster cleanup against tolerance for slow
   reconnects. It's a single constant (`WithGrace`-overridable) so it's a one-line
   change if it proves wrong in practice.
3. **Promotion identity churn.** Because identity is the name, a player who leaves
   and rejoins lands at the end of `Players`; promotion to `Players[0]` therefore
   means "longest continuously present", which is the intended semantics.
