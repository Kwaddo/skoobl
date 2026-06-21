import type { GameActions } from "@/hooks/use-game-socket";
import { useGameStore } from "@/lib/store";
import { CodeCard } from "../display/CodeCard";
import { EndedStage } from "../display/EndedStage";
import { PlayerGrid } from "../display/PlayerList";
import { HostConfig } from "./HostConfig";
import { PlayerDrawing, PlayerGuessing, PlayerReveal } from "./PlayerStage";

const MIN_PLAYERS = 4;

// PlayingHostStage is the screen for a host who is also a player (play-along
// rooms). It blends the player controller with the host's room controls: the
// host draws and guesses like everyone else, but also configures + starts from
// the lobby and advances the round from the reveal. There is no separate TV, so
// the drawing-to-guess is shown inline on each player's device (see PlayerGuessing).
export function PlayingHostStage({
  name,
  actions,
}: {
  name: string;
  actions: GameActions;
}) {
  const phase = useGameStore((s) => s.phase);
  const round = useGameStore((s) => s.round);

  switch (phase) {
    case "lobby":
      return <PlayingHostLobby actions={actions} />;
    case "drawing":
      return <PlayerDrawing key={round} actions={actions} />;
    case "guessing":
      return <PlayerGuessing key={round} name={name} actions={actions} />;
    case "reveal":
      return <PlayerReveal name={name} actions={actions} isHost />;
    case "ended":
      return (
        <EndedStage name={name} onPlayAgain={actions.returnToLobby} screen="host" />
      );
    default:
      return null;
  }
}

function PlayingHostLobby({ actions }: { actions: GameActions }) {
  const code = useGameStore((s) => s.code);
  const players = useGameStore((s) => s.players);
  const connected = players.filter((p) => p.connected).length;
  const canStart = connected >= MIN_PLAYERS;

  return (
    <div className="m-auto flex h-full w-full min-h-0 flex-col gap-4">
      <span
        className="sticker mx-auto shrink-0 px-3 py-1 font-hand text-lg text-foreground"
        style={{ "--rot": "-2deg" } as React.CSSProperties}
      >
        ✎ you're hosting &amp; playing
      </span>
      {/* one scroll for the share code, settings and roster; Start stays pinned */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
        <CodeCard code={code} />
        {/* plain wrapper gives HostConfig an indefinite height so it sizes to its
            content here instead of trying to fill the column like on the TV */}
        <div className="shrink-0">
          <HostConfig actions={actions} />
        </div>
        <div className="flex shrink-0 flex-col">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="ink-underline font-display text-xl font-black">
              Players
            </h2>
            <span
              className="sticker px-2 py-0.5 font-mono text-sm text-foreground"
              style={{ "--rot": "3deg" } as React.CSSProperties}
            >
              {players.length}
            </span>
          </div>
          <PlayerGrid players={players} />
        </div>
      </div>
      <button
        type="button"
        className="btn-key w-full shrink-0 px-6 py-4 text-lg"
        onClick={actions.start}
        disabled={!canStart}
      >
        {canStart
          ? "Start the game →"
          : `Need ${MIN_PLAYERS - connected} more player${
              MIN_PLAYERS - connected === 1 ? "" : "s"
            }…`}
      </button>
    </div>
  );
}
