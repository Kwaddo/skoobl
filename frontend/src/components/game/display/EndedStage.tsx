import { Confetti } from "@/components/Confetti";
import { downloadStrokesPng, pngFilename } from "@/lib/canvas";
import { useGameStore } from "@/lib/store";
import { StrokesView } from "../canvas/StrokesView";
import { Sparkle, Trophy } from "../icons";
import { Scoreboard } from "./Scoreboard";

// EndedStage is the final results screen. The host TV (screen="host", default)
// shows the winner + full leaderboard, with Play-again via onPlayAgain. The
// player phone (screen="player") shows the winner banner + their own drawings to
// download — the leaderboard lives on the TV.
export function EndedStage({
  name,
  onPlayAgain,
  screen = "host",
}: {
  name: string;
  onPlayAgain?: () => void;
  screen?: "host" | "player";
}) {
  const players = useGameStore((s) => s.players);
  const ranked = [...players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const winner = ranked[0];
  const youWon = winner?.name === name;

  const banner = (
    <div className="ink-block tilt-l flex shrink-0 flex-col items-center gap-2 p-8 text-center">
      {youWon && <Confetti />}
      <span className="trophy-bounce text-foreground">
        {youWon ? (
          <Trophy className="h-12 w-12" />
        ) : (
          <Sparkle className="h-12 w-12" />
        )}
      </span>
      <h2 className="font-display text-3xl font-black">Game over</h2>
      {winner && (
        <p className="font-hand text-2xl leading-tight text-muted">
          winner:{" "}
          <span dir="auto" className="font-display text-xl font-black text-foreground">
            {winner.name}
          </span>{" "}
          with {winner.score ?? 0} pts
        </p>
      )}
    </div>
  );

  if (screen === "player") {
    return <PlayerEnded banner={banner} />;
  }

  return (
    <div className="m-auto flex w-full max-w-2xl max-h-full min-h-0 flex-col gap-5">
      {banner}
      <div className="min-h-0 flex-1 overflow-auto pr-1">
        <Scoreboard players={players} />
      </div>
      {onPlayAgain ? (
        <button
          type="button"
          className="btn-key w-full shrink-0 px-6 py-4 text-lg"
          onClick={onPlayAgain}
        >
          Play again →
        </button>
      ) : (
        <p className="shrink-0 text-center text-sm text-muted">
          Waiting for the host to start a new game
          <span className="live-dot ml-1 text-foreground">●</span>
        </p>
      )}
    </div>
  );
}

// PlayerEnded is the phone's final screen: keepsake gallery of the player's own
// drawings, each downloadable, plus a Download-all. No leaderboard (that's on
// the TV); a waiting line tells them the host can restart.
function PlayerEnded({ banner }: { banner: React.ReactNode }) {
  const myDrawings = useGameStore((s) => s.myDrawings);
  const rounds = Object.keys(myDrawings)
    .map(Number)
    .filter((r) => (myDrawings[r]?.length ?? 0) > 0)
    .sort((a, b) => a - b);

  const downloadAll = () => {
    for (const r of rounds) downloadStrokesPng(myDrawings[r], pngFilename(r));
  };

  return (
    <div className="m-auto flex w-full max-w-2xl max-h-full min-h-0 flex-col gap-5">
      {banner}
      {rounds.length > 0 ? (
        <>
          <div className="flex shrink-0 items-center justify-between">
            <h3 className="font-display text-lg font-bold">Your drawings</h3>
            <button
              type="button"
              className="btn-ghost px-3 py-1.5 text-sm"
              onClick={downloadAll}
            >
              Download all ↓
            </button>
          </div>
          <ul className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-auto pr-1 sm:grid-cols-3">
            {rounds.map((r) => (
              <li key={r} className="card-arcade flex flex-col gap-2 p-3">
                <StrokesView strokes={myDrawings[r]} />
                <button
                  type="button"
                  className="btn-ghost px-3 py-2 text-sm"
                  onClick={() =>
                    downloadStrokesPng(myDrawings[r], pngFilename(r))
                  }
                >
                  Download round {r} ↓
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="shrink-0 text-center text-sm text-muted">
          No drawings to show from this game.
        </p>
      )}
      <p className="shrink-0 text-center text-sm text-muted">
        Waiting for the host to start a new game
        <span className="live-dot ml-1 text-foreground">●</span>
      </p>
    </div>
  );
}
