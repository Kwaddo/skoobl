# skoobl Deploy Infra + Redis Wiring + Origin Hardening — Design

**Date:** 2026-06-06
**Status:** Proposed

## Goal

Make skoobl deployable to a single Dilmune Cloud VPS, and close two gaps left by
the modernization spec:

1. **Deployment infrastructure** — Docker Compose for the Go backend + Redis, an
   nginx server block for Dilmune's edge nginx, and a deploy runbook.
2. **Redis wiring** — `main.go` currently runs `hub.New()` in-memory; the
   `store.RedisStore` exists but nothing calls it. Wire snapshot persistence +
   restore-on-miss so rooms survive a backend restart and clients can reconnect.
3. **Origin hardening** — replace `Access-Control-Allow-Origin: *` and the
   WebSocket `InsecureSkipVerify: true` with env-driven, same-origin-by-default
   behavior.

## Non-goals (YAGNI)

- Redis **pub/sub** / multi-instance fan-out. The `Publish`/`Subscribe` methods
  stay present but unused; v1 is a single backend instance. (Matches the
  modernization spec's "multi-instance out of scope".)
- Kubernetes / autoscaling / multi-node. One VPS, one backend container.
- TLS in the app. Dilmune's edge nginx terminates TLS.
- Auth, accounts, real gameplay content.

## Confirmed environment (locked with user)

- **One VPS** inside Dilmune Cloud.
- **Dilmune nginx = edge:** terminates TLS, is the public entry on :443. We
  supply one server block. We do **not** ship an nginx container.
- **Packaging:** Docker Compose for backend + Redis only. The SPA builds to
  static files served directly by Dilmune nginx.

## Architecture

```
Dilmune nginx (:443, TLS, public)
  ├ /                       → /var/www/skoobl        (SPA dist, try_files → /index.html)
  ├ POST /games            ┐
  ├ /ws   (WS upgrade)     ┼→ 127.0.0.1:8080         (Go backend, compose loopback publish)
  └ /healthz               ┘
Go backend :8080 ──→ redis:6379   (compose-internal network, never exposed)
```

- Public attack surface = Dilmune nginx alone.
- Backend publishes only to `127.0.0.1:8080`; Redis is reachable only on the
  compose network.
- SPA and API are **same-origin** through nginx, so no CORS is needed in prod.

## Part 1 — Redis wiring

### Principle

Keep the room-actor model intact: the room goroutine remains the only writer of
its `GameState`. Persistence is a side effect performed inside that goroutine, so
no new races are introduced. The `store` package keeps operating on bytes and
never imports `game`; `game` defines the narrow interface it needs.

### `game` package

- New interface:
  ```go
  // Snapshotter persists a room's serialized state. Implemented by store.RedisStore.
  type Snapshotter interface {
      SaveSnapshot(ctx context.Context, code string, data []byte) error
  }
  ```
- `Room` gains an unexported `snap Snapshotter` field (nil ⇒ in-memory only).
- After each `broadcast()` in `Run`, call `r.persist()`: marshal `r.state` to
  JSON and `snap.SaveSnapshot` with a short timeout context. Nil-safe (returns
  immediately when `snap == nil`). Save errors are logged, not fatal — a failed
  snapshot must not take the room down.
- Constructors:
  - `NewRoom(code string) *Room` — unchanged (snap nil). Existing tests keep working.
  - `NewRoomWithStore(code string, snap Snapshotter) *Room` — used by the hub.
  - `NewRoomFromSnapshot(code string, data []byte, snap Snapshotter) (*Room, error)`
    — unmarshals `GameState` from `data` into a ready-to-run room.

### `store` package

- No interface changes. `RedisStore` already satisfies `game.Snapshotter`
  (`SaveSnapshot`) and the hub's `Store` (`SaveSnapshot` + `LoadSnapshot`).

### `hub` package

- New narrow interface:
  ```go
  type Store interface {
      SaveSnapshot(ctx context.Context, code string, data []byte) error
      LoadSnapshot(ctx context.Context, code string) (data []byte, ok bool, err error)
  }
  ```
- Constructor uses **functional options** so existing `hub.New()` calls are
  unchanged:
  ```go
  func New(opts ...Option) *Hub
  func WithStore(s Store) Option
  ```
- `Create()` builds rooms via `game.NewRoomWithStore(code, h.store)` when a store
  is configured (else `NewRoom`).
- `Lookup(code)` gains restore-on-miss:
  1. RLock fast path (unchanged).
  2. On miss, if no store → `nil, false`.
  3. With a store, `LoadSnapshot(code)`; not found → `nil, false`.
  4. Found → take the write lock, double-check the map, build the room via
     `game.NewRoomFromSnapshot`, `go r.Run()`, register, return it.

### `main.go` config

- `REDIS_ADDR` — empty ⇒ in-memory (dev/test, `hub.New()`); set ⇒ build a
  `redis.Client`, `Ping` (fatal on failure), `store.NewRedisStore(client, ttl)`,
  `hub.New(hub.WithStore(s))`.
- `SNAPSHOT_TTL` — Go duration, default `1h`.
- Redis client closed on graceful shutdown alongside the HTTP server.

## Part 2 — Origin hardening

- Single env var **`ALLOWED_ORIGINS`** (comma-separated list).
  - **Empty (prod default, same-origin behind nginx):** `corsMiddleware` adds no
    `Access-Control-*` headers; `ws.Handler` drops `InsecureSkipVerify` and
    relies on coder/websocket's default same-origin check.
  - **Set (dev, e.g. `http://localhost:5173`):** CORS reflects an allowed origin
    from the list; `ws.Handler` passes the list as `OriginPatterns`.
- `router.New` and `ws.Handler` take the parsed origin config (passed from
  `main.go`), keeping env reads in `main` only.

## Part 3 — Deploy infrastructure (files)

| File | Purpose |
|---|---|
| `backend/Dockerfile` | Multi-stage: `golang:1.26` build → static `CGO_ENABLED=0` binary → minimal runtime (`gcr.io/distroless/static` or `alpine`). Exposes 8080. |
| `backend/.dockerignore` | Exclude VCS, tests artifacts, local files from build context. |
| `infra/compose.yaml` | Services `backend` (build `../backend`, `ports: 127.0.0.1:8080:8080`, env `REDIS_ADDR=redis:6379`, `SNAPSHOT_TTL`, `restart: unless-stopped`, healthcheck `GET /healthz`) and `redis` (`redis:7-alpine`, named volume, `restart: unless-stopped`, no published port). |
| `infra/nginx/skoobl.conf` | Dilmune `server` block: `root /var/www/skoobl;` with `try_files $uri /index.html;` for the SPA; `location` blocks for `/games`, `/ws`, `/healthz` → `proxy_pass http://127.0.0.1:8080;` with `proxy_http_version 1.1` + `Upgrade`/`Connection` headers + long `proxy_read_timeout`/`proxy_send_timeout` for WS. |
| `infra/.env.example` | `REDIS_ADDR`, `SNAPSHOT_TTL`, `ALLOWED_ORIGINS` (commented; empty in prod), public domain note. |
| `infra/README.md` | Runbook: (1) `cd frontend && VITE_API_BASE= npm run build` then copy `dist/` → `/var/www/skoobl`; (2) `cd infra && docker compose up -d --build`; (3) drop `skoobl.conf` into Dilmune nginx and reload. Plus rollback + log commands. |

### Frontend build for same-origin

- Build with `VITE_API_BASE=""` so API calls are relative (`/games`) and hit the
  same origin.
- `VITE_WS_BASE`: derive `wss://<host>/ws` at runtime from `window.location` in
  `use-game-socket.ts` (one small change) so the static build is host-agnostic —
  no rebuild per domain. When `VITE_WS_BASE` is set (dev), it takes precedence;
  unset in prod ⇒ runtime-derived `wss://<host>/ws`.

## Error handling

- Snapshot save failure → logged, room continues (availability over durability
  for a transient Redis blip).
- Redis unreachable at boot with `REDIS_ADDR` set → fatal (operator
  misconfiguration should be loud).
- Restore-on-miss with a corrupt snapshot → log + treat as not found (404 to the
  client, as today).

## Testing — TDD

- **`game`**: fake `Snapshotter` records saves; assert a save occurs after a
  state-changing command; `NewRoomFromSnapshot` round-trips a serialized state;
  nil snapshotter performs no save and never panics.
- **`hub`**: fake `Store`; `Lookup` miss with a stored snapshot rehydrates a
  running room; miss with no snapshot returns false; `WithStore` rooms persist.
- **`ws`/`router`**: with `ALLOWED_ORIGINS` empty, a cross-origin WS handshake is
  rejected and no CORS header is set; with it populated, the listed origin is
  allowed.
- **infra**: `docker compose config` parses; `nginx -t` accepts `skoobl.conf`
  (run against a throwaway nginx); local smoke — `compose up`, `curl /healthz`,
  build SPA, load through a local nginx using the block.

## Risks

1. **Restore-on-miss semantics** — a room snapshot outliving its real players
   could rehydrate a stale room. Mitigated by the existing snapshot TTL; rooms
   expire from Redis after `SNAPSHOT_TTL`.
2. **Dockerfile Go version** — needs `go 1.26` base image availability; fall back
   to building with the toolchain pinned in `go.mod`.
3. **Frontend runtime WS URL** — deriving from `window.location` must handle the
   `https→wss` / `http→ws` scheme mapping correctly.
