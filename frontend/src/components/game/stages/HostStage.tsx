import { useCountdown } from "@/hooks/use-countdown";
import type { GameActions } from "@/hooks/use-game-socket";
import type { Stroke } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";
import { StrokesView } from "../canvas/StrokesView";
import { CodeCard } from "../display/CodeCard";
import { DrawingCarousel } from "../display/DrawingCarousel";
import { EndedStage } from "../display/EndedStage";
import { HOST_CANVAS, HOST_CANVAS_BOX } from "../display/host-canvas";
import { Panel } from "../display/Panel";
import { PlayerGrid, Roster } from "../display/PlayerList";
import { Scoreboard } from "../display/Scoreboard";
import { Timer } from "../display/Timer";
import { Brush, Trophy } from "../icons";
import { HostConfig } from "./HostConfig";

const MIN_PLAYERS = 4;

// HostStage is the shared "TV": a non-playing display. It shows the lobby +
// settings, who has finished each phase, the drawing to be guessed, and the
// reveal/scoreboard. It never draws or guesses.
export function HostStage({
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
      return <HostLobby actions={actions} />;
    case "drawing":
      return <HostDrawing key={round} />;
    case "guessing":
      return <HostGuessing key={round} />;
    case "reveal":
      return <HostReveal actions={actions} />;
    case "ended":
      return <HostEnded name={name} actions={actions} />;
    default:
      return null;
  }
}

// HostEnded is the TV's final-results screen: a carousel cycling through every
// drawing made all game (left), beside the winner + final scoreboard + play
// again (right). Falls back to the scoreboard-only EndedStage if no drawings
// were captured (e.g. an all-blank game).
function HostEnded({ name, actions }: { name: string; actions: GameActions }) {
  const players = useGameStore((s) => s.players);
  const galleryHistory = useGameStore((s) => s.galleryHistory);

  const items: { round: number; artist: string; strokes: Stroke[] }[] = [];
  for (const round of Object.keys(galleryHistory)
    .map(Number)
    .sort((a, b) => a - b)) {
    const byArtist = galleryHistory[round];
    for (const artist of Object.keys(byArtist)) {
      if (byArtist[artist]?.length) {
        items.push({ round, artist, strokes: byArtist[artist] });
      }
    }
  }

  if (items.length === 0) {
    return (
      <EndedStage
        name={name}
        onPlayAgain={actions.returnToLobby}
        screen="host"
      />
    );
  }

  const ranked = [...players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const winner = ranked[0];

  return (
    <div className="grid h-full min-h-0 gap-6 lg:grid-cols-[1.6fr_1fr]">
      <DrawingCarousel items={items} />
      <div className="flex min-h-0 flex-col gap-4">
        <div className="card-arcade rise flex shrink-0 flex-col items-center gap-2 p-5 text-center">
          <span className="trophy-bounce text-foreground">
            <Trophy className="h-10 w-10" />
          </span>
          <span className="font-display text-2xl font-bold">Game over</span>
          {winner && (
            <span className="text-sm text-muted">
              Winner:{" "}
              <span
                dir="auto"
                className="font-display font-bold text-foreground"
              >
                {winner.name}
              </span>{" "}
              with {winner.score ?? 0} pts
            </span>
          )}
        </div>
        <Panel className="flex-1" title="Final scores">
          <Scoreboard players={players} />
        </Panel>
        <button
          type="button"
          className="btn-key w-full shrink-0 px-6 py-4 text-lg"
          onClick={actions.returnToLobby}
        >
          Play again →
        </button>
      </div>
    </div>
  );
}

function HostLobby({ actions }: { actions: GameActions }) {
  const code = useGameStore((s) => s.code);
  const players = useGameStore((s) => s.players);
  const connected = players.filter((p) => p.connected).length;
  const canStart = connected >= MIN_PLAYERS;

  return (
    <div className="grid h-full min-h-0 gap-6 lg:grid-cols-[1.05fr_0.95fr]">
      {/* left: share the code + see who's in */}
      <div className="flex min-h-0 flex-col gap-5">
        <CodeCard code={code} />
        <Panel
          className="flex-1"
          title="In the lobby"
          aside={
            <span className="font-mono text-sm text-muted">
              {players.length} {players.length === 1 ? "player" : "players"}
            </span>
          }
        >
          <PlayerGrid players={players} />
        </Panel>
      </div>

      {/* right: settings + start */}
      <div className="flex min-h-0 flex-col gap-5">
        <div className="flex min-h-0 flex-1 flex-col">
          <HostConfig actions={actions} />
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
    </div>
  );
}

function HostDrawing() {
  const prompt = useGameStore((s) => s.yourPrompt);
  const endsAt = useGameStore((s) => s.phaseEndsAt);
  const players = useGameStore((s) => s.players);
  const remaining = useCountdown(endsAt);
  const drawn = players.filter((p) => p.locked).length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            Everyone is drawing
          </span>
          <span
            dir="auto"
            className="font-display text-3xl font-bold sm:text-4xl"
          >
            {prompt || "…"}
          </span>
        </div>
        <Timer remaining={remaining} />
      </div>
      <Panel
        className="flex-1"
        title="Sketching…"
        aside={
          <span className="font-mono text-sm text-muted">
            {drawn} of {players.length} finished
          </span>
        }
      >
        <Roster players={players} mode="drawing" />
      </Panel>
    </div>
  );
}

