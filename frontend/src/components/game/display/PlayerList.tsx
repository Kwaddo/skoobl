import type { Player } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";
import { Avatar, Check, Crown, Eyes } from "../icons";

// PlayerGrid lists everyone in the room (used in the lobby).
export function PlayerGrid({ players }: { players: Player[] }) {
  const host = useGameStore((s) => s.host);
  if (players.length === 0) {
    return (
      <div className="card-arcade flex flex-col items-center gap-2 border-dashed px-6 py-10 text-center">
        <Eyes className="float h-9 w-9 text-foreground" />
        <p className="font-display text-lg font-bold">Nobody here yet</p>
        <p className="text-sm text-muted">
          Share the code above to fill the room.
        </p>
      </div>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {players.map((p, i) => (
        <li
          key={p.name}
          className="card-arcade card-hover pop flex items-center gap-3 p-3"
          style={{ "--d": `${i * 40}ms` } as React.CSSProperties}
        >
          <Avatar name={p.name} className="h-10 w-10 rounded-xl" />
          <span className="flex min-w-0 flex-col">
            <span dir="auto" className="truncate font-semibold">
              {p.name}
            </span>
            {p.name === host && (
              <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-foreground">
                <Crown className="h-3 w-3" /> leader
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
      {players.map((p, i) => {
        const done = mode === "drawing" ? p.hasDrawn : p.hasGuessed;
        const doneLabel = mode === "drawing" ? "done" : "guessed";
        const waitLabel = mode === "drawing" ? "drawing…" : "thinking…";
        return (
          <li
            key={p.name}
            className={`card-arcade pop flex items-center gap-3 p-3 ${
              done ? "border-foreground" : "opacity-60"
            }`}
            style={{ "--d": `${i * 40}ms` } as React.CSSProperties}
          >
            <Avatar name={p.name} className="h-10 w-10 rounded-xl" />
            <span className="flex min-w-0 flex-col">
              <span dir="auto" className="truncate font-semibold">
                {p.name}
              </span>
              {done ? (
                <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-foreground">
                  <Check className="h-3 w-3" /> {doneLabel}
                </span>
              ) : (
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                  {waitLabel}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
