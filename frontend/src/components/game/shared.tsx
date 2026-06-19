import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { avatarColor, avatarEmoji } from "@/lib/avatar";
import type { Player } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";

// RoomHeader is the persistent top bar: who you are, the room code, the live
// phase, and a Leave button. Shared by the host and player screens.
export function RoomHeader({
  code,
  name,
  onLeave,
}: {
  code: string;
  name: string;
  onLeave: () => void;
}) {
  const phase = useGameStore((s) => s.phase);
  const round = useGameStore((s) => s.round);
  const totalRounds = useGameStore((s) => s.totalRounds);
  return (
    <header className="rise flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span
          className="flex h-11 w-11 items-center justify-center rounded-xl text-2xl"
          style={{ backgroundColor: avatarColor(name) }}
        >
          {avatarEmoji(name)}
        </span>
        <div className="flex flex-col">
          <span
            dir="auto"
            className="font-display text-lg font-bold leading-tight"
          >
            {name}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            room {code}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden items-center gap-2 rounded-full border border-border bg-surface-2 px-3 py-1.5 sm:flex">
          <span className="live-dot h-2 w-2 rounded-full bg-primary" />
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            {phase === "lobby" || phase === "ended"
              ? phase
              : `round ${round}/${totalRounds} · ${phase}`}
          </span>
        </span>
        <button
          type="button"
          onClick={onLeave}
          className="btn-ghost px-3 py-1.5 text-sm"
          title="Leave the room"
        >
          Leave
        </button>
      </div>
    </header>
  );
}

// CodeCard shows the room code with a copy button — for sharing from the lobby.
export function CodeCard({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="card-arcade flex items-center justify-between gap-4 p-5">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-xs uppercase tracking-widest text-muted">
          Room code
        </span>
        <button
          type="button"
          onClick={copy}
          className="group flex items-center gap-3 text-left"
        >
          <span className="font-mono text-3xl font-bold uppercase tracking-[0.2em] text-primary">
            {code}
          </span>
          <span className="rounded-lg border border-border px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors group-hover:border-primary group-hover:text-primary">
            {copied ? "copied!" : "copy"}
          </span>
        </button>
      </div>
    </div>
  );
}

