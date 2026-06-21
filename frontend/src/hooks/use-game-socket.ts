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

// Shown while the socket can't reach the server. Unlike a join rejection this is
// transient (Socket.IO keeps retrying), so the UI treats it differently.
export const CONNECTION_ERROR = "Can't reach the server — retrying…";

// useGameSocket connects to the room over Socket.IO, joins as `name`, and feeds
// every "state" broadcast into the store. Socket.IO handles reconnection and
// transport negotiation, so there's no manual backoff here.
export function useGameSocket(
  code: string,
  name: string,
  opts: { spectator?: boolean; play?: boolean } = {},
) {
  const socketRef = useRef<Socket | null>(null);
  const spectator = opts.spectator ?? false;
  // A playing host joins as a player that also owns the room (play=true); a
  // display host joins as a non-playing spectator.
  const play = opts.play ?? false;

  useEffect(() => {
    if (!code || !name) return;

    useGameStore.getState().reset();
    useGameStore.getState().setSelf(name);

    const socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      useGameStore.getState().setError(null);
      socket.emit(
        "join",
        play
          ? { code, name, play: true }
          : spectator
            ? { code, name, spectator: true }
            : { code, name },
      );
    });
    socket.on("state", (s: GameState) => {
      const store = useGameStore.getState();
      store.applyState(s);
      // Mark connected only once a broadcast lands, not on the bare "connect"
      // event: between reconnect and the first fresh state the store still holds
      // the pre-drop (possibly expired) deadline, and flipping connected early
      // would let the auto-submit fire against that stale clock.
      store.setConnected(true);
    });
    socket.on("error", (e: ServerError) =>
      useGameStore.getState().setError(e.message),
    );
    socket.on("connect_error", () =>
      useGameStore.getState().setError(CONNECTION_ERROR),
    );
    socket.on("disconnect", () => useGameStore.getState().setConnected(false));

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [code, name, spectator, play]);

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
    returnToLobby: useCallback(() => emit("returnToLobby"), [emit]),
    leave: useCallback(() => emit("leave"), [emit]),
    submitDrawing: useCallback(
      (strokes: Stroke[]) => emit("submitDrawing", { strokes }),
      [emit],
    ),
    draftDrawing: useCallback(
      (strokes: Stroke[]) => emit("draftDrawing", { strokes }),
      [emit],
    ),
    submitGuess: useCallback(
      (artist: string) => emit("submitGuess", { artist }),
      [emit],
    ),
    submitDoodleGuess: useCallback(
      (id: string) => emit("submitGuess", { id }),
      [emit],
    ),
    firePowerup: useCallback(
      (id: string) => emit("firePowerup", { id }),
      [emit],
    ),
  };
}

// GameActions is the imperative command surface returned by useGameSocket,
// shared by the host and player stage components.
export type GameActions = ReturnType<typeof useGameSocket>;
