import type { Player } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";
import { Avatar, Check, Crown } from "../icons";

// Scoreboard ranks players by score, marking the leader and correct guessers.
export function Scoreboard({ players }: { players: Player[] }) {
  const host = useGameStore((s) => s.host);
  const ranked = [...players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return (
    <ol className="flex flex-col gap-2">
      {ranked.map((p, i) => {
        const top = i === 0;
        return (
          <li
            key={p.name}
            className={`card-arcade pop flex items-center gap-3 p-3 ${
              top ? "border-foreground" : ""
            }`}
            style={{ "--d": `${i * 45}ms` } as React.CSSProperties}
          >
            {/* rank stamped into a ringed disc — #1 inks solid */}
            <span
              className={`flex h-7 w-7 shrink-0 -rotate-3 items-center justify-center rounded-full border-2 border-foreground font-display text-sm font-black ${
                top ? "bg-foreground text-background" : "text-foreground"
              }`}
            >
              {i + 1}
            </span>
            <Avatar
              name={p.name}
              className="h-9 w-9 -rotate-2 rounded-lg border-2 border-foreground"
            />
            <span
              dir="auto"
              className="flex min-w-0 flex-1 items-center gap-1.5 font-bold"
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
              <span
                className="sticker sticker-solid stick-on px-1.5 py-0.5 font-mono text-[11px] font-bold"
                style={{ "--rot": "3deg" } as React.CSSProperties}
              >
                +{p.roundScore}
              </span>
            )}
            <span className="font-display text-base font-black text-foreground">
              {p.score ?? 0}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// LeaderBadge marks the current host/leader wherever players are listed.
export function LeaderBadge() {
  return (
    <span
      title="leader"
      className="sticker px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-foreground"
      style={{ "--rot": "-3deg" } as React.CSSProperties}
    >
      <Crown className="h-3 w-3" /> leader
    </span>
  );
}
