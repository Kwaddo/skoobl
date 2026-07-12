# Host Kick + Updates Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the host remove a player from the lobby, and add a landing-page "Updates" tab that lists released versions and their changes.

**Architecture:** Two independent features. The kick is a new authoritative `Room` command (`CmdKick`) plus a per-recipient `Kicked` broadcast flag that bounces the victim to the menu; the frontend adds a host-only ✕ on lobby tiles and a kicked-effect in `GameStage`. The Updates tab is a purely additive, frontend-only feature backed by a hand-written `changelog.ts` data file and a localStorage "last-seen version" for the "new" dot.

**Tech Stack:** Go (backend `game`/`realtime`/`protocol` packages, `go test`), React + TypeScript + TanStack Router (frontend), Vitest + @testing-library/react, Biome.

## Global Constraints

- Kick is **lobby-only**: guarded by `Phase == PhaseLobby`. There is no mid-game kick.
- Kick is **rejoinable**: no ban/blocklist state. A kicked player may re-enter immediately.
- Only the **host** may kick; the target must be an existing player and must not be the host.
- The room goroutine owns `r.subs`, `r.state`, and `r.kicked`; all mutations happen inside `handle`/handler funcs called from the goroutine — never touch them from elsewhere.
- Changelog content is **hand-written** in `frontend/src/lib/changelog.ts`, newest entry first. No git/docs auto-generation, no backend endpoint, no new route.
- Backend tests: `cd backend && go test ./...`. Frontend checks: `cd frontend && npm run test`, `npm run typecheck`, `npm run lint`.
- Do not run `git commit`/`git push` — the repo owner does all commits. The "Commit" steps below list the exact command to hand off; do not execute them.

---

## Task 1: Backend — host kick command

**Files:**
- Modify: `backend/internal/protocol/protocol.go` (add `CmdKick` message name)
- Modify: `backend/internal/game/room.go` (add `CmdKick` kind, `Command.Target`, `Room.kicked`, dispatch)
- Modify: `backend/internal/game/state.go` (add `Kicked` field to `GameState`)
- Modify: `backend/internal/game/broadcast.go` (per-recipient `Kicked` flag, `unsubscribeByName`)
- Modify: `backend/internal/game/members.go` (new `kick` handler)
- Modify: `backend/internal/realtime/socket.go` (wire the `"kick"` socket event)
- Test: `backend/internal/game/room_test.go` (new `TestHostKicksPlayer`)

**Interfaces:**
- Consumes: existing `Room.removePlayer(name string)`, `GameState.playerIndex(name string) int`, `Room.broadcast()`, `Room.unsubscribe(ch chan GameState)`, test helpers `joinSpec`, `joinOK`, `nextState`, `poke`, `drain`.
- Produces:
  - `game.CmdKick` (a `CmdKind`)
  - `game.Command.Target string`
  - `game.GameState.Kicked bool` (JSON key `kicked`, `omitempty`)
  - socket event `"kick"` reading a `{ "target": string }` payload

- [ ] **Step 1: Write the failing test**

Add to `backend/internal/game/room_test.go`:

