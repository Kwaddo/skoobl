import { ThemeToggle } from "@/components/ThemeToggle";
import { useGameStore } from "@/lib/store";
import { Avatar } from "../icons";

// RoomHeader is the persistent top bar: who you are, the room code, the live
// phase, and a Leave button. Shared by the host and player screens.
export function RoomHeader({
  code,
  name,
  onLeave,
  onBackToLobby,
}: {
  code: string;
  name: string;
  onLeave: () => void;
  onBackToLobby?: () => void;
}) {
  const phase = useGameStore((s) => s.phase);
  const round = useGameStore((s) => s.round);
  const totalRounds = useGameStore((s) => s.totalRounds);
  return (
    <header className="rise flex shrink-0 items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <Avatar name={name} className="h-11 w-11 rounded-xl" />
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
        <span
          className="sticker hidden px-3 py-1.5 sm:flex"
          style={{ "--rot": "-2deg" } as React.CSSProperties}
        >
          <span className="live-dot h-2 w-2 rounded-full bg-foreground" />
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            {phase === "lobby" || phase === "ended"
              ? phase
              : `round ${round}/${totalRounds} · ${phase}`}
          </span>
        </span>
        <ThemeToggle />
        {onBackToLobby && (
          <button
            type="button"
            onClick={onBackToLobby}
            className="btn-ghost px-3 py-1.5 text-sm"
            title="End the game and return everyone to the lobby"
          >
            Back to lobby
          </button>
        )}
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
