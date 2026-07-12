import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { HistoryTab } from "@/components/history/HistoryTab";
import { Segmented } from "@/components/Segmented";
import { UpdatesTab } from "@/components/updates/UpdatesTab";

type Panel = "history" | "updates";

// InfoDialog is the landing-page popup behind the header button: a themed modal
// that holds the two secondary panels — your saved-drawing History and the
// What's-new changelog — as sub-tabs, keeping them out of the main Join/Host
// flow. Portalled to document.body so the card's entrance transform can't trap
// this fixed overlay; z-40 sits below History's own full-res viewer (z-50) so
// opening a drawing stacks above the dialog. Renders nothing when closed.
export function InfoDialog({
  open,
  initialPanel = "history",
  onClose,
  onViewUpdates,
}: {
  open: boolean;
  initialPanel?: Panel;
  onClose: () => void;
  // Called whenever the What's-new panel becomes visible, so the caller can mark
  // the latest version seen and clear the "unseen" dot.
  onViewUpdates: () => void;
}) {
  const [panel, setPanel] = useState<Panel>(initialPanel);

  // Each fresh open jumps to the requested panel; landing straight on What's-new
  // counts as seeing it.
  useEffect(() => {
    if (!open) return;
    setPanel(initialPanel);
    if (initialPanel === "updates") onViewUpdates();
  }, [open, initialPanel, onViewUpdates]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const show = (next: Panel) => {
    setPanel(next);
    if (next === "updates") onViewUpdates();
  };

  return createPortal(
    <div className="fade-in fixed inset-0 z-40 flex items-center justify-center px-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        // Fixed frame: the box stays one strict size regardless of which panel
        // (short changelog vs long history) is showing — content scrolls inside.
        // max-h caps it on short viewports so it never overflows the screen.
        className="ink-block crop-marks pop relative flex h-[600px] max-h-[85dvh] w-full max-w-xl flex-col gap-5 p-6 sm:p-7"
      >
        <div className="flex items-center gap-3">
          <Segmented
            value={panel}
            onChange={show}
            options={[
              { value: "history" as const, label: "History" },
              { value: "updates" as const, label: "What's new" },
            ]}
            className="flex-1"
            itemClassName="flex-1 px-4 py-2 text-sm font-bold"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="btn-ghost shrink-0 px-3 py-2 text-sm"
          >
            ✕
          </button>
        </div>

        {/* keyed so each sub-tab crossfades in on switch; flex-1 so it fills the
            fixed frame and owns the single scrollbar */}
        <div key={panel} className="rise min-h-0 flex-1 overflow-y-auto">
          {panel === "history" ? <HistoryTab /> : <UpdatesTab />}
        </div>
      </div>
    </div>,
    document.body,
  );
}
