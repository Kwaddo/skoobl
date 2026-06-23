import { Confetti } from "@/components/Confetti";
import { downloadStrokesPng, pngFilename } from "@/lib/canvas";
import { useGameStore } from "@/lib/store";
import { StrokesView } from "../canvas/StrokesView";
import { Crown, Sparkle, Trophy } from "../icons";
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
  // The server freezes the champion at game end, so the banner holds steady even
  // as players (the winner included) leave the results. Fall back to a live
  // ranking only if an older snapshot hasn't set it yet.
  const frozenWinner = useGameStore((s) => s.winner);
  const frozenScore = useGameStore((s) => s.winnerScore);
  const ranked = [...players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const winnerName = frozenWinner || ranked[0]?.name || "";
  const winnerScore = frozenWinner ? frozenScore : (ranked[0]?.score ?? 0);
  const youWon = !!winnerName && winnerName === name;

  const banner = (
    <div className="ink-block tilt-l flex shrink-0 flex-col items-center gap-3 p-8 text-center">
      {youWon && <Confetti />}
      <span
        className={
          youWon ? "champion-trophy trophy-bounce" : "trophy-bounce text-foreground"
        }
      >
        {youWon ? (
          <Trophy className="h-16 w-16" />
        ) : (
          <Sparkle className="h-12 w-12" />
        )}
      </span>
      {youWon ? (
        <h2 className="gold-text font-display text-4xl font-black tracking-tight uppercase">
          You won!
        </h2>
      ) : (
        <h2 className="font-display text-3xl font-black">Game over</h2>
      )}
      {winnerName && (
        <div className="flex flex-col items-center gap-2">
          {!youWon && (
            <span className="font-hand text-xl leading-tight text-muted">
              champion
            </span>
          )}
          <span className="champion-pill font-display text-lg font-black">
            <Crown className="h-4 w-4" />
            <span dir="auto" className="gold-text">
              {winnerName}
            </span>
          </span>
          <span className="font-hand text-xl text-muted">{winnerScore} pts</span>
        </div>
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
    <div className="m-auto flex w-full max-w-2xl max-h-full min-h-0 flex-col gap-5 lg:max-w-4xl">
      {banner}
      <p className="shrink-0 rounded-xl border-2 border-dashed border-border px-4 py-3 text-center font-hand text-lg leading-snug text-muted">
        🎨 want to see everyone's doodles? they're stashed in the{" "}
        <span className="font-display font-bold text-foreground">History</span> tab
        back home.
      </p>
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
          <ul className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-auto pr-1 sm:grid-cols-3 lg:grid-cols-4">
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