```go
func TestHostKicksPlayer(t *testing.T) {
	r := NewRoom("kick01")
	go r.Run()
	defer r.Stop()

	hostSub := make(chan GameState, 32)
	joinSpec(t, r, "tv", hostSub)
	nextState(t, hostSub)

	aliceSub := make(chan GameState, 32)
	joinOK(t, r, "alice", aliceSub)
	bobSub := make(chan GameState, 32)
	joinOK(t, r, "bob", bobSub)
	drain(aliceSub)
	drain(bobSub)
	drain(hostSub)

	// A non-host cannot kick.
	r.Submit(Command{Kind: CmdKick, Player: "alice", Target: "bob"})
	if s := poke(t, r, hostSub); len(s.Players) != 2 {
		t.Fatalf("players = %d after non-host kick, want 2", len(s.Players))
	}

	// The host kicks bob.
	drain(bobSub)
	drain(hostSub)
	r.Submit(Command{Kind: CmdKick, Player: "tv", Target: "bob"})

	// bob's own next frame is flagged Kicked.
	if s := nextState(t, bobSub); !s.Kicked {
		t.Fatal("bob's frame not flagged Kicked")
	}

	// The host sees bob gone and no Kicked flag on its own frame.
	got := poke(t, r, hostSub)
	if s := got; s.Kicked {
		t.Fatal("host frame should not be flagged Kicked")
	}
	names := map[string]bool{}
	for _, p := range got.Players {
		names[p.Name] = true
	}
	if names["bob"] || !names["alice"] {
		t.Fatalf("roster = %v, want alice only", names)
	}

	// Kicking the host or an unknown player is a no-op.
	r.Submit(Command{Kind: CmdKick, Player: "tv", Target: "tv"})
	r.Submit(Command{Kind: CmdKick, Player: "tv", Target: "ghost"})
	if s := poke(t, r, hostSub); len(s.Players) != 1 {
		t.Fatalf("players = %d after no-op kicks, want 1", len(s.Players))
	}

	// bob can rejoin (no ban).
	rejoin := make(chan GameState, 32)
	joinOK(t, r, "bob", rejoin)
	if s := poke(t, r, hostSub); len(s.Players) != 2 {
		t.Fatalf("players = %d after rejoin, want 2", len(s.Players))
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/game/ -run TestHostKicksPlayer -v`
Expected: FAIL — `Command` has no field `Target`, `GameState` has no field `Kicked`, `CmdKick` undefined (compile error).

- [ ] **Step 3: Add the protocol command name**

In `backend/internal/protocol/protocol.go`, add to the command block:

```go
const (
	CmdJoin          MsgType = "join"
	CmdConfigure     MsgType = "configure"
	CmdStart         MsgType = "start"
	CmdSubmitDrawing MsgType = "submitDrawing"
	CmdSubmitGuess   MsgType = "submitGuess"
	CmdNextPhase     MsgType = "nextPhase"
	CmdLeave         MsgType = "leave"
	CmdKick          MsgType = "kick"
)
```

- [ ] **Step 4: Add the command kind and Target field**

In `backend/internal/game/room.go`, add `CmdKick` to the `CmdKind` enum (after `CmdLeave`):

```go
	CmdLeave           // player: leave the room now (immediate removal, no grace)
	CmdKick            // host: remove a player from the lobby (immediate, no ban)
```

And add the `Target` field to the `Command` struct (next to `Player`):

```go
	Player    string
	Target    string         // kick: the player to remove
```

- [ ] **Step 5: Add the Kicked field to GameState**

In `backend/internal/game/state.go`, add after the `Closed` field:

```go
	// Closed is the final frame the room sends when the host leaves: the room is
	// gone and clients should kick everyone back to the main menu.
	Closed bool `json:"closed,omitempty"`
	// Kicked is set only on the single frame the room sends to a player the host
	// removed, so that one client returns to the menu. It is per-recipient (set
	// in broadcast, never copied by viewFor) and never persisted.
	Kicked bool `json:"kicked,omitempty"`
```

- [ ] **Step 6: Add the per-recipient flag and unsubscribeByName**

In `backend/internal/game/broadcast.go`, set the flag in `broadcast`:

```go
// broadcast hands each subscriber its own redacted view of the state.
func (r *Room) broadcast() {
	for _, s := range r.subs {
		view := r.state.viewFor(s.name, r.present)
		if r.kicked != "" && s.name == r.kicked {
			view.Kicked = true
		}
		select {
		case s.ch <- view:
		default: // drop for a slow/closed subscriber rather than block the room
		}
	}
}
```

And add, next to `unsubscribe`:

