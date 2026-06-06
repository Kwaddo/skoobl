# skoobl Modernization + Realtime Foundation — Design

**Date:** 2026-06-06
**Status:** Approved (not committed per user request)

## Goal

Upgrade skoobl (Jackbox-style multiplayer party game) to current bleeding-edge
stack, replace the race-prone in-memory WebSocket backend with a room-actor
architecture behind the Chi router, add Redis persistence, and prepare the
frontend (zustand + typed WS hook) plus a minimal game loop that proves the
protocol end-to-end.

## Decisions (locked)

- **Upgrade scope:** Bleeding edge.
- **Persistence:** Redis now (snapshot + pub/sub).
- **Work scope:** Foundation + basic game loop.
- **Backend framework:** Chi (multi-file `internal/` layout).
- **Graphify:** Skipped — codebase too small to benefit.

## Target versions (verified latest, 2026-06-06)

| Thing | Current | Target |
|---|---|---|
| **Frontend runtime** | **Next.js 15.1.6** | **Vite 8.0.16 + React SPA** (Next removed) |
| `@vitejs/plugin-react` | — | 6.0.2 (new) |
| react-router-dom | — | 7.17.0 (new) |
| React / react-dom | 19.0 | 19.2.7 |
| Tailwind | 3.4 | 4.3.0 (`@tailwindcss/vite` plugin, CSS-first config) |
| zustand | — | 5.0.14 (new) |
| vitest / @testing-library/react | — | 4.1.8 / 16.3.2 (new) |
| Go | 1.23.5 | 1.26.3 |
| HTTP router | gorilla/handlers | go-chi/chi v5.2.5 |
| WebSocket | gorilla/websocket | coder/websocket v1.8.14 |
| Redis client | — | go-redis v9.20.0 (new) |
| miniredis (test) | — | v2.38.0 (new) |

### Why Vite over Next.js
Party game = pure client-side realtime SPA against a separate Go backend.
Next.js's value (SSR, SEO, server components, API routes) is entirely unused
here, so it is removed. Vite + React keeps React 19, shadcn/ui, Radix, zustand,
and CVA near 1:1, gives a cleaner Tailwind 4 integration (`@tailwindcss/vite`),
and ships static files with no server runtime to deploy.

## Backend architecture — room-actor model

Replaces the racey `sync.Map` load-then-store juggling in `main.go:136-167`
and the HTTP-mutates / WS-listens split-brain at `main.go:67-101`.

### Layout
```
backend/
  cmd/server/main.go        # wire chi router + middleware, graceful shutdown
  internal/
    router/     # chi routes + middleware (CORS, recover, reqID, logger)
    httpapi/    # POST /games (create), GET /healthz
    ws/         # coder/websocket Client: read pump, write pump, keepalive
    protocol/   # tagged {type,payload} command + event types
    game/       # Room actor goroutine, GameState, phase state machine
    hub/        # room registry: create / lookup / delete
    store/      # Redis snapshot + pub/sub
  go.mod
```

### Principles
- **Each game = one goroutine (`Room`)** owning its `GameState`. All mutations
  arrive as `Command` values on the room's channel. No shared-memory races, no
  mutex juggling.
- **All client→server actions over WebSocket.** HTTP only for `POST /games`
  (create) and `GET /healthz`.
- **Typed protocol** both directions via tagged envelope
  `{ "type": string, "payload": <json> }`. Go types in `internal/protocol`,
  hand-mirrored in `frontend/lib/protocol.ts`.
- **Chi** = thin `net/http` router → `coder/websocket` upgrades with zero glue.
  Middleware chain replaces manual `gorilla/handlers` CORS.

### Client lifecycle (`ws` package)
- One `Client` per WS connection: `read pump` (parse envelope → `Command` to
  room), `write pump` (drain per-client send channel → `conn.Write`).
- Keepalive via ping/pong; context cancellation on disconnect.
- On disconnect: read pump sends a `leave` Command to the room; room removes the
  player and broadcasts new state.

