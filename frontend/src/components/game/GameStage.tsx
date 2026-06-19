import { Navigate, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useGameSocket } from "@/hooks/use-game-socket";
import { recallName } from "@/lib/identity";
import { useGameStore } from "@/lib/store";
import { HostStage } from "./HostStage";
import { PlayerStage } from "./PlayerStage";
import { ErrorPanel, RoomHeader } from "./shared";

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

  // Leave now: tell the room (immediate host-close / player reap), then go home.
  const handleLeave = useCallback(() => {
    actions.leave();
    navigate({ to: "/" });
  }, [actions, navigate]);

  if (!name) return <Navigate to="/" />;
  if (error) return <ErrorPanel message={error} />;

  const width = screen === "host" ? "max-w-4xl" : "max-w-md";

  return (
    <main
      className={`grain-above mx-auto flex min-h-dvh w-full ${width} flex-col gap-6 px-5 py-8`}
    >
      <RoomHeader code={code} name={name} onLeave={handleLeave} />
      <section className="flex flex-1 flex-col">
        {screen === "host" ? (
          <HostStage name={name} actions={actions} />
        ) : (
          <PlayerStage name={name} actions={actions} />
        )}
      </section>
    </main>
  );
}