```go
// unsubscribeByName drops every subscriber registered under name (mirrors
// unsubscribe, which drops by channel identity). Runs in the room goroutine, so
// r.subs is touched by nothing else and stays race-free.
func (r *Room) unsubscribeByName(name string) {
	kept := r.subs[:0]
	for _, s := range r.subs {
		if s.name != name {
			kept = append(kept, s)
		}
	}
	r.subs = kept
}
```

- [ ] **Step 7: Add the transient kicked field to Room**

In `backend/internal/game/room.go`, add to the `Room` struct near `subs`:

```go
	subs     []subscriber
	kicked   string // transient: the name whose next broadcast frame is flagged Kicked
```

- [ ] **Step 8: Add the kick handler**

In `backend/internal/game/members.go`, add:

```go
// kick removes a player at the host's request from the lobby. It is the host's
// counterpart to leave: the victim is dropped immediately (no grace) and gets a
// final frame flagged Kicked so their client returns to the menu. Lobby-only by
// design, so none of removePlayer's in-game bounce/phase-completion paths run
// here. No ban is recorded — a kicked player may rejoin.
func (r *Room) kick(c Command) {
	if c.Player != r.state.Host || r.state.Phase != PhaseLobby {
		return
	}
	target := c.Target
	if target == r.state.Host || r.state.playerIndex(target) < 0 {
		return // never kick the host or a non-player
	}
	// Flag the victim's own frame Kicked, send it, then clear the flag so the
	// trailing roster-removal broadcast carries nothing.
	r.kicked = target
	r.broadcast()
	r.kicked = ""
	// Drop the victim's subscription so the removal broadcast (and any later
	// frame) skips them, then remove them from presence and the roster.
	r.unsubscribeByName(target)
	r.removePlayer(target)
}
```

- [ ] **Step 9: Dispatch the command**

In `backend/internal/game/room.go`, add a case in `handle` (after `CmdLeave`):

```go
	case CmdLeave:
		r.leave(c)
	case CmdKick:
		r.kick(c)
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `cd backend && go test ./internal/game/ -run TestHostKicksPlayer -v`
Expected: PASS.

- [ ] **Step 11: Wire the socket event**

In `backend/internal/realtime/socket.go`, in `bind`, add after the `leave` handler:

```go
	sock.On("leave", func(...any) { c.leaveRoom() })
	sock.On("kick", func(args ...any) {
		c.submit(game.Command{Kind: game.CmdKick, Target: stringField(args, "target")})
	})
```

(`c.submit` injects the sender as `Player`, so the handler's host check applies. An empty/unknown `target` fails the `playerIndex` guard and is a no-op.)

- [ ] **Step 12: Verify the whole backend builds and passes**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: PASS, no vet warnings.

- [ ] **Step 13: Commit (hand off — do not run)**

```bash
git add backend/internal/protocol/protocol.go backend/internal/game/room.go backend/internal/game/state.go backend/internal/game/broadcast.go backend/internal/game/members.go backend/internal/realtime/socket.go backend/internal/game/room_test.go
git commit -m "feat(game): host can kick a player from the lobby"
```

---

## Task 2: Frontend — carry the kicked flag in state

**Files:**
- Modify: `frontend/src/lib/protocol.ts` (add `kicked?` to the server state type)
- Modify: `frontend/src/lib/store.ts` (store `kicked`, suppress "left" notices on the kicked frame)
- Test: `frontend/src/lib/store.test.ts` (new)

**Interfaces:**
- Consumes: `game.GameState.Kicked` (JSON `kicked`) from Task 1; existing `useGameStore`, `applyState`.
- Produces: `useGameStore(s => s.kicked): boolean`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useGameStore } from "./store";
import type { ServerState } from "./protocol";

const base = (over: Partial<ServerState>): ServerState =>
  ({ code: "abc", phase: "lobby", host: "tv", players: [], ...over }) as ServerState;

describe("store kicked handling", () => {
  beforeEach(() => {
    useGameStore.setState({ players: [], notices: [], kicked: false });
  });

  it("exposes the kicked flag from a broadcast", () => {
    useGameStore.getState().applyState(base({ kicked: true }));
    expect(useGameStore.getState().kicked).toBe(true);
  });

  it("defaults kicked to false when absent", () => {
    useGameStore.getState().applyState(base({}));
    expect(useGameStore.getState().kicked).toBe(false);
  });

  it("suppresses the 'left' notice on the frame that kicks this client", () => {
    useGameStore.setState({
      players: [{ name: "alice" }, { name: "bob" }],
    });
    // This client is bob being kicked: the roster loses bob and kicked is set.
    useGameStore.getState().applyState(base({ players: [{ name: "alice" }], kicked: true }));
    const texts = useGameStore.getState().notices.map((n) => n.text);
    expect(texts.some((t) => t.includes("left the room"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm run test -- store.test`
