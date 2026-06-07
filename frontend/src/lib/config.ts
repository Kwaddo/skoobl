// Backend bases. Default to same-origin (empty string): in dev the Vite proxy
// forwards /games and /socket.io to the Go server (see vite.config.ts), and in
// prod nginx serves the SPA and reverse-proxies the same paths. Override only to
// target a backend on a different origin.

export const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// Socket.IO connection URL. Empty = same-origin (the client connects to the
// page origin and the proxy/nginx routes /socket.io to the backend).
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? "";
