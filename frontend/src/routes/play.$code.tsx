import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useGameSocket } from "@/hooks/use-game-socket";
import { recallName } from "@/lib/identity";
import { avatarColor, initials } from "@/lib/avatar";
import { useGameStore } from "@/lib/store";

export const Route = createFileRoute("/play/$code")({
  component: Play,
});

function Play() {
  const { code } = Route.useParams();
  const name = recallName();
  const { start, nextPhase, submitAnswer } = useGameSocket(code, name);
  const phase = useGameStore((s) => s.phase);
  const players = useGameStore((s) => s.players);
  const error = useGameStore((s) => s.error);
  const host = useGameStore((s) => s.host);

  const [answer, setAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const isHost = name === host;

  if (!name) return <Navigate to="/" />;
  if (error) return <ErrorPanel message={error} />;

  const send = () => {
    if (!answer.trim()) return;
    submitAnswer(answer.trim());
    setSubmitted(true);
  };

  return (
    <main className="grain-above mx-auto flex min-h-dvh w-full max-w-md flex-col gap-8 px-6 py-10">
      <header className="rise flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className="flex h-11 w-11 items-center justify-center rounded-xl font-display text-sm font-bold text-background"
            style={{ backgroundColor: avatarColor(name) }}
          >
            {initials(name)}
          </span>
          <div className="flex flex-col">
            <span className="font-display text-lg font-bold leading-tight">
              {name}
            </span>
            <span className="font-mono text-xs uppercase tracking-widest text-muted">
              room {code}
            </span>
          </div>
        </div>
        <span className="flex items-center gap-2 rounded-full border border-border bg-surface-2 px-3 py-1.5">
          <span className="live-dot h-2 w-2 rounded-full bg-primary" />
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            {phase}
          </span>
        </span>
      </header>

      <section
        className="rise flex flex-1 flex-col"
        style={{ "--d": "80ms" } as React.CSSProperties}
      >
        {phase === "lobby" && <Waiting count={players.length} />}

        {phase === "inRound" &&
          (submitted ? (
            <Locked answer={answer} />
          ) : (
            <div className="card-arcade flex flex-col gap-5 p-6">
              <h2 className="font-display text-2xl font-bold">Your answer</h2>
              <input
                className="field px-4 py-3.5"
                value={answer}
                placeholder="type something brilliant…"
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
              />
              <button
                type="button"
                className="btn-key w-full px-6 py-4 text-lg"
                onClick={send}
                disabled={!answer.trim()}
              >
                Lock it in
              </button>
            </div>
          ))}

        {phase === "reveal" && <Reveal />}

        {phase === "ended" && (
          <div className="card-arcade flex flex-col items-center gap-3 p-8 text-center">
            <span className="text-4xl">🎉</span>
            <h2 className="font-display text-2xl font-bold">Game over</h2>
            <p className="text-sm text-muted">Thanks for playing, {name}.</p>
          </div>
        )}
      </section>

      {isHost && (
        <footer className="mt-auto flex flex-col gap-3 pt-2">
          {phase === "lobby" && (
            <button
              type="button"
              className="btn-key w-full px-6 py-4 text-lg"
              onClick={start}
              disabled={players.length === 0}
            >
              {players.length === 0 ? "Waiting for players…" : "Start the game →"}
            </button>
          )}
          {(phase === "inRound" || phase === "reveal") && (
            <button
              type="button"
              className="btn-key btn-key--pink w-full px-6 py-4 text-lg"
              onClick={nextPhase}
            >
              {phase === "inRound" ? "Reveal answers →" : "Next round →"}
            </button>
          )}
        </footer>
      )}
    </main>
  );
}

function Waiting({ count }: { count: number }) {
  return (
    <div className="card-arcade flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
      <span className="font-display text-3xl font-bold">You're in!</span>
      <p className="flex items-center gap-2 text-muted">
        Waiting for the host to start
        <span className="live-dot text-primary">●</span>
      </p>
      <span className="mt-2 font-mono text-xs uppercase tracking-widest text-muted">
        {count} {count === 1 ? "player" : "players"} in the room
      </span>
    </div>
  );
}

function Locked({ answer }: { answer: string }) {
  return (
    <div className="card-arcade flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
      <span className="text-3xl">🔒</span>
      <h2 className="font-display text-xl font-bold">Answer locked</h2>
      <p className="rounded-xl bg-surface-2 px-4 py-2 font-mono text-sm text-primary">
        {answer}
      </p>
      <p className="text-sm text-muted">Hang tight for the reveal.</p>
    </div>
  );
}

function Reveal() {
  const players = useGameStore((s) => s.players);
  const answered = players.filter((p) => p.answer);
  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-display text-2xl font-bold">The reveal</h2>
      {answered.length === 0 ? (
        <p className="text-sm text-muted">No answers came in this round.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {answered.map((p) => (
            <li
              key={p.name}
              className="card-arcade flex items-center gap-3 p-4"
            >
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-display text-xs font-bold text-background"
                style={{ backgroundColor: avatarColor(p.name) }}
              >
                {initials(p.name)}
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                  {p.name}
                </span>
                <span className="truncate font-semibold">{p.answer}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ErrorPanel({ message }: { message: string }) {
  const navigate = useNavigate();
  return (
    <main className="grain-above mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="card-arcade rise flex flex-col items-center gap-4 p-8">
        <span className="text-4xl">🚫</span>
        <h1 className="font-display text-2xl font-bold">{message}</h1>
        <button
          type="button"
          className="btn-key px-6 py-3"
          onClick={() => navigate({ to: "/" })}
        >
          Back to start
        </button>
      </div>
    </main>
  );
}
