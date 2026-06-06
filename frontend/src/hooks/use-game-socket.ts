import { useCallback, useEffect, useRef } from "react";
import { cmd, type Envelope, type GameState } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";

// Prefer an explicit override (dev). Otherwise derive from the page origin so
// the static build is host-agnostic: https→wss, http→ws, same host, /ws path.
function defaultWsBase(): string {
  if (typeof window === "undefined") return "ws://localhost:8080/ws";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}
const WS_BASE = import.meta.env.VITE_WS_BASE ?? defaultWsBase();
const MAX_BACKOFF = 5000;

export function useGameSocket(code: string, player: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const backoff = useRef(500);
  const closedRef = useRef(false);

  const send = useCallback((env: Envelope) => {
    const ws = wsRef.current;
    // 1 === WebSocket.OPEN; use the literal so test mocks without static
    // readyState constants still report the socket as open.
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(env));
    }
  }, []);

  useEffect(() => {
    if (!code || !player) return;
    closedRef.current = false;
    useGameStore.getState().setSelf(player);

    const connect = () => {
      const ws = new WebSocket(`${WS_BASE}?code=${encodeURIComponent(code)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        backoff.current = 500;
        ws.send(JSON.stringify(cmd.join(player)));
      };
      ws.onmessage = (e) => {
        const env = JSON.parse(e.data) as Envelope;
        if (env.type === "state") {
          useGameStore.getState().applyState(env.payload as GameState);
        } else if (env.type === "error") {
          useGameStore
            .getState()
            .setError((env.payload as { message: string }).message);
        }
      };
      ws.onclose = () => {
        if (closedRef.current) return;
        const delay = backoff.current;
        backoff.current = Math.min(delay * 2, MAX_BACKOFF);
        setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closedRef.current = true;
      wsRef.current?.close();
    };
  }, [code, player]);

  return { send };
}