Expected: FAIL — `ServerState` has no `kicked`, and `kicked` is not in the store, so the first assertion fails (or a type error surfaces).

- [ ] **Step 3: Add `kicked` to the server state type**

In `frontend/src/lib/protocol.ts`, find the server state type (the one with `closed?: boolean`) and add:

```ts
  closed?: boolean;
  kicked?: boolean;
```

(If the type is named other than `ServerState`, use that name in the test import from Step 1.)

- [ ] **Step 4: Store the flag and guard the notice**

In `frontend/src/lib/store.ts`:

Add to the store state type (near `closed: boolean;`):

```ts
  closed: boolean;
  kicked: boolean;
```

Add to `initial` (near `closed: false,`):

```ts
  closed: false,
  kicked: false,
```

In `applyState`, change the notice guard so a kicked frame suppresses the "left" toast (the victim is leaving anyway):

```ts
      if (!s.closed && !s.kicked) {
```

And add to the returned object (near `closed: s.closed ?? false,`):

```ts
        closed: s.closed ?? false,
        kicked: s.kicked ?? false,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npm run test -- store.test`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit (hand off — do not run)**

```bash
git add frontend/src/lib/protocol.ts frontend/src/lib/store.ts frontend/src/lib/store.test.ts
git commit -m "feat(store): carry the kicked flag from the server"
```

---

## Task 3: Frontend — kick action, effect, and lobby ✕ button

**Files:**
- Modify: `frontend/src/hooks/use-game-socket.ts` (add `kick` action)
- Modify: `frontend/src/components/game/GameStage.tsx` (bounce a kicked client home)
- Modify: `frontend/src/components/game/display/PlayerList.tsx` (`onKick` prop + ✕ button)
- Modify: `frontend/src/components/game/stages/HostStage.tsx` (pass `onKick`)
- Modify: `frontend/src/components/game/stages/PlayingHostStage.tsx` (pass `onKick`)
- Test: `frontend/src/components/game/display/PlayerList.test.tsx` (new)

**Interfaces:**
- Consumes: `useGameStore(s => s.kicked)` from Task 2; existing `GameActions`, `setFlash`, `PlayerGrid`.
- Produces: `actions.kick(name: string): void`; `PlayerGrid`'s optional `onKick?: (name: string) => void` prop.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/game/display/PlayerList.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGameStore } from "@/lib/store";
import { PlayerGrid } from "./PlayerList";

