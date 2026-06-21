import { useEffect, useState } from "react";
import type { Notice } from "@/lib/store";
import { useGameStore } from "@/lib/store";

// Toasts renders the store's transient notices (a player left, bounced back to
// the lobby, …) as a stack of auto-dismissing cards in the bottom-right. The
// whole layer is pointer-events-none, so a toast NEVER blocks a button, tool, or
// anything else underneath — taps pass straight through to the controls below.
// Mounted once by GameStage so it floats over every phase.
export function Toasts() {
  const notices = useGameStore((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-[min(20rem,calc(100vw-2rem))] flex-col items-end gap-2">
      {notices.map((n) => (
        <Toast key={n.id} notice={n} />
      ))}
    </div>
  );
}

// Each toast drops in from above, holds, then slides further down as it fades out
// before being removed (no instant pop-out). There's no manual dismiss control on
// purpose — a clickable element here would re-introduce the risk of covering a
// button; auto-dismiss keeps the layer click-through.
const HOLD_MS = 3200;
const EXIT_MS = 350;
function Toast({ notice }: { notice: Notice }) {
  const dismiss = useGameStore((s) => s.dismissNotice);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    // start the exit animation first, then remove from the store once it finishes
    const out = setTimeout(() => setLeaving(true), HOLD_MS);
    const gone = setTimeout(() => dismiss(notice.id), HOLD_MS + EXIT_MS);
    return () => {
      clearTimeout(out);
      clearTimeout(gone);
    };
  }, [notice.id, dismiss]);
  return (
    <div
      className={`card-arcade flex items-center gap-2 px-4 py-2.5 shadow-[0_18px_40px_-20px_rgba(0,0,0,0.6)] ${
        leaving ? "toast-out" : "toast-in"
      }`}
    >
      <span className="live-dot text-foreground">●</span>
      <span dir="auto" className="text-sm font-medium">
        {notice.text}
      </span>
    </div>
  );
}