### Hub (`hub` package)
- Owns the room registry. `Create() (code, *Room)`, `Lookup(code) (*Room, bool)`,
  `Delete(code)`. Registry access serialized (hub goroutine or `sync.Map` for
  lookup-only — lookups are read-mostly, never the racey read-modify-write).

### Store (`store` package)
- **Snapshot:** per-room state to Redis (key `room:<code>`, TTL) → survives
  restart + enables player reconnect.
- **Pub/sub:** per-room channel → multiple server instances share state
  (horizontal scale). v1 runs single instance; Redis still buys reconnect +
  restart durability.
- Tests use `miniredis` (no real Redis needed in CI).

## Basic game loop

Minimal phase state machine, generic enough to extend into real gameplay:

```
Lobby → InRound → Reveal → Ended
```

- **Commands:** `join, leave, start, submitAnswer, nextPhase`.
- **Events:** `state, error, gameEnded`.
- Phase transitions are host-gated (`start`, `nextPhase` only from host).
- `submitAnswer` valid only in `InRound`; collects per-player answers, revealed
  in `Reveal`.

## Frontend — Vite + React SPA

### Migration from Next.js
- New `frontend/` scaffold: Vite + React + TypeScript. Remove Next.js,
  `next.config.ts`, `app/` dir, eslint-config-next.
- `index.html` + `src/main.tsx` entry; `src/App.tsx` with react-router.
- Routes: `/` (home — create/join), `/host/:code` (host screen),
  `/play/:code` (player controller).
- Port existing components (`join-game`, `create-game`, shadcn `ui/*`) into
  `src/components/` — they are already client components, near 1:1.

### Tailwind 4 (cleaner on Vite)
- `@tailwindcss/vite` plugin in `vite.config.ts` (no PostCSS dance).
- `src/index.css`: `@import "tailwindcss";` + `@theme { ... }` tokens.
- Swap `tailwindcss-animate` → `tw-animate-css`.
- Adjust shadcn/ui components for v4 token model. CVA + clsx + tailwind-merge stay.

### State + transport
- **zustand store** (`src/lib/store.ts`): `{ code, phase, players, self, error }`
  plus actions to apply incoming events.
- **`useGameSocket` hook** (`src/hooks/use-game-socket.ts`): thin typed WS client.
  - `connect(code, player)`, `send(command)`.
  - Dispatches incoming events into the zustand store.
  - Reconnect with exponential backoff; full state resync on reconnect.
- **`src/lib/protocol.ts`:** TS types mirroring Go `internal/protocol`.

### Testing
- **vitest** + `@testing-library/react`. zustand store event-application tests;
  `useGameSocket` tests with a mock WS.

### Data flow
```
UI action → hook.send(cmd) → WS → server read pump → Room channel
  → mutate state → broadcast event → all clients → hook onmessage
  → zustand → React re-render
```

## Error handling

- **Server:** invalid command → `error` event to that client only. Room panic
  recovered; room torn down cleanly and removed from hub.
- **WS:** ping/pong keepalive, context cancel, proper close codes.
- **Client:** reconnect with backoff, resync full state on reconnect.

## Testing — TDD throughout

- **Go**
  - `game`: room state-transition tests (each command → expected state/phase).
  - `hub`: create/lookup/delete, concurrency.
  - `protocol`: marshal/unmarshal envelope round-trips.
  - `ws`: integration test with real coder/websocket loopback.
  - `store`: snapshot + pub/sub against `miniredis`.
- **Frontend**
  - zustand store: event-application tests.
  - `useGameSocket`: with a mock WS (connect, send, dispatch, reconnect).

## Out of scope (YAGNI)

- Real scoring / multiple game modes / full gameplay content.
- Auth / accounts.
- Multi-instance deployment (Redis pub/sub is wired but v1 runs single instance).
- Graphify knowledge graph.

## Risks

1. **Tailwind 4 + shadcn migration** — most fiddly; accepted under bleeding-edge.
2. **Redis runtime dependency** — needs local Redis (Docker/brew) for dev.
