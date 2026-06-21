import { Navigate, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useDrawingHistory } from "@/hooks/use-drawing-history";
import { CONNECTION_ERROR, useGameSocket } from "@/hooks/use-game-socket";
import { setFlash } from "@/lib/flash";
import { recallHostPlay, recallName } from "@/lib/identity";
import { useGameStore } from "@/lib/store";
import { ErrorPanel } from "./display/ErrorPanel";
import { RoomHeader } from "./display/RoomHeader";
import { ConfirmDialog } from "./overlays/ConfirmDialog";
import { Toasts } from "./overlays/Toasts";
import { HostStage } from "./stages/HostStage";
import { PlayerStage } from "./stages/PlayerStage";
import { PlayingHostStage } from "./stages/PlayingHostStage";

export type Screen = "host" | "player";

// GameStage is the in-room shell shared by /host and /play. It wires the socket
// (the host joins as a non-playing spectator), renders the header, and routes to
// the host TV display or the player controller. The host gets a wider container
// (a shared screen); the player a phone-width one.
export function GameStage({ code, screen }: { code: string; screen: Screen }) {
  const name = recallName();
  const navigate = useNavigate();
  // A host can be the non-playing big screen (display) or a player who also owns
  // the room (play-along). The home screen chose this; it drives how this client
  // joins. (A regular player can also *become* host later via a hand-off — see
  // amHost below — which is derived from live state, not the join.)
  const playingHostRoute = screen === "host" && recallHostPlay();
  const bigScreen = screen === "host" && !playingHostRoute;
  const actions = useGameSocket(code, name ?? "", {
    spectator: bigScreen,
    play: playingHostRoute,
  });
  const error = useGameStore((s) => s.error);
  const phase = useGameStore((s) => s.phase);
  const closed = useGameStore((s) => s.closed);
  const storeHost = useGameStore((s) => s.host);
  const hostPlays = useGameStore((s) => s.hostPlays);
  // I own the room if I joined as the host, or I've been promoted to host (the
  // previous host left and the room handed off to me).
  const amHost = !!name && storeHost === name;
  const isHost = screen === "host" || amHost;
  // The playing-host controller view: the play-along host, or any player who is
  // now the host of a no-TV room (after a hand-off).
  const showPlayingHost = playingHostRoute || (amHost && hostPlays);
  const inGame = phase !== "lobby" && phase !== "ended";
  // Which confirmation modal is open (host-only actions).
  const [confirming, setConfirming] = useState<null | "leave" | "lobby">(null);

  // Leave now: tell the room (host hands off to another player; player reaps an
  // empty room), then go home. The host leaving no longer ends the game, but it
  // does hand off control, so confirm first. Players leave straight away.
  const handleLeave = useCallback(() => {
    if (isHost) {
      setConfirming("leave");
      return;
    }
    actions.leave();
    navigate({ to: "/" });
  }, [actions, navigate, isHost]);

  // Host-only: abandon the current game and send everyone back to the lobby
  // (scores reset). Stays in the room — nobody is kicked.
  const handleBackToLobby = useCallback(() => setConfirming("lobby"), []);

  const confirmAction = useCallback(() => {
    if (confirming === "leave") {
      actions.leave();
      navigate({ to: "/" });
    } else if (confirming === "lobby") {
      actions.returnToLobby();
    }
    setConfirming(null);
  }, [confirming, actions, navigate]);

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

  // Persist this device's drawings to local history as the game plays.
  useDrawingHistory(code, name ?? "");

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
  // Only the display host gets the wide shared-screen shell; a playing host uses
  // the narrow controller shell like any other player.
  const shell = bigScreen
    ? "mx-auto flex h-dvh w-full max-w-[1700px] flex-col gap-5 overflow-hidden px-6 py-5 sm:px-10"
    : // Narrow controller on phones/portrait tablets. On a wide desktop (lg+) it
      // widens into a real two-pane workspace instead of a thin centred column,
      // and short/landscape still gets the side-by-side canvas room.
      "mx-auto flex h-dvh w-full max-w-xl flex-col gap-4 overflow-hidden px-5 py-5 short:max-w-5xl lg:max-w-6xl lg:gap-5 lg:px-8";

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
        {bigScreen ? (
          <HostStage name={name} actions={actions} />
        ) : showPlayingHost ? (
          <PlayingHostStage name={name} actions={actions} />
        ) : (
          <PlayerStage name={name} actions={actions} />
        )}
      </section>

      <ConfirmDialog
        open={confirming === "leave"}
        title="Leave the room?"
        message="The game keeps going for everyone else — another player takes over as host."
        confirmLabel="Leave room"
        onConfirm={confirmAction}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmDialog
        open={confirming === "lobby"}
        title="End this game?"
        message="Everyone goes back to the lobby and scores reset."
        confirmLabel="Back to lobby"
        onConfirm={confirmAction}
        onCancel={() => setConfirming(null)}
      />
    </main>
  );
}
