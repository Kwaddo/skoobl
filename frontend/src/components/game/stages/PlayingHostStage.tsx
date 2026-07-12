import { lazy, Suspense } from "react";
import type { GameActions } from "@/hooks/use-game-socket";
import { useGameStore } from "@/lib/store";
import { EndedStage } from "../display/EndedStage";
import { PlayerGrid } from "../display/PlayerList";
import { HostConfig } from "./HostConfig";
import { PlayerDrawing, PlayerGuessing, PlayerReveal } from "./PlayerStage";

const CodeCard = lazy(() =>
  import("../display/CodeCard").then((m) => ({ default: m.CodeCard })),
);

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
        <EndedStage
          name={name}
          onPlayAgain={actions.returnToLobby}
          screen="host"
        />
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
      {/* Mobile: one scroll column (code, settings, roster). Desktop: two columns
          — code + settings on the left, roster on the right — each scrolling on
          its own. Start stays pinned below either way. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1 lg:grid lg:grid-cols-2 lg:gap-6 lg:overflow-hidden">
        {/* lg padding leaves room for each card's hard offset shadow (≈7px right
            /down) and the QR's tape strip (≈11px up) so the scroll clip doesn't
            shear them */}
        <div className="flex flex-col gap-4 lg:min-h-0 lg:overflow-y-auto lg:px-2 lg:pt-3 lg:pb-2">
          <Suspense fallback={null}>
            <CodeCard code={code} />
          </Suspense>
          {/* plain wrapper gives HostConfig an indefinite height so it sizes to its
              content here instead of trying to fill the column like on the TV */}
          <div className="shrink-0">
            <HostConfig actions={actions} />
          </div>
        </div>
        <div className="flex shrink-0 flex-col lg:min-h-0 lg:shrink lg:overflow-y-auto lg:px-2 lg:pt-2 lg:pb-2">
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
          <PlayerGrid players={players} onKick={actions.kick} />
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
