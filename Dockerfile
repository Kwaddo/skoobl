# syntax=docker/dockerfile:1
#
# Single-image production build for Dilmune (and any single-port host): the Go
# server serves the built SPA + the API + Socket.IO on one port. Multi-stage so
# the final image carries only the static binary and the static assets.

# 1) Build the SPA. Same-origin in prod, so the API/socket bases are empty.
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ENV VITE_API_BASE="" VITE_SOCKET_URL=""
RUN npm run build

# 2) Build the Go server.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# 3) Minimal runtime: server binary + static SPA, nothing else.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /server
COPY --from=web /web/dist /www
ENV STATIC_DIR=/www
ENV PORT=5533
EXPOSE 5533
USER nonroot:nonroot
ENTRYPOINT ["/server"]
