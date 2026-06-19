import { useCallback, useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { SOCKET_URL } from "@/lib/config";
import type {
  GameConfig,
  GameState,
  ServerError,
  Stroke,
} from "@/lib/protocol";
import { useGameStore } from "@/lib/store";

// useGameSocket connects to the room over Socket.IO, joins as `name`, and feeds
// every "state" broadcast into the store. Socket.IO handles reconnection and
// transport negotiation, so there's no manual backoff here.
export function useGameSocket(code: string, name: string) {
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!code || !name) return;

    useGameStore.getState().reset();
    useGameStore.getState().setSelf(name);

    const socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      useGameStore.getState().setError(null);
      socket.emit("join", { code, name });
    });
    socket.on("state", (s: GameState) => useGameStore.getState().applyState(s));
    socket.on("error", (e: ServerError) =>
      useGameStore.getState().setError(e.message),
    );
    socket.on("connect_error", () =>
      useGameStore.getState().setError("Can't reach the server — retrying…"),
    );

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [code, name]);

  const emit = useCallback((event: string, payload?: unknown) => {
    socketRef.current?.emit(event, payload);
  }, []);

  return {
    configure: useCallback(
      (config: GameConfig) => emit("configure", config),
      [emit],
    ),
    start: useCallback(() => emit("start"), [emit]),
    nextPhase: useCallback(() => emit("nextPhase"), [emit]),
    leave: useCallback(() => emit("leave"), [emit]),
    submitDrawing: useCallback(
      (strokes: Stroke[]) => emit("submitDrawing", { strokes }),
      [emit],
    ),
    submitGuess: useCallback(
      (artist: string) => emit("submitGuess", { artist }),
      [emit],
    ),
  };
}
