/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  // tanstackRouter must come before the react plugin.
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  // Pre-bundle deps that are otherwise discovered lazily on first load. Without
  // this, Vite re-optimizes mid-session and force-reloads the page, which yanks
  // the live Socket.IO connection and spams the proxy log with ECONNRESET/EPIPE.
  optimizeDeps: {
    include: [
      "socket.io-client",
      "@radix-ui/react-slot",
      "class-variance-authority",
      "clsx",
      "tailwind-merge",
    ],
  },
  // Proxy backend routes to the Go server so the app is same-origin in dev:
  // no CORS, no VITE_API_BASE/VITE_WS_BASE needed. Mirrors prod, where nginx
  // serves the SPA and reverse-proxies these same paths.
  server: {
    proxy: {
      "/games": "http://localhost:8080",
      "/healthz": "http://localhost:8080",
      "/socket.io": { target: "http://localhost:8080", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
