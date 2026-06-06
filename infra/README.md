# skoobl Deployment (Dilmune Cloud, single VPS)

Architecture: Dilmune edge nginx terminates TLS, serves the static SPA, and
reverse-proxies `/games`, `/ws`, `/healthz` to the Go backend container
(published on `127.0.0.1:8080`). Redis runs as a sibling container on the
compose-internal network and is never exposed.

```
Dilmune nginx (:443 TLS) ── / ──────────────→ /var/www/skoobl (SPA)
                         └─ /games,/ws,/healthz → 127.0.0.1:8080 (backend)
backend ──→ redis:6379 (compose-internal)
```

## Prerequisites
- Docker + Docker Compose on the VPS.
- Dilmune nginx managing TLS for the chosen hostname.
- Node 20+ to build the SPA (build can also run in CI; only `dist/` ships).

## 1. Build and place the SPA
```bash
cd frontend
VITE_API_BASE= npm ci && VITE_API_BASE= npm run build   # empty API base = same-origin
sudo rm -rf /var/www/skoobl && sudo mkdir -p /var/www/skoobl
sudo cp -r dist/* /var/www/skoobl/
```

## 2. Start backend + Redis
```bash
cd infra
cp .env.example .env        # keep ALLOWED_ORIGINS empty for prod
docker compose up -d --build
docker compose ps           # both services healthy
curl -s localhost:8080/healthz   # -> ok
```

## 3. Install the nginx server block
```bash
sudo cp infra/nginx/skoobl.conf /etc/nginx/conf.d/skoobl.conf
# edit server_name to the real hostname; ensure TLS cert directives match Dilmune
sudo nginx -t && sudo systemctl reload nginx
```

## Updating
```bash
git pull
# frontend changed:
cd frontend && VITE_API_BASE= npm run build && sudo cp -r dist/* /var/www/skoobl/
# backend changed:
cd infra && docker compose up -d --build
```

## Rollback
```bash
cd infra && docker compose down        # stop app (Redis data persists in volume)
git checkout <previous-sha> && docker compose up -d --build
```

## Logs & ops
```bash
cd infra
docker compose logs -f backend
docker compose logs -f redis
docker compose restart backend
```

## Notes
- Room state survives a backend restart (Redis snapshots, TTL `SNAPSHOT_TTL`).
  Clients reconnect with their code and the room is rehydrated on first lookup.
- `docker compose down -v` wipes the Redis volume (all active rooms). Avoid in prod.
