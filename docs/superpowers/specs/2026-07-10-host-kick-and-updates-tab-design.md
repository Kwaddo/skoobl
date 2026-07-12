# Host Kick + Updates Tab — Design

Date: 2026-07-10

Two independent features on the Skoobl (draw / guess-the-artist) game:

1. **Host kick** — the host can remove a player from the room while in the lobby.
2. **Updates tab** — a landing-page tab that lists versions and what changed.

The features share no code and can be built and shipped independently.

---

## Feature 1 — Host kicks a player

### Requirements

- The host can kick any player from the **lobby only** (not mid-game).
- A kicked player is dropped from the roster and sent back to the main menu with
  a clear message ("You were removed by the host").
- A kicked player **can rejoin** the same room immediately — no ban state.
- Other players in the room see the departure (reuses the existing "X left the
  room" roster-diff notice; a kick is not distinguished from a leave).
- Guards: only the host may kick; the target must be a real player and must not
  be the host; the room must be in the lobby phase.

### Backend

Package `backend/internal/game`, plus the socket bridge and protocol.

**`protocol/protocol.go`**
- Add command name `CmdKick MsgType = "kick"`.

**`game/room.go`**
- Add `CmdKick` to the `CmdKind` enum.
- Add a `Target string` field to `Command` (the player to kick). Documented as
  "kick: the player to remove".
- Add a transient `kicked string` field to `Room` (not serialized, not in
  `GameState`) — the name whose next broadcast frame is flagged `Kicked`.
- In `handle`, add `case CmdKick: r.kick(c)`.

**`game/members.go`** — new handler:

```go
// kick removes a player at the host's request from the lobby. It is the host's
// counterpart to leave: the victim is dropped immediately (no grace) and gets a
// final frame flagged Kicked so their client returns to the menu. Lobby-only —
// there is deliberately no mid-game kick, so none of removePlayer's in-game
// bounce/phase-completion paths are exercised here.
func (r *Room) kick(c Command) {
	if c.Player != r.state.Host || r.state.Phase != PhaseLobby {
		return
	}
	target := c.Target
	if target == r.state.Host || r.state.playerIndex(target) < 0 {
		return // never kick the host or a non-player
	}
	// Flag the victim's own frame Kicked, send it, then clear the flag so the
	// trailing normal broadcast carries nothing.
	r.kicked = target
	r.broadcast()
	r.kicked = ""
	// Drop the victim's subscription so the roster-removal broadcast (and any
	// future frame) skips them, then remove them from the room.
	r.unsubscribeByName(target)
	r.removePlayer(target)
}
```

**`game/broadcast.go`**
- In `broadcast`, set the per-recipient flag:
  ```go
  view := r.state.viewFor(s.name, r.present)
  if r.kicked != "" && s.name == r.kicked {
  	view.Kicked = true
  }
  ```
- Add `unsubscribeByName(name string)` — drops every subscriber whose `name`
  matches (mirrors `unsubscribe`, which drops by channel identity). Runs in the
  room goroutine, so `r.subs` stays race-free.

**`game/state.go`**
- Add `Kicked bool \`json:"kicked,omitempty"\`` to `GameState`, documented as the
  final frame the room sends to a player the host removed. `viewFor` does **not**
  copy it (it is set only in `broadcast` for the single victim).

**`realtime/socket.go`**
- Add `sock.On("kick", func(args ...any) { c.submit(game.Command{Kind: game.CmdKick, Target: stringField(args, "target")}) })`.
  `c.submit` already injects `Player` (the sender), so the handler's host check
  works. An empty/unknown target fails the `playerIndex` guard and is a no-op.

### Frontend

**`lib/protocol.ts`**
- Add `kicked?: boolean` to the server state type.

**`lib/store.ts`**
- Add `kicked: boolean` to the store (initial `false`); in `applyState`, set
  `kicked: s.kicked ?? false`. When `kicked` is true, suppress the "left the
  room" notices for that same frame (the victim is leaving anyway) — mirror the
  existing `if (!s.closed)` guard by also checking `!s.kicked`.

**`hooks/use-game-socket.ts`**
- Add a `kick: (name: string) => emit("kick", { target: name })` action.

**`components/game/GameStage.tsx`**
- Add an effect mirroring the existing `closed` handler: when `kicked` is true,
  set a flash message ("You were removed by the host.") and `navigate({ to: "/" })`.

**`components/game/display/PlayerList.tsx`**
- `PlayerGrid` gains an optional `onKick?: (name: string) => void` prop. When
  present, each tile whose `player.name !== host` renders a small ✕ button that
  calls `onKick(player.name)`. When absent (non-host viewers), no button renders.
- The lobby stage that renders `PlayerGrid` passes `onKick={actions.kick}` only
  when the current viewer is the host. (Wire from whichever lobby component owns
  the grid — `HostConfig`/`HostStage` for the display host, `PlayerStage` lobby
  for a playing host.)

### Testing

- `room_test.go` / `members` tests: host kicks a lobby player → target removed
  from `Players`, victim's frame carries `Kicked`, other subscribers get a frame
  without the target. Non-host kick attempt → no-op. Kick in a non-lobby phase →
  no-op. Kick the host or an unknown name → no-op. Kicked player can rejoin.

---

## Feature 2 — Updates tab on the landing page

### Requirements

- A landing-page tab listing released versions and their changes.
- Content is a **hand-written data file** the developer edits per release.
- A small "new" indicator on the tab when the latest version has not been seen
  on this device, cleared when the tab is opened.
- No new routes; additive to the existing landing page.

### Data

**`frontend/src/lib/changelog.ts`**

```ts
export type ChangeTag = "new" | "fix" | "improve";

export type Release = {
  version: string;   // e.g. "1.3.0"
  date: string;      // ISO "2026-06-23"
  title: string;     // short headline
  tag?: ChangeTag;   // dominant nature of the release
  changes: string[]; // user-facing bullets
};

// Newest first. Edit this on every release.
export const CHANGELOG: Release[] = [ /* seeded from release history */ ];

export const LATEST_VERSION = CHANGELOG[0]?.version ?? "";
```

Seed entries from the real release history (Frenzy mode, canvas/site
optimization, points system, results-screen polish, room lifecycle, local
drawing history, etc.), written in user-facing language.

### UI

**`frontend/src/routes/index.tsx`**
- Extend the `Tab` union with `"updates"` and add it to the `Segmented` control.
- Render `<UpdatesTab />` when the tab is active.
- On selecting the tab, persist `LATEST_VERSION` as the last-seen version and
  clear the "new" dot.

**`frontend/src/components/updates/UpdatesTab.tsx`** — new component
- Maps `CHANGELOG` to version cards: version + date header, optional tag sticker,
  bulleted `changes`. Styled to the existing arcade/sticker aesthetic
  (`card-arcade`, `sticker`, display/hand fonts).

**Last-seen tracking** (`lib/identity.ts` or a small `lib/updates.ts`)
- `recallSeenVersion()` / `rememberSeenVersion(v)` backed by `localStorage`.
- The "new" dot shows on the Updates tab when
  `recallSeenVersion() !== LATEST_VERSION`.

### Testing

- Light: `changelog.ts` exports are well-formed; `LATEST_VERSION` derives from
  the first entry. UI is presentational — no backend, no protocol change.

---

## Out of scope

- Mid-game kick and any ban/blocklist state (rejoin is allowed by design).
- Distinguishing "kicked" from "left" in other players' notices.
- Auto-generating the changelog from git or from `docs/CHANGELOG-*.md`.
- Any changelog route, modal, or backend-served version endpoint.