function HostGuessing() {
  const drawing = useGameStore((s) => s.currentDrawing);
  const players = useGameStore((s) => s.players);
  const endsAt = useGameStore((s) => s.phaseEndsAt);
  const remaining = useCountdown(endsAt);
  const guessed = players.filter((p) => p.hasGuessed).length;
  // The artist is excluded from guessing, so exactly one player never guesses.
  // Count against the non-artist total so the tally tops out cleanly and never
  // singles the artist out.
  const eligible = Math.max(players.length - 1, 0);

  return (
    <div className="grid h-full min-h-0 gap-6 lg:grid-cols-[1.6fr_1fr]">
      <div className="flex min-h-0 flex-col gap-4">
        <div className="flex shrink-0 items-center justify-between gap-3">
          <h2 className="font-display text-2xl font-bold sm:text-3xl">
            Who drew this?
          </h2>
          <Timer remaining={remaining} />
        </div>
        <div className={`flex-1 ${HOST_CANVAS_BOX}`}>
          <StrokesView strokes={drawing} className={HOST_CANVAS} />
        </div>
      </div>
      <Panel
        className="flex-1"
        title="Players"
        aside={
          <span className="font-mono text-sm text-muted">
            {guessed}/{eligible} guessed
          </span>
        }
      >
        <Roster players={players} mode="guessing" />
      </Panel>
    </div>
  );
}

function HostReveal({ actions }: { actions: GameActions }) {
  const drawing = useGameStore((s) => s.currentDrawing);
  const reveal = useGameStore((s) => s.reveal);
  const players = useGameStore((s) => s.players);
  const gallery = useGameStore((s) => s.gallery);
  const round = useGameStore((s) => s.round);
  const totalRounds = useGameStore((s) => s.totalRounds);
  const isLast = round >= totalRounds;
  const correct = players.filter((p) => p.correct);
  // A round where nobody drew anything skips guessing and lands here with no
  // artist — show a "nobody drew" message instead of a blank canvas.
  const noArtist = !reveal?.artist;

  return (
    <div className="grid h-full min-h-0 gap-6 lg:grid-cols-[1.6fr_1fr]">
      {noArtist ? (
        <div
          className={`flex flex-col items-center justify-center gap-3 p-8 text-center ${HOST_CANVAS_BOX}`}
        >
          <Brush className="h-12 w-12 text-muted" />
          <p className="font-display text-2xl font-bold">
            Nobody drew anything
          </p>
          <p className="text-sm text-muted">
            Everyone ran out of time or left the canvas blank.
          </p>
        </div>
      ) : (
        // min-w-0 lets this column shrink to its grid track instead of growing to
        // fit every gallery tile — without it, a full room's worth of drawings
        // would widen the track and shove the leaderboard off the screen edge.
        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          <div className={`min-h-0 flex-1 ${HOST_CANVAS_BOX}`}>
            <StrokesView strokes={drawing} className={HOST_CANVAS} />
          </div>
          {Object.keys(gallery).length > 0 && (
            <div className="min-w-0 shrink-0">
              <span className="font-mono text-xs uppercase tracking-widest text-muted">
                Everyone's drawings
              </span>
              {/* Bounded to the column and scrolled horizontally: any number of
                  drawings (up to a full room) stays fully reachable, none clipped. */}
              <ul className="mt-2 flex snap-x gap-3 overflow-x-auto overflow-y-hidden pb-2">
                {Object.entries(gallery).map(([artist, strokes]) => (
                  <li
                    key={artist}
                    className={`shrink-0 snap-start rounded-xl border-2 p-1.5 ${
                      artist === reveal?.artist
                        ? "border-foreground"
                        : "border-border"
                    }`}
                  >
                    <StrokesView
                      strokes={strokes}
                      className="aspect-4/3 w-32 rounded-lg border border-border bg-surface"
                    />
                    <span
                      dir="auto"
                      className="mt-1 block max-w-32 truncate text-center text-xs font-semibold"
                    >
                      {artist}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-col gap-4">
        <div className="card-arcade rise flex shrink-0 flex-col gap-1 p-5 text-center">
          {noArtist ? (
            <>
              <span className="font-display text-2xl font-bold">
                No drawing this round
              </span>
              {reveal?.prompt && (
                <span dir="auto" className="text-sm text-muted">
                  the word was: {reveal.prompt}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="font-mono text-xs uppercase tracking-widest text-muted">
                It was drawn by
              </span>
              <span dir="auto" className="font-display text-2xl font-bold">
                {reveal?.artist ?? "—"}
              </span>
              {reveal?.prompt && (
                <span dir="auto" className="text-sm text-muted">
                  prompt: {reveal.prompt}
                </span>
              )}
              <span className="mt-2 text-sm">
                {correct.length === 0
                  ? "Nobody guessed right!"
                  : `${correct.length} guessed it: `}
                <span dir="auto" className="font-semibold">
                  {correct.map((p) => p.name).join(", ")}
                </span>
              </span>
            </>
          )}
        </div>

        <Panel className="flex-1" title="Leaderboard">
          <Scoreboard players={players} />
        </Panel>

        <button
          type="button"
          className="btn-key w-full shrink-0 px-6 py-4 text-lg"
          onClick={actions.nextPhase}
        >
          {isLast ? "See final results →" : "Next round →"}
        </button>
      </div>
    </div>
  );
}