// Scoreboard ranks players by score, marking the leader and correct guessers.
export function Scoreboard({ players }: { players: Player[] }) {
  const host = useGameStore((s) => s.host);
  const ranked = [...players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return (
    <ol className="flex flex-col gap-2">
      {ranked.map((p, i) => (
        <li key={p.name} className="card-arcade flex items-center gap-3 p-3">
          <span className="w-6 text-center font-display text-sm font-bold text-muted">
            {i + 1}
          </span>
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg"
            style={{ backgroundColor: avatarColor(p.name) }}
          >
            {avatarEmoji(p.name)}
          </span>
          <span
            dir="auto"
            className="flex min-w-0 flex-1 items-center gap-1.5 font-semibold"
          >
            <span className="truncate">{p.name}</span>
            {p.name === host && <LeaderBadge />}
            {p.connected === false && (
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                away
              </span>
            )}
          </span>
          {p.correct && (
            <span
              title="guessed correctly"
              className="text-base font-bold text-[#7CFF6B]"
            >
              ✓
            </span>
          )}
          <span className="font-mono text-sm font-bold text-primary">
            {p.score ?? 0}
          </span>
        </li>
      ))}
    </ol>
  );
}

// LeaderBadge marks the current host/leader wherever players are listed.
export function LeaderBadge() {
  return (
    <span
      title="leader"
      className="flex items-center gap-1 rounded-full border border-primary/50 bg-primary/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-primary"
    >
      👑 leader
    </span>
  );
}

// PlayerGrid lists everyone in the room (used in the lobby).
export function PlayerGrid({ players }: { players: Player[] }) {
  const host = useGameStore((s) => s.host);
  if (players.length === 0) {
    return (
      <div className="card-arcade flex flex-col items-center gap-2 border-dashed px-6 py-10 text-center">
        <span className="live-dot text-3xl">👀</span>
        <p className="font-display text-lg font-bold">Nobody here yet</p>
        <p className="text-sm text-muted">
          Share the code above to fill the room.
        </p>
      </div>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {players.map((p) => (
        <li key={p.name} className="card-arcade flex items-center gap-3 p-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-2xl"
            style={{ backgroundColor: avatarColor(p.name) }}
          >
            {avatarEmoji(p.name)}
          </span>
          <span className="flex min-w-0 flex-col">
            <span dir="auto" className="truncate font-semibold">
              {p.name}
            </span>
            {p.name === host && (
              <span className="font-mono text-[10px] uppercase tracking-widest text-primary">
                👑 leader
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

// Roster shows each player's per-phase status for the host display: who has
// finished drawing (drawing phase) or who has guessed (guessing phase).
export function Roster({
  players,
  mode,
}: {
  players: Player[];
  mode: "drawing" | "guessing";
}) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {players.map((p) => {
        const done = mode === "drawing" ? p.hasDrawn : p.hasGuessed;
        const doneLabel = mode === "drawing" ? "✓ done" : "✓ guessed";
        const waitLabel = mode === "drawing" ? "drawing…" : "thinking…";
        return (
          <li
            key={p.name}
            className={`card-arcade flex items-center gap-3 p-3 transition-colors ${
              done ? "border-primary" : "opacity-70"
            }`}
          >
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-2xl"
              style={{ backgroundColor: avatarColor(p.name) }}
            >
              {avatarEmoji(p.name)}
            </span>
            <span className="flex min-w-0 flex-col">
              <span dir="auto" className="truncate font-semibold">
                {p.name}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                {done ? doneLabel : waitLabel}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// Timer renders the remaining seconds, turning urgent under 5s.
export function Timer({ remaining }: { remaining: number | null }) {
  if (remaining === null) return null;
  const low = remaining <= 5;
  return (
    <span
      className={`flex h-12 w-12 items-center justify-center rounded-xl border-2 font-mono text-lg font-bold ${
        low
          ? "border-secondary text-secondary"
          : "border-border text-foreground"
      }`}
    >
      {remaining}
    </span>
  );
}

// EndedStage is the final results screen, shared by host and players. Only the
// host gets the "Play again" control (via onPlayAgain), which sends the whole
// room back to the lobby — nobody is kicked out. Players just wait for it.
export function EndedStage({
  name,
  onPlayAgain,
}: {
  name: string;
  onPlayAgain?: () => void;
}) {
  const players = useGameStore((s) => s.players);
  const ranked = [...players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const winner = ranked[0];
  const youWon = winner?.name === name;

  return (
    <div className="flex flex-col gap-5">
      <div className="card-arcade flex flex-col items-center gap-2 p-8 text-center">
        <span className="text-4xl">{youWon ? "🏆" : "🎉"}</span>
        <h2 className="font-display text-2xl font-bold">Game over</h2>
        {winner && (
          <p className="text-sm text-muted">
            Winner:{" "}
            <span dir="auto" className="font-display font-bold text-primary">
              {winner.name}
            </span>{" "}
            with {winner.score ?? 0} pts
          </p>
        )}
      </div>

      <Scoreboard players={players} />

      {onPlayAgain ? (
        <button
          type="button"
          className="btn-key w-full px-6 py-4 text-lg"
          onClick={onPlayAgain}
        >
          Play again →
        </button>
      ) : (
        <p className="text-center text-sm text-muted">
          Waiting for the host to start a new game
          <span className="live-dot ml-1 text-primary">●</span>
        </p>
      )}
    </div>
  );
}

// ErrorPanel is the full-screen error fallback (bad room, server unreachable).
export function ErrorPanel({ message }: { message: string }) {
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
