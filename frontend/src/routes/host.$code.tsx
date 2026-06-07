import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useGameSocket } from "@/hooks/use-game-socket";
import { recallName } from "@/lib/identity";
import { avatarColor, initials } from "@/lib/avatar";
import type { Player } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";

export const Route = createFileRoute("/host/$code")({
  component: Host,
});

function Host() {
  const { code } = Route.useParams();
  const name = recallName();
  const { start, nextPhase } = useGameSocket(code, name);
  const phase = useGameStore((s) => s.phase);
  const players = useGameStore((s) => s.players);
  const host = useGameStore((s) => s.host);
  const error = useGameStore((s) => s.error);

  if (!name) return <Navigate to="/" />;
  if (error) return <ErrorPanel message={error} />;

  return (
    <main className="grain-above mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-8 px-6 py-10">
      <RoomBar code={code} count={players.length} phase={phase} />

      <section
        className="rise"
        style={{ "--d": "80ms" } as React.CSSProperties}
      >
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="font-display text-2xl font-bold">In the lobby</h2>
          <span className="font-mono text-sm text-muted">
            {players.length} {players.length === 1 ? "player" : "players"}
          </span>
        </div>

        {players.length === 0 ? (
          <EmptyLobby />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {players.map((p, i) => (
              <PlayerChip
                key={p.name}
                player={p}
                isHost={p.name === host}
                index={i}
              />
            ))}
          </ul>
        )}
      </section>

      <footer className="mt-auto flex flex-col gap-3 pt-4">
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
        {phase === "ended" && (
          <div className="card-arcade px-6 py-5 text-center font-display text-xl font-bold">
            That's a wrap! 🎉
          </div>
        )}
      </footer>
    </main>
  );
}

function RoomBar({
  code,
  count,
  phase,
}: {
  code: string;
  count: number;
  phase: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <header className="rise card-arcade flex flex-wrap items-center justify-between gap-4 p-5">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-xs uppercase tracking-widest text-muted">
          Room code
        </span>
        <button
          type="button"
          onClick={copy}
          className="group flex items-center gap-3 text-left"
          title="Copy code"
        >
          <span className="font-mono text-4xl font-bold uppercase tracking-[0.2em] text-primary">
            {code}
          </span>
          <span className="rounded-lg border border-border px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors group-hover:border-primary group-hover:text-primary">
            {copied ? "copied!" : "copy"}
          </span>
        </button>
      </div>
      <div className="flex items-center gap-2 rounded-full border border-border bg-surface-2 px-3 py-1.5">
        <span className="live-dot h-2 w-2 rounded-full bg-primary" />
        <span className="font-mono text-xs uppercase tracking-widest text-muted">
          {phase} · {count} in
        </span>
      </div>
    </header>
  );
}

function PlayerChip({
  player,
  isHost,
  index,
}: {
  player: Player;
  isHost: boolean;
  index: number;
}) {
  const color = avatarColor(player.name);
  return (
    <li
      className="rise card-arcade flex items-center gap-3 p-3"
      style={{ "--d": `${120 + index * 45}ms` } as React.CSSProperties}
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl font-display text-sm font-bold text-background"
        style={{ backgroundColor: color }}
      >
        {initials(player.name)}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-semibold">{player.name}</span>
        {isHost && (
          <span className="font-mono text-[10px] uppercase tracking-widest text-primary">
            host
          </span>
        )}
      </span>
    </li>
  );
}

function EmptyLobby() {
  return (
    <div className="card-arcade flex flex-col items-center gap-2 border-dashed px-6 py-12 text-center">
      <span className="live-dot text-3xl">👀</span>
      <p className="font-display text-lg font-bold">Nobody here yet</p>
      <p className="max-w-xs text-sm text-muted">
        Share the room code above. Players who join pop up here instantly.
      </p>
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
