import { ThemeToggle } from "@/components/ThemeToggle";
import { useGameStore } from "@/lib/store";
import { Avatar } from "../icons";

// RoomHeader is the persistent top bar: who you are, the room code, the live
// phase, and a Leave button. Shared by the host and player screens.
//
// It's a container query (@container), so it reacts to its OWN width rather than
// the viewport. The play-along host and the players share this bar inside a
// narrow max-w-xl column on an otherwise-wide desktop, so viewport breakpoints
// would keep the full status pill open and crush the controls into it. Three
// tidy zones instead — identity · status · controls — and the status pill earns
// its width as the bar grows: hidden when tiny (phone), a compact round chip on
// the narrow controller, the full "round/phase" badge on the wide shared TV.
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
  const live = phase !== "lobby" && phase !== "ended";
  const compactStatus = live ? `${round}/${totalRounds}` : phase;
  const fullStatus = live ? `round ${round}/${totalRounds} · ${phase}` : phase;
  return (
    <header className="rise @container flex shrink-0 items-center justify-between gap-4">
      {/* identity — can shrink and truncate so it never shoves the controls */}
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={name} className="h-11 w-11 shrink-0 rounded-xl" />
        <div className="flex min-w-0 flex-col">
          <span
            dir="auto"
            className="truncate font-display text-lg font-bold leading-tight"
          >
            {name}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            room {code}
          </span>
        </div>
      </div>

      {/* live status — sits in its own zone with room to breathe */}
      <span
        className="sticker hidden shrink-0 whitespace-nowrap px-3 py-1.5 @sm:flex"
        style={{ "--rot": "-2deg" } as React.CSSProperties}
      >
        <span className="live-dot h-2 w-2 rounded-full bg-foreground" />
        <span className="font-mono text-xs uppercase tracking-widest text-muted">
          <span className="@2xl:hidden">{compactStatus}</span>
          <span className="hidden @2xl:inline">{fullStatus}</span>
        </span>
      </span>

      {/* controls — one tidy, uniform-height group */}
      <div className="flex shrink-0 items-center gap-2">
        <ThemeToggle />
        {onBackToLobby && (
          <button
            type="button"
            onClick={onBackToLobby}
            className="btn-ghost h-9 whitespace-nowrap px-3.5 text-sm"
            title="End the game and return everyone to the lobby"
          >
            Back to lobby
          </button>
        )}
        <button
          type="button"
          onClick={onLeave}
          className="btn-ghost h-9 whitespace-nowrap px-3.5 text-sm"
          title="Leave the room"
        >
          Leave
        </button>
      </div>
    </header>
  );
}
