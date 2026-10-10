# skoobl

A free, real-time multiplayer party game where everyone draws, then everyone guesses **who drew what**.

Each round every player gets a secret prompt and sketches it on their phone. The drawings are then shown one at a time, and players race to name the artist behind each one. Points go to sharp guessers and to artists whose doodles get recognized. After the last round, a final scoreboard crowns the winner.

**Play it:** https://skoobl-afqe-alimohsen999.dilmune.app/

## Features

- **Jackbox-style screens.** The host opens a shared "TV" display (shows the room code and QR, the roster, drawings, and reveals), and players join from their phones as controllers. Or the host can play along, with no separate display.
- **Game modes**
  - **Classic:** one drawing is featured at a time and everyone guesses who drew it.
  - **Whose Doodle (flipped):** everyone sees an anonymized grid of doodles and picks the one a given player drew.
  - **Frenzy:** classic rules plus room-wide waves of chaos effects (fog, flipped canvas, cramped hands, shuffled names, and more).
- **Word packs:** built-in English and Arabic prompt pools (Arabic prompts render right-to-left), or bring your own custom words.
- **Configurable rounds** plus drawing and guessing timers.
- **Room lifecycle:** reconnect-by-name grace window, host kick in the lobby, and rooms that survive a server restart (Redis snapshots).
- **Drawing history:** your past drawings are saved locally in the browser.
- **Updates tab:** an in-app changelog of what's new.
- 4–12 players per room.

## Tech stack

| Layer    | Stack |
|----------|-------|
| Frontend | React 19, TypeScript, Vite, TanStack Router, Zustand, Tailwind CSS v4, Socket.IO client |
| Backend  | Go, chi, Socket.IO (`zishang520/socket.io`), optional Redis persistence |
| Tooling  | Biome, Vitest, `go test` |
| Deploy   | Single Docker image (Go server serves the SPA, API, and socket on one port), built by GitHub Actions and pushed to GHCR |

The server owns the game state. Each client receives a redacted view, so nobody can see prompts, other players' in-progress drawings, or the featured artist before the reveal.

## Project layout

```
backend/    Go server: cmd/server (entrypoint), internal/game (rules, rounds, scoring, modes),
            hub, realtime (Socket.IO bridge), store (Redis), router, httpapi
frontend/   React SPA: routes (/, /host/$code, /play/$code), game stages, canvas, history, updates
infra/      docker compose (backend + Redis), nginx config, deployment guide
docs/       design specs, implementation plans, changelogs
Dockerfile  single-image production build
```

## Running locally

Prerequisites: Go 1.26+ and Node 22+. Redis is optional.

```bash
# Backend (listens on :8080)
cd backend
go run ./cmd/server

# Frontend (in a second terminal)
cd frontend
npm install
npm run dev
```

Open the URL Vite prints. The dev server proxies `/games`, `/healthz`, and `/socket.io` to `:8080`, so no CORS or env setup is needed.

### Environment

Backend (see `backend/.env.example`):

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `8080` | Listen port |
| `REDIS_ADDR` | unset | Redis address. When unset, rooms live in memory only. |
| `SNAPSHOT_TTL` | `1h` | How long room snapshots live in Redis |
| `ALLOWED_ORIGINS` | empty | Comma-separated CORS allowlist. Only needed for cross-origin dev; leave empty in prod. |
| `STATIC_DIR` | unset | When set, the server also serves the built SPA from this directory |

Frontend (see `frontend/.env.example`): `VITE_API_BASE` and `VITE_SOCKET_URL`. These are only needed to target a backend on another origin.

## Testing and checks

```bash
cd backend  && go test ./...
cd frontend && npm test && npm run typecheck && npm run lint
```

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the root `Dockerfile`, pushes `ghcr.io/kwaddo/skoobl`, and restarts the container on the VPS over SSH.

To build and run the production image yourself:

```bash
docker build -t skoobl .
docker run -p 5533:5533 skoobl
```

For the compose + nginx + Redis setup, see [`infra/README.md`](infra/README.md).
