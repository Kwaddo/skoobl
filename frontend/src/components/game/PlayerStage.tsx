import { useCallback, useEffect, useRef, useState } from "react";
import { useCountdown } from "@/hooks/use-countdown";
import type { GameActions } from "@/hooks/use-game-socket";
import type { Stroke } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";
import { DrawingCanvas } from "./DrawingCanvas";
import { ArrowUp, Avatar, Brush, Check, Cross, Lock } from "./icons";
import { EndedStage, PlayerGrid, Timer } from "./shared";

// PlayerStage is the phone controller. It owns the canvas (drawing) and the
// pick list (guessing); it never renders the drawing — players look at the host
// screen for that.
export function PlayerStage({
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
      return <PlayerLobby />;
    case "drawing":
      return <PlayerDrawing key={round} actions={actions} />;
    case "guessing":
      return <PlayerGuessing key={round} name={name} actions={actions} />;
    case "reveal":
      return <PlayerReveal name={name} />;
    case "ended":
      return <EndedStage name={name} />;
    default:
      return null;
  }
}

function PlayerLobby() {
  const players = useGameStore((s) => s.players);
  return (
    <div className="m-auto flex w-full max-h-full min-h-0 flex-col gap-5">
      <p className="shrink-0 rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted">
        You're in! Waiting for the host to start
        <span className="live-dot ml-1 text-primary">●</span>
      </p>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mb-3 flex shrink-0 items-baseline justify-between">
          <h2 className="font-display text-xl font-bold">Players</h2>
          <span className="font-mono text-sm text-muted">{players.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto pr-1">
          <PlayerGrid players={players} />
        </div>
      </div>
    </div>
  );
}

function PlayerDrawing({ actions }: { actions: GameActions }) {
  const prompt = useGameStore((s) => s.yourPrompt);
  const endsAt = useGameStore((s) => s.phaseEndsAt);
  const players = useGameStore((s) => s.players);
  const remaining = useCountdown(endsAt);
  const [submitted, setSubmitted] = useState(false);
  const strokesRef = useRef<Stroke[]>([]);

  const submit = useCallback(() => {
    setSubmitted((was) => {
      if (!was) actions.submitDrawing(strokesRef.current);
      return true;
    });
  }, [actions]);

  // Auto-submit whatever is on the canvas when the clock runs out.
  useEffect(() => {
    if (remaining === 0 && !submitted) submit();
  }, [remaining, submitted, submit]);

  const drawn = players.filter((p) => p.hasDrawn).length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            Draw this
          </span>
          <span
            dir="auto"
            className="font-display text-2xl font-bold text-primary"
          >
            {prompt || "…"}
          </span>
        </div>
        <Timer remaining={remaining} />
      </div>

      {submitted ? (
        <div className="card-arcade rise flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
          <Lock className="float h-9 w-9 text-foreground" />
          <h2 className="font-display text-xl font-bold">Drawing locked in</h2>
          <p className="text-sm text-muted">
            {drawn} of {players.length} done — look at the screen…
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <DrawingCanvas
            onChange={(s) => {
              strokesRef.current = s;
            }}
            footer={
              <button
                type="button"
                className="btn-key w-full px-6 py-4 text-lg short:px-3 short:py-2.5 short:text-sm"
                onClick={submit}
              >
                Lock in my drawing →
              </button>
            }
          />
        </div>
      )}
    </div>
  );
}

function PlayerGuessing({
  name,
  actions,
}: {
  name: string;
  actions: GameActions;
}) {
  const youAreArtist = useGameStore((s) => s.youAreArtist);
  const yourGuess = useGameStore((s) => s.yourGuess);
  const players = useGameStore((s) => s.players);
  const endsAt = useGameStore((s) => s.phaseEndsAt);
  const remaining = useCountdown(endsAt);

  // Only players who actually drew something this round can be the artist, so
  // they're the only ones worth voting for (non-drawers are excluded).
  const options = players.filter((p) => p.name !== name && p.hasDrawn);

  return (
    <div className="m-auto flex w-full max-h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex flex-col">
          <h2 className="font-display text-2xl font-bold">Who drew it?</h2>
          <span className="flex items-center gap-1 text-sm text-muted">
            Look up at the screen
            <ArrowUp className="h-4 w-4 text-foreground" />
          </span>
        </div>
        <Timer remaining={remaining} />
      </div>

      {youAreArtist ? (
        <p className="card-arcade flex items-center justify-center gap-2 px-5 py-6 text-center text-sm text-muted">
          <Brush className="h-4 w-4 shrink-0 text-foreground" />
          This one's yours — sit tight while everyone guesses.
        </p>
      ) : yourGuess ? (
        <p className="card-arcade px-5 py-6 text-center">
          You guessed{" "}
          <span dir="auto" className="font-display font-bold text-primary">
            {yourGuess}
          </span>
          . Waiting for the reveal…
        </p>
      ) : (
        <ul className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-auto pr-1 sm:grid-cols-3">
          {options.map((p) => (
            <li key={p.name}>
              <button
                type="button"
                onClick={() => actions.submitGuess(p.name)}
                className="card-arcade card-hover flex h-full w-full items-center gap-2 p-3 text-left"
              >
                <Avatar name={p.name} className="h-9 w-9 rounded-lg" />
                <span dir="auto" className="truncate font-semibold">
                  {p.name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlayerReveal({ name }: { name: string }) {
  const reveal = useGameStore((s) => s.reveal);
  const players = useGameStore((s) => s.players);
  const me = players.find((p) => p.name === name);
  const noArtist = !reveal?.artist;
  const youAreArtist = reveal?.artist === name;
  const got = me?.correct ?? false;

  return (
    <div className="m-auto flex w-full max-h-full min-h-0 flex-col gap-4">
      <div className="card-arcade rise flex flex-col items-center gap-3 p-10 text-center">
        {noArtist ? (
          <>
            <Brush className="h-16 w-16 text-muted" />
            <h2 className="font-display text-3xl font-bold">No drawing</h2>
            <p className="text-base text-muted">
              Nobody drew anything this round.
            </p>
          </>
        ) : (
          <>
            <span className="trophy-bounce text-foreground">
              {youAreArtist ? (
                <Brush className="h-16 w-16" />
              ) : got ? (
                <Check className="h-16 w-16" />
              ) : (
                <Cross className="h-16 w-16" />
              )}
            </span>
            <h2 className="font-display text-3xl font-bold">
              {youAreArtist
                ? "That was your drawing!"
                : got
                  ? "Nice — you got it!"
                  : "Not this time"}
            </h2>
            <p className="text-base text-muted">
              It was drawn by{" "}
              <span dir="auto" className="font-semibold text-primary">
                {reveal?.artist ?? "—"}
              </span>
            </p>
            <p className="mt-1 font-mono text-2xl font-bold text-primary">
              {me?.roundScore != null && me.roundScore > 0 && (
                <span className="mr-2">+{me.roundScore}</span>
              )}
              {me?.score ?? 0} pts
            </p>
          </>
        )}
      </div>
      <p className="text-center text-sm text-muted">
        Waiting for the host to continue
        <span className="live-dot ml-1 text-primary">●</span>
      </p>
    </div>
  );
}