describe("PlayerGrid kick button", () => {
  const players = [{ name: "tv" }, { name: "alice" }];

  it("shows a kick button for non-host players when onKick is given", () => {
    useGameStore.setState({ host: "tv" });
    const onKick = vi.fn();
    const { getByRole } = render(<PlayerGrid players={players} onKick={onKick} />);
    const btn = getByRole("button", { name: /remove alice/i });
    btn.click();
    expect(onKick).toHaveBeenCalledWith("alice");
  });

  it("renders no kick buttons without onKick", () => {
    useGameStore.setState({ host: "tv" });
    const { queryAllByRole } = render(<PlayerGrid players={players} />);
    expect(queryAllByRole("button")).toHaveLength(0);
  });

  it("never offers a kick button for the host", () => {
    useGameStore.setState({ host: "tv" });
    const { queryByRole } = render(<PlayerGrid players={players} onKick={vi.fn()} />);
    expect(queryByRole("button", { name: /remove tv/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm run test -- PlayerList.test`
Expected: FAIL — `PlayerGrid` does not accept `onKick` and renders no buttons.

- [ ] **Step 3: Add the kick action**

In `frontend/src/hooks/use-game-socket.ts`, add next to `leave`:

```ts
    leave: useCallback(() => emit("leave"), [emit]),
    kick: useCallback((name: string) => emit("kick", { target: name }), [emit]),
```

- [ ] **Step 4: Add the ✕ button to PlayerGrid**

In `frontend/src/components/game/display/PlayerList.tsx`, thread an optional `onKick` through `PlayerGrid` into `GridItem`.

Update `GridItem`'s props and render (add the button; keep the existing avatar/name markup):

```tsx
const GridItem = memo(
  function GridItem({
    player,
    host,
    index,
    onKick,
  }: {
    player: Player;
    host: string;
    index: number;
    onKick?: (name: string) => void;
  }) {
    const kickable = !!onKick && player.name !== host;
    return (
      <li
        className="card-arcade card-hover pop flex items-center gap-3 p-3"
        style={{ "--d": `${index * 40}ms` } as React.CSSProperties}
      >
        <Avatar
          name={player.name}
          className="h-10 w-10 -rotate-3 rounded-xl border-2 border-foreground"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span dir="auto" className="truncate font-bold">
            {player.name}
          </span>
          {player.name === host && (
            <span
              className="sticker w-fit px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-foreground"
              style={{ "--rot": "-3deg" } as React.CSSProperties}
            >
              <Crown className="h-3 w-3" /> leader
            </span>
          )}
        </span>
        {kickable && (
          <button
            type="button"
            aria-label={`Remove ${player.name}`}
            title={`Remove ${player.name}`}
            onClick={() => onKick?.(player.name)}
            className="shrink-0 rounded-lg border-2 border-foreground px-2 py-1 font-display text-sm font-black leading-none text-foreground transition hover:bg-foreground hover:text-background"
          >
            ✕
          </button>
        )}
      </li>
    );
  },
  (prev, next) =>
    prev.player.name === next.player.name &&
    prev.host === next.host &&
    prev.index === next.index &&
    prev.onKick === next.onKick,
);
```

Update `PlayerGrid` to accept and forward `onKick`:

```tsx
export function PlayerGrid({
  players,
  onKick,
}: {
  players: Player[];
  onKick?: (name: string) => void;
}) {
  const host = useGameStore((s) => s.host);
  if (players.length === 0) {
    return (
      <div className="card-arcade flex flex-col items-center gap-2 border-dashed px-6 py-10 text-center">
        <Eyes className="float h-10 w-10 text-foreground" />
        <p className="font-display text-lg font-bold">Nobody here yet</p>
        <p className="font-hand text-xl text-muted">
          share the code above to fill the room.
        </p>
      </div>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-3 p-1.5 sm:grid-cols-3">
      {players.map((p, i) => (
        <GridItem key={p.name} player={p} host={host} index={i} onKick={onKick} />
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Run the PlayerList test to verify it passes**

Run: `cd frontend && npm run test -- PlayerList.test`
Expected: PASS.

- [ ] **Step 6: Bounce a kicked client home**

In `frontend/src/components/game/GameStage.tsx`, read the flag near the other store reads:

```tsx
  const closed = useGameStore((s) => s.closed);
  const kicked = useGameStore((s) => s.kicked);
```

Add an effect after the existing `closed` effect:

```tsx
  // The host removed this player from the lobby: return to the menu with a
  // one-shot message in the home banner. (The player may rejoin freely.)
  useEffect(() => {
    if (!kicked) return;
    setFlash({ message: "The host removed you from the room.", tab: "join" });
    navigate({ to: "/" });
  }, [kicked, navigate]);
```

- [ ] **Step 7: Wire onKick from the host lobby stages**

In `frontend/src/components/game/stages/HostStage.tsx`, at the `PlayerGrid` render (the lobby), pass the action:

```tsx
          <PlayerGrid players={players} onKick={actions.kick} />
```

In `frontend/src/components/game/stages/PlayingHostStage.tsx`, at the lobby `PlayerGrid` render (inside `PlayingHostLobby`, where `actions` is in scope), pass:

```tsx
          <PlayerGrid players={players} onKick={actions.kick} />
```

(Do **not** add `onKick` in `PlayerStage.tsx` — that view is only for non-host players.)

- [ ] **Step 8: Verify typecheck, lint, tests, build**

Run: `cd frontend && npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all pass.

- [ ] **Step 9: Commit (hand off — do not run)**

```bash
git add frontend/src/hooks/use-game-socket.ts frontend/src/components/game/GameStage.tsx frontend/src/components/game/display/PlayerList.tsx frontend/src/components/game/display/PlayerList.test.tsx frontend/src/components/game/stages/HostStage.tsx frontend/src/components/game/stages/PlayingHostStage.tsx
git commit -m "feat(lobby): host-only kick button and kicked-client redirect"
```

---

## Task 4: Updates — changelog data + last-seen tracking

**Files:**
- Create: `frontend/src/lib/changelog.ts`
- Create: `frontend/src/lib/updates.ts`
- Test: `frontend/src/lib/changelog.test.ts` (new)

**Interfaces:**
- Produces:
  - `changelog.ts`: `type ChangeTag`, `type Release`, `CHANGELOG: Release[]`, `LATEST_VERSION: string`
  - `updates.ts`: `recallSeenVersion(): string`, `rememberSeenVersion(v: string): void`, `hasUnseenUpdate(): boolean`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/changelog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CHANGELOG, LATEST_VERSION } from "./changelog";

describe("changelog", () => {
  it("is non-empty and newest-first by date", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    const dates = CHANGELOG.map((r) => r.date);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
  });

  it("gives every release a version, title, and at least one change", () => {
    for (const r of CHANGELOG) {
      expect(r.version).toBeTruthy();
      expect(r.title).toBeTruthy();
      expect(r.changes.length).toBeGreaterThan(0);
    }
  });

  it("derives LATEST_VERSION from the first entry", () => {
    expect(LATEST_VERSION).toBe(CHANGELOG[0].version);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm run test -- changelog.test`
Expected: FAIL — `./changelog` module not found.

- [ ] **Step 3: Create the changelog data file**

Create `frontend/src/lib/changelog.ts`:

```ts
// The user-facing release log shown on the home "Updates" tab. Newest entry
// first. Edit this by hand on every release: bump the version, set today's date,
// and write the changes in plain player-facing language. `tag` is the dominant
// nature of the release (a small coloured sticker in the UI).
export type ChangeTag = "new" | "improve" | "fix";

export type Release = {
  version: string; // e.g. "1.6.0"
  date: string; // ISO date, "2026-06-23"
  title: string; // short headline
  tag?: ChangeTag; // dominant nature of the release
  changes: string[]; // user-facing bullet points
};

export const CHANGELOG: Release[] = [
  {
    version: "1.6.0",
    date: "2026-06-23",
    title: "Frenzy mode",
    tag: "new",
    changes: [
      "New chaotic Frenzy game mode: timed waves throw effects at everyone at once.",
      "Waves are tiered, shared across the room, and scale with the round timer.",
    ],
  },
  {
    version: "1.5.0",
    date: "2026-06-22",
    title: "Smoother canvas & polished results",
    tag: "improve",
    changes: [
      "Drawing canvas is faster and lighter, with client-first strokes for instant feedback.",
      "Refreshed end-of-game results screen.",
      "New “Whose Doodle?” flipped guessing mode.",
      "Drawing toolbar moves to the side on short screens.",
    ],
  },
  {
    version: "1.4.0",
    date: "2026-06-21",
    title: "Your drawing history",
    tag: "new",
    changes: [
      "Every doodle you make is saved locally and browsable from the new History tab.",
    ],
  },
  {
    version: "1.3.0",
    date: "2026-06-20",
    title: "Points & saved artwork",
    tag: "new",
    changes: [
      "New points system rewards fast, correct guesses.",
      "Round drawings are kept as shareable artifacts.",
    ],
  },
  {
    version: "1.2.0",
    date: "2026-06-19",
    title: "Big-screen party mode",
    tag: "new",
    changes: [
      "Host on a shared screen while everyone plays from their phones.",
    ],
  },
  {
    version: "1.1.0",
    date: "2026-06-07",
    title: "Rooms that survive a wobble",
    tag: "improve",
    changes: [
      "Reconnect after a brief drop without losing your seat.",
      "If the host leaves, another player takes over instead of the game ending.",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-06-06",
    title: "Skoobl launch",
    tag: "new",
    changes: ["Draw the word, then guess who drew the one on screen."],
  },
];

export const LATEST_VERSION = CHANGELOG[0]?.version ?? "";
```

- [ ] **Step 4: Create the last-seen helpers**

Create `frontend/src/lib/updates.ts`:

```ts
import { LATEST_VERSION } from "./changelog";

// Tracks the newest release version this device has seen, so the Updates tab can
// show a "new" dot until it's opened. Best-effort: storage may be unavailable
// (private mode), in which case the dot simply always shows / never persists.
const KEY = "skoobl:seen-version";

export function recallSeenVersion(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberSeenVersion(v: string): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // ignore — no persistence available
  }
}

export function hasUnseenUpdate(): boolean {
  return !!LATEST_VERSION && recallSeenVersion() !== LATEST_VERSION;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npm run test -- changelog.test`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit (hand off — do not run)**

```bash
git add frontend/src/lib/changelog.ts frontend/src/lib/updates.ts frontend/src/lib/changelog.test.ts
git commit -m "feat(updates): changelog data and last-seen-version helpers"
```

---

## Task 5: Updates — tab UI on the landing page

**Files:**
- Create: `frontend/src/components/updates/UpdatesTab.tsx`
- Modify: `frontend/src/routes/index.tsx` (add the `updates` tab, options, render, new dot, hide CTA)

**Interfaces:**
- Consumes: `CHANGELOG`, `LATEST_VERSION` (Task 4), `rememberSeenVersion`, `hasUnseenUpdate` (Task 4); existing `Segmented`, `Tab` union.
- Produces: `UpdatesTab` component; a `"updates"` member of the landing `Tab` union.

- [ ] **Step 1: Create the UpdatesTab component**

Create `frontend/src/components/updates/UpdatesTab.tsx`:

```tsx
import { type ChangeTag, CHANGELOG } from "@/lib/changelog";

const TAG_LABEL: Record<ChangeTag, string> = {
  new: "new",
  improve: "improved",
  fix: "fixed",
};

// UpdatesTab lists every release newest-first as an inked card: version + date
// header, an optional tag sticker, then the plain-language changes.
export function UpdatesTab() {
  return (
    <div className="flex max-h-72 flex-col gap-4 overflow-y-auto pr-1">
      {CHANGELOG.map((r) => (
        <article
          key={r.version}
          className="card-arcade flex flex-col gap-2 p-4 text-left"
        >
          <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-display text-lg font-black text-foreground">
              {r.title}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
              v{r.version} · {r.date}
            </span>
            {r.tag && (
              <span
                className="sticker ml-auto w-fit px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-foreground"
                style={{ "--rot": "-3deg" } as React.CSSProperties}
              >
                {TAG_LABEL[r.tag]}
              </span>
            )}
          </header>
          <ul className="flex list-disc flex-col gap-1 pl-5 font-hand text-lg leading-snug text-muted">
            {r.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Add the tab to the landing page**

In `frontend/src/routes/index.tsx`:

Add the imports:

```ts
import { UpdatesTab } from "@/components/updates/UpdatesTab";
import { LATEST_VERSION } from "@/lib/changelog";
import { hasUnseenUpdate, rememberSeenVersion } from "@/lib/updates";
```

Extend the `Tab` union:

```ts
type Tab = "join" | "host" | "history" | "updates";
```

Add unseen-update state near the other `useState` calls in `Home`:

```ts
  const [unseen, setUnseen] = useState(hasUnseenUpdate);
```

In `switchTab`, mark updates seen when the tab opens:

```ts
  const switchTab = (next: Tab) => {
    setTab(next);
    setError(null);
    if (next === "updates") {
      rememberSeenVersion(LATEST_VERSION);
      setUnseen(false);
    }
  };
```

Add `updates` to both `Segmented` option arrays (mobile and desktop). Use a dot on the label when unseen — mobile:

```tsx
                    { value: "history" as const, label: "History" },
                    { value: "updates" as const, label: unseen ? "News •" : "News" },
```

desktop:

```tsx
                    { value: "history" as const, label: "History" },
                    { value: "updates" as const, label: unseen ? "What's new •" : "What's new" },
```

Render the tab body — extend the existing ternary chain so `updates` shows `UpdatesTab` (place it before the `join` branch):

```tsx
            {tab === "history" ? (
              <HistoryTab />
            ) : tab === "updates" ? (
              <UpdatesTab />
            ) : tab === "join" ? (
```

Hide the Join/Host CTA on the updates tab (it has no action) — change the guard:

```tsx
          {tab !== "history" && tab !== "updates" && (
```

- [ ] **Step 3: Typecheck, lint, test, build**

Run: `cd frontend && npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all pass.

- [ ] **Step 4: Manually verify in the browser**

Run: `cd frontend && npm run dev`, open the app, and confirm:
- A "What's new •" tab appears with a dot on first load.
- Clicking it lists the releases newest-first; the dot disappears.
- Reloading keeps the dot cleared (last-seen persisted).
- No Join/Host button shows on the updates tab.

- [ ] **Step 5: Commit (hand off — do not run)**

```bash
git add frontend/src/components/updates/UpdatesTab.tsx frontend/src/routes/index.tsx
git commit -m "feat(updates): add What's new tab to the landing page"
```

---

## Self-Review

**Spec coverage:**
- Host kick, lobby-only, host-authorized, target-is-a-player → Task 1 (`kick` guards) ✓
- Kicked player bounced to menu with message → Task 1 (`Kicked` flag) + Task 2 (store) + Task 3 (GameStage effect) ✓
- Rejoinable, no ban → Task 1 (no ban state; test asserts rejoin) ✓
- Others see the departure → reuses existing roster-diff "left" notice; Task 2 suppresses it only on the victim's own frame ✓
- Host-only ✕ in the lobby roster → Task 3 (`onKick` wired only from host stages) ✓
- Updates tab, hand-written data → Task 4 (`changelog.ts`) ✓
- Landing tab, no route → Task 5 (`Tab` union + `Segmented`) ✓
- "New" indicator cleared on open → Task 4 (`updates.ts`) + Task 5 (dot + `switchTab`) ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. Seed changelog is concrete. ✓

**Type consistency:** `CmdKick`, `Command.Target`, `GameState.Kicked` (Task 1) are consumed by the socket event and by `protocol.ts`/`store.ts` (Task 2). `actions.kick(name)` (Task 3) matches the `"kick"` `{ target }` payload the socket handler reads (Task 1, Step 11). `PlayerGrid`'s `onKick?: (name: string) => void` is defined in Task 3 and used by both host stages. `CHANGELOG`/`LATEST_VERSION`/`hasUnseenUpdate`/`rememberSeenVersion` (Task 4) match their imports in Task 5. ✓
