import { lazy, Suspense, useMemo } from "react";
import { Confetti } from "@/components/Confetti";
import { useCountdown } from "@/hooks/use-countdown";
import type { GameActions } from "@/hooks/use-game-socket";
import type { Stroke } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";
import { StrokesView } from "../canvas/StrokesView";
import { DrawingCarousel } from "../display/DrawingCarousel";
import { EndedStage } from "../display/EndedStage";
import { FeatureProgress } from "../display/FeatureProgress";
import { FlippedGuessing } from "../display/FlippedGuessing";
import { HOST_CANVAS, HOST_CANVAS_BOX } from "../display/host-canvas";
import { Panel } from "../display/Panel";
import { PlayerGrid, Roster } from "../display/PlayerList";
import { Scoreboard } from "../display/Scoreboard";
import { Timer } from "../display/Timer";
import { Brush, Scribble, Trophy } from "../icons";
import { HostConfig } from "./HostConfig";

const CodeCard = lazy(() =>
  import("../display/CodeCard").then((m) => ({ default: m.CodeCard })),
);

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

  // Must be before the early return to satisfy the rules of hooks.
  const ranked = useMemo(
    () => [...players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
    [players],
  );
  const winner = ranked[0];

  if (items.length === 0) {
    return (
      <EndedStage
        name={name}
        onPlayAgain={actions.returnToLobby}
        screen="host"
      />
    );
  }

  return (
    <div className="flex flex-col gap-6 lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[1.6fr_1fr]">
      {winner && <Confetti />}
      <DrawingCarousel items={items} />
      <div className="flex min-h-0 flex-col gap-4">
        <div className="ink-block tilt-l rise flex shrink-0 flex-col items-center gap-2 p-5 text-center">
          <span className="trophy-bounce text-foreground">
            <Trophy className="h-10 w-10" />
          </span>
          <span className="font-display text-3xl font-black">Game over</span>
          {winner && (
            <span className="font-hand text-2xl leading-tight text-muted">
              winner:{" "}
              <span
                dir="auto"
                className="font-display text-xl font-black text-foreground"
              >
                {winner.name}
              </span>{" "}
              with {winner.score ?? 0} pts
            </span>
          )}
        </div>
        <Panel className="lg:flex-1" title="Final scores">
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
    <div className="flex flex-col gap-6 lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[1.05fr_0.95fr]">
      {/* left: share the code + see who's in */}
      <div className="flex min-h-0 flex-col gap-5">
        <Suspense fallback={null}>
          <CodeCard code={code} />
        </Suspense>
        <Panel
          className="lg:flex-1"
          title="In the lobby"
          aside={
            <span
              className="sticker px-2.5 py-0.5 font-mono text-sm text-foreground"
              style={{ "--rot": "2.5deg" } as React.CSSProperties}
            >
              {players.length} {players.length === 1 ? "player" : "players"}
            </span>
          }
        >
          <PlayerGrid players={players} />
        </Panel>
      </div>

      {/* right: settings + start */}
      <div className="flex min-h-0 flex-col gap-5">
        <div className="flex flex-col lg:min-h-0 lg:flex-1">
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
  const drawMs = useGameStore((s) => s.drawMs);
  const remaining = useCountdown(endsAt);
  const drawn = players.filter((p) => p.locked).length;

  return (
    <div className="flex flex-col gap-5 lg:h-full lg:min-h-0">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex flex-col items-start gap-1.5">
          <span
            className="sticker px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-widest text-foreground"
            style={{ "--rot": "-2deg" } as React.CSSProperties}
          >
            ✎ everyone's drawing
          </span>
          <span
            dir="auto"
            className="font-display text-3xl font-black sm:text-4xl"
          >
            {prompt || "…"}
          </span>
        </div>
        <Timer remaining={remaining} total={Math.round(drawMs / 1000)} />
      </div>
      <Panel
        className="lg:flex-1"
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
  const guessMs = useGameStore((s) => s.guessMs);
  const featureIndex = useGameStore((s) => s.featureIndex);
  const featureCount = useGameStore((s) => s.featureCount);
  const remaining = useCountdown(endsAt);
  const mode = useGameStore((s) => s.mode);
  const target = useGameStore((s) => s.target);
  const pool = useGameStore((s) => s.pool);

  if (mode === "flipped") {
    return (
      <FlippedGuessing
        target={target}
        pool={pool}
        remaining={remaining}
        guessMs={guessMs}
        featureIndex={featureIndex}
        featureCount={featureCount}
      />
    );
  }

  const guessed = players.filter((p) => p.hasGuessed).length;
  // The artist is excluded from guessing, so exactly one player never guesses.
  // Count against the non-artist total so the tally tops out cleanly and never
  // singles the artist out.
  const eligible = Math.max(players.length - 1, 0);

  return (
    <div className="flex flex-col gap-6 lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[1.6fr_1fr]">
      <div className="flex min-h-0 flex-col gap-4">
        <div className="flex shrink-0 items-center justify-between gap-3">
          <div className="flex flex-col gap-2">
            <h2 className="ink-underline w-fit font-display text-2xl font-black sm:text-3xl">
              Who drew this?
            </h2>
            <FeatureProgress index={featureIndex} count={featureCount} />
          </div>
          <Timer remaining={remaining} total={Math.round(guessMs / 1000)} />
        </div>
        {/* taped up like a poster; keyed by which drawing is on show so each new
            featured drawing wipes up into focus instead of swapping in place */}
        <div
          key={featureIndex}
          className={`tape reveal-clip aspect-4/3 lg:aspect-auto lg:min-h-0 lg:flex-1 ${HOST_CANVAS_BOX}`}
        >
          <StrokesView strokes={drawing} className={HOST_CANVAS} />
        </div>
      </div>
      <Panel
        className="lg:flex-1"
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
  const featureIndex = useGameStore((s) => s.featureIndex);
  const featureCount = useGameStore((s) => s.featureCount);
  // Artists already revealed this round — only their names are shown in the
  // gallery while drawings remain to be guessed, so later guesses aren't spoiled.
  const roundFeatured = useGameStore((s) => s.roundFeatured);
  // On the round's final reveal there's nothing left to guess, so every drawing
  // gets attributed — no drawing is left anonymous once the round is done.
  const roundComplete = featureCount > 0 && featureIndex >= featureCount;
  // More drawings still to guess this round → the host moves to the next one;
  // otherwise it's the last round's end, or simply the next round.
  const moreDrawings = featureIndex < featureCount;
  const isLast = round >= totalRounds;
  const nextLabel = moreDrawings
    ? "Next drawing →"
    : isLast
      ? "See final results →"
      : "Next round →";
  const correct = players.filter((p) => p.correct);
  // A round where nobody drew anything skips guessing and lands here with no
  // artist — show a "nobody drew" message instead of a blank canvas.
  const noArtist = !reveal?.artist;

  return (
    <div className="flex flex-col gap-6 lg:grid lg:h-full lg:min-h-0 lg:grid-cols-[1.6fr_1fr]">
      {noArtist ? (
        <div
          className={`flex min-h-64 flex-col items-center justify-center gap-3 p-8 text-center lg:min-h-0 ${HOST_CANVAS_BOX}`}
        >
          <Brush className="h-12 w-12 text-muted" />
          <p className="font-display text-2xl font-black">
            Nobody drew anything
          </p>
          <p className="font-hand text-xl text-muted">
            everyone ran out of time or left the canvas blank.
          </p>
        </div>
      ) : (
        // min-w-0 lets this column shrink to its grid track instead of growing to
        // fit every gallery tile — without it, a full room's worth of drawings
        // would widen the track and shove the leaderboard off the screen edge.
        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          <div
            key={featureIndex}
            className={`tape reveal-clip aspect-4/3 lg:aspect-auto lg:min-h-0 lg:flex-1 ${HOST_CANVAS_BOX}`}
          >
            <StrokesView strokes={drawing} className={HOST_CANVAS} />
          </div>
          {Object.keys(gallery).length > 0 && (
            <div className="min-w-0 shrink-0">
              <span className="font-hand text-xl text-muted">
                everyone's drawings
              </span>
              {/* Pinned-up polaroids: each tilts a touch; the featured one inks
                  its frame solid. A drawing only shows its artist once it has been
                  guessed this round — the rest keep the name scribbled out so the
                  later guesses stay a mystery. Scrolled horizontally so a full
                  room fits. */}
              <ul className="mt-2 flex snap-x gap-3 overflow-x-auto overflow-y-hidden px-1 pb-3 pt-1">
                {Object.entries(gallery).map(([artist, strokes], i) => {
                  const isFeatured = artist === reveal?.artist;
                  const revealed =
                    roundComplete ||
                    isFeatured ||
                    roundFeatured.includes(artist);
                  return (
                    <li
                      key={artist}
                      className={`shrink-0 snap-start rounded-lg border-2 bg-surface p-1.5 transition-transform ${
                        isFeatured
                          ? "border-foreground shadow-[4px_5px_0_0_var(--ink-edge)]"
                          : "border-border"
                      } ${i % 2 === 0 ? "rotate-2" : "-rotate-2"}`}
                    >
                      <StrokesView
                        strokes={strokes}
                        className="aspect-4/3 w-32 rounded border border-border bg-surface"
                      />
                      {revealed ? (
                        <span
                          dir="auto"
                          className="mt-1 block max-w-32 truncate text-center font-hand text-lg leading-none"
                        >
                          {artist}
                        </span>
                      ) : (
                        <Scribble
                          seed={artist}
                          className="mx-auto mt-1.5 block h-4 w-28 text-muted"
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-col gap-4">
        <FeatureProgress
          index={featureIndex}
          count={featureCount}
          className="shrink-0 justify-center"
        />
        <div className="ink-block tilt-r rise flex shrink-0 flex-col gap-1 p-5 text-center">
          {noArtist ? (
            <>
              <span className="font-display text-2xl font-black">
                No drawing this round
              </span>
              {reveal?.prompt && (
                <span dir="auto" className="font-hand text-xl text-muted">
                  the word was: {reveal.prompt}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="font-hand text-xl text-muted">
                it was drawn by
              </span>
              <span dir="auto" className="font-display text-3xl font-black">
                {reveal?.artist ?? "—"}
              </span>
              {reveal?.prompt && (
                <span
                  dir="auto"
                  className="sticker mx-auto w-fit px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted"
                  style={{ "--rot": "-2deg" } as React.CSSProperties}
                >
                  word: {reveal.prompt}
                </span>
              )}
              <span className="mt-2 font-hand text-xl">
                {correct.length === 0
                  ? "nobody guessed right!"
                  : `${correct.length} guessed it: `}
                <span dir="auto" className="font-display text-base font-black">
                  {correct.map((p) => p.name).join(", ")}
                </span>
              </span>
            </>
          )}
        </div>

        <Panel className="lg:flex-1" title="Leaderboard">
          <Scoreboard players={players} />
        </Panel>

        <button
          type="button"
          className="btn-key w-full shrink-0 px-6 py-4 text-lg"
          onClick={actions.nextPhase}
        >
          {nextLabel}
        </button>
      </div>
    </div>
  );
}
