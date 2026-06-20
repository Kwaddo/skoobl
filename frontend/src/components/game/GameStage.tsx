import { Navigate, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { CONNECTION_ERROR, useGameSocket } from "@/hooks/use-game-socket";
import { setFlash } from "@/lib/flash";
import { recallName } from "@/lib/identity";
import { useGameStore } from "@/lib/store";
import { HostStage } from "./HostStage";
import { PlayerStage } from "./PlayerStage";
import { ErrorPanel, RoomHeader } from "./shared";
import { Toasts } from "./Toasts";

export type Screen = "host" | "player";

// GameStage is the in-room shell shared by /host and /play. It wires the socket
// (the host joins as a non-playing spectator), renders the header, and routes to
// the host TV display or the player controller. The host gets a wider container
// (a shared screen); the player a phone-width one.
export function GameStage({ code, screen }: { code: string; screen: Screen }) {
  const name = recallName();
  const navigate = useNavigate();
  const actions = useGameSocket(code, name ?? "", {
    spectator: screen === "host",
  });
  const error = useGameStore((s) => s.error);
  const phase = useGameStore((s) => s.phase);
  const closed = useGameStore((s) => s.closed);
  const isHost = screen === "host";
  const inGame = phase !== "lobby" && phase !== "ended";

  // Leave now: tell the room (immediate host-close / player reap), then go home.
  // The host leaving closes the room for everyone, so confirm before doing it.
  const handleLeave = useCallback(() => {
    if (isHost && !window.confirm("Leave and close the room for everyone?")) {
      return;
    }
    actions.leave();
    navigate({ to: "/" });
  }, [actions, navigate, isHost]);

  // Host-only: abandon the current game and send everyone back to the lobby
  // (scores reset). Stays in the room — nobody is kicked.
  const handleBackToLobby = useCallback(() => {
    if (
      !window.confirm(
        "End the current game and send everyone back to the lobby?",
      )
    ) {
      return;
    }
    actions.returnToLobby();
  }, [actions]);

  // The host left (or its display dropped past grace): the room is gone. Kick
  // the player to the main menu with a one-shot message in the home banner.
  useEffect(() => {
    if (!closed) return;
    setFlash({ message: "The host left — the game ended.", tab: "join" });
    navigate({ to: "/" });
  }, [closed, navigate]);

  // Recoverable join rejections (name taken, wrong code, room full, …) shouldn't
  // hijack the whole screen. Bounce back to the home form with a small inline
  // message so the player can fix it and retry. Only a genuine can't-reach-the-
  // server state keeps the full-screen panel.
  const recoverable = !!error && error !== CONNECTION_ERROR;
  useEffect(() => {
    if (!recoverable || !error) return;
    setFlash({
      message: error,
      tab: screen === "host" ? "host" : "join",
      code,
    });
    useGameStore.getState().setError(null);
    navigate({ to: "/" });
  }, [recoverable, error, screen, code, navigate]);

  if (!name) return <Navigate to="/" />;
  if (error === CONNECTION_ERROR) return <ErrorPanel message={error} />;
  if (recoverable) return null;

  // The host is a shared "TV": locked to the viewport height and never scrolls,
  // so nothing jumps around for the players watching. The player is a phone
  // controller: narrow and free to scroll.
  //
  // Both screens lock to the viewport and never scroll the page; each phase
  // fits/centers/squeezes its own content. Host is a wide shared display, the
  // player a narrower controller.
  const shell = isHost
    ? "mx-auto flex h-dvh w-full max-w-[1700px] flex-col gap-5 overflow-hidden px-6 py-5 sm:px-10"
    : // narrow controller normally; when the window is short the canvas+tools go
      // side-by-side, so widen it to give the canvas real room to grow.
      "mx-auto flex h-dvh w-full max-w-xl flex-col gap-4 overflow-hidden px-5 py-5 short:max-w-5xl";

  return (
    <main className={`grain-above ${shell}`}>
      <Toasts />
      <RoomHeader
        code={code}
        name={name}
        onLeave={handleLeave}
        onBackToLobby={isHost && inGame ? handleBackToLobby : undefined}
      />
      <section className="flex min-h-0 flex-1 flex-col">
        {/* phases below fill, centre, or scroll within this fixed area */}
        {isHost ? (
          <HostStage name={name} actions={actions} />
        ) : (
          <PlayerStage name={name} actions={actions} />
        )}
      </section>
    </main>
  );
}
