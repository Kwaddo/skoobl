import type { Player } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";
import { Avatar, Check, Crown, Eyes } from "../icons";

// PlayerGrid lists everyone in the room (used in the lobby).
export function PlayerGrid({ players }: { players: Player[] }) {
  const host = useGameStore((s) => s.host);
  if (players.length === 0) {
    return (
      <div className="card-arcade flex flex-col items-center gap-2 border-dashed px-6 py-10 text-center">
        <Eyes className="float h-10 w-10 text-foreground" />
        <p className="font-display text-lg font-bold">Nobody here yet</p>
        <p className="font-hand text-xl text-muted">
          share the code above to fill the room.
        </p>
      </div>
    );
  }
  return (
    // p-1.5 gives the cards' hover-lift and hard offset shadow room inside the
    // scrolling parent, so rotating/lifting tiles never clip against its edges.
    <ul className="grid grid-cols-2 gap-3 p-1.5 sm:grid-cols-3">
      {players.map((p, i) => (
        <li
          key={p.name}
          className="card-arcade card-hover pop flex items-center gap-3 p-3"
          style={{ "--d": `${i * 40}ms` } as React.CSSProperties}
        >
          <Avatar
            name={p.name}
            className="h-10 w-10 -rotate-3 rounded-xl border-2 border-foreground"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span dir="auto" className="truncate font-bold">
              {p.name}
            </span>
            {p.name === host && (
              <span
                className="sticker w-fit px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-foreground"
                style={{ "--rot": "-3deg" } as React.CSSProperties}
              >
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
    <ul className="grid grid-cols-2 gap-3 p-1.5 sm:grid-cols-3">
      {players.map((p, i) => {
        // Drawing phase shows real per-player lock-in (p.locked, not p.hasDrawn:
        // a draft is auto-saved on every stroke, so hasDrawn flips true long
        // before a player actually locks in). Guessing phase must NOT reveal who
        // has guessed — the artist never guesses, so a per-player "guessed ✓"
        // would expose them by elimination. Everyone renders the same neutral
        // state while guessing; progress is shown as an aggregate count instead.
        const done = mode === "drawing" ? !!p.locked : false;
        const doneLabel = "done";
        const waitLabel = mode === "drawing" ? "drawing…" : "guessing…";
        return (
          <li
            key={p.name}
            className={`card-arcade pop flex items-center gap-3 p-3 ${
              done ? "border-foreground" : "opacity-55"
            }`}
            style={{ "--d": `${i * 40}ms` } as React.CSSProperties}
          >
            <Avatar
              name={p.name}
              className="h-10 w-10 -rotate-3 rounded-xl border-2 border-foreground"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span dir="auto" className="truncate font-bold">
                {p.name}
              </span>
              {done ? (
                <span
                  className="sticker sticker-solid stick-on w-fit px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest"
                  style={{ "--rot": "-3deg" } as React.CSSProperties}
                >
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
