import { useEffect } from "react";
import type { Notice } from "@/lib/store";
import { useGameStore } from "@/lib/store";
import { Cross } from "./icons";

// Toasts renders the store's transient notices (a player left, bounced back to
// the lobby, …) as a stack of auto-dismissing cards. Mounted once by GameStage
// so it floats over every phase.
export function Toasts() {
  const notices = useGameStore((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex flex-col items-center gap-2 px-4">
      {notices.map((n) => (
        <Toast key={n.id} notice={n} />
      ))}
    </div>
  );
}

// Each toast fades in and clears itself after a few seconds; the × dismisses it
// early. Auto-dismiss is per-toast so the timers don't interfere.
function Toast({ notice }: { notice: Notice }) {
  const dismiss = useGameStore((s) => s.dismissNotice);
  useEffect(() => {
    const t = setTimeout(() => dismiss(notice.id), 3500);
    return () => clearTimeout(t);
  }, [notice.id, dismiss]);
  return (
    <div className="rise card-arcade pointer-events-auto flex items-center gap-3 px-4 py-2.5 shadow-[0_18px_40px_-20px_rgba(0,0,0,0.6)]">
      <span dir="auto" className="text-sm font-medium">
        {notice.text}
      </span>
      <button
        type="button"
        aria-label="dismiss"
        onClick={() => dismiss(notice.id)}
        className="btn-ghost h-6 w-6 shrink-0 p-0 text-muted"
      >
        <Cross className="mx-auto h-3.5 w-3.5" />
      </button>
    </div>
  );
}
