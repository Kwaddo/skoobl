import { useCallback, useEffect, useRef, useState } from "react";
import { useCountdown } from "@/hooks/use-countdown";
import type { GameActions } from "@/hooks/use-game-socket";
import { avatarColor, avatarEmoji } from "@/lib/avatar";
import type { Stroke } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";
import { DrawingCanvas } from "./DrawingCanvas";
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
    <div className="flex flex-col gap-6">
      <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted">
        You're in! Waiting for the host to start
        <span className="live-dot ml-1 text-primary">●</span>
      </p>
      <div>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-xl font-bold">Players</h2>
          <span className="font-mono text-sm text-muted">{players.length}</span>
        </div>
        <PlayerGrid players={players} />
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
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
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
        <div className="card-arcade flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
          <span className="text-3xl">🔒</span>
          <h2 className="font-display text-xl font-bold">Drawing locked in</h2>
          <p className="text-sm text-muted">
            {drawn} of {players.length} done — look at the screen…
          </p>
        </div>
      ) : (
        <>
          <DrawingCanvas
            onChange={(s) => {
              strokesRef.current = s;
            }}
          />
          <button
            type="button"
            className="btn-key w-full px-6 py-4 text-lg"
            onClick={submit}
          >
            Lock in my drawing →
          </button>
        </>
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

  const options = players.filter((p) => p.name !== name);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <h2 className="font-display text-2xl font-bold">Who drew it?</h2>
          <span className="text-sm text-muted">Look up at the screen 👆</span>
        </div>
        <Timer remaining={remaining} />
      </div>

      {youAreArtist ? (
        <p className="card-arcade px-5 py-6 text-center text-sm text-muted">
          This one's yours 🎨 — sit tight while everyone guesses.
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
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {options.map((p) => (
            <li key={p.name}>
              <button
                type="button"
                onClick={() => actions.submitGuess(p.name)}
                className="card-arcade flex w-full items-center gap-2 p-3 text-left transition-transform hover:-translate-y-0.5 hover:border-primary"
              >
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg"
                  style={{ backgroundColor: avatarColor(p.name) }}
                >
                  {avatarEmoji(p.name)}
                </span>
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
  const youAreArtist = reveal?.artist === name;
  const got = me?.correct ?? false;

  return (
    <div className="flex flex-col gap-4">
      <div className="card-arcade flex flex-col items-center gap-2 p-8 text-center">
        <span className="text-4xl">
          {youAreArtist ? "🎨" : got ? "✅" : "❌"}
        </span>
        <h2 className="font-display text-xl font-bold">
          {youAreArtist
            ? "That was your drawing!"
            : got
              ? "Nice — you got it!"
              : "Not this time"}
        </h2>
        <p className="text-sm text-muted">
          It was drawn by{" "}
          <span dir="auto" className="font-semibold text-primary">
            {reveal?.artist ?? "—"}
          </span>
        </p>
        <p className="mt-1 font-mono text-sm font-bold text-primary">
          {me?.score ?? 0} pts
        </p>
      </div>
      <p className="text-center text-sm text-muted">
        Waiting for the host to continue
        <span className="live-dot ml-1 text-primary">●</span>
      </p>
    </div>
  );
}
