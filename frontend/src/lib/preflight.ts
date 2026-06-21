import { io } from "socket.io-client";
import { CONNECTION_ERROR } from "@/hooks/use-game-socket";
import { SOCKET_URL } from "./config";

// preflightJoin tries the join from the home form *before* navigating, so a bad
// code or a taken name shows inline on the form instead of bouncing through the
// room screen. It opens a short-lived socket, attempts the join, and resolves
// with null on success or the server's message on failure — then disconnects.
//
// The backend reconnects by name within its grace window, so the room screen
// re-joining moments later with the same name just adopts the seat this check
// briefly held; no double-join error.
export function preflightJoin(
  code: string,
  name: string,
  spectator: boolean,
  play = false,
): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });
    let done = false;
    const finish = (msg: string | null) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      socket.removeAllListeners();
      socket.disconnect();
      resolve(msg);
    };

    const timer = window.setTimeout(
      () => finish("Joining timed out. Try again."),
      6000,
    );

    socket.on("connect", () =>
      socket.emit(
        "join",
        play
          ? { code, name, play: true }
          : spectator
            ? { code, name, spectator: true }
            : { code, name },
      ),
    );
    socket.on("state", () => finish(null));
    socket.on("error", (e: { message?: string }) =>
      finish(e?.message ?? "Couldn't join. Try again."),
    );
    socket.on("connect_error", () => finish(CONNECTION_ERROR));
  });
}
