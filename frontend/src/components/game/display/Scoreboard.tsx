import type { Player } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";
import { Avatar, Check, Crown } from "../icons";

// Scoreboard ranks players by score, marking the leader and correct guessers.
export function Scoreboard({ players }: { players: Player[] }) {
  const host = useGameStore((s) => s.host);
  const ranked = [...players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return (
    <ol className="flex flex-col gap-2">
      {ranked.map((p, i) => (
        <li
          key={p.name}
          className="card-arcade pop flex items-center gap-3 p-3"
          style={{ "--d": `${i * 45}ms` } as React.CSSProperties}
        >
          <span className="w-6 text-center font-display text-sm font-bold text-muted">
            {i + 1}
          </span>
          <Avatar name={p.name} className="h-9 w-9 rounded-lg" />
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
          {p.correct && <Check className="h-4 w-4 text-foreground" />}
          {p.roundScore != null && p.roundScore > 0 && (
            <span className="font-mono text-xs font-bold text-primary">
              +{p.roundScore}
            </span>
          )}
          <span className="font-mono text-sm font-bold text-foreground">
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
      className="flex items-center gap-1 rounded-full border border-foreground/40 bg-foreground/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-foreground"
    >
      <Crown className="h-3 w-3" /> leader
    </span>
  );
}
