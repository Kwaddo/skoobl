import { useEffect } from "react";

// ConfirmDialog is a clean, themed replacement for window.confirm: a blurred
// backdrop with a centred arcade card. Dismiss with the backdrop, Cancel, or
// Escape; the primary action is auto-focused. Renders nothing when closed.
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center px-4">
      <button
        type="button"
        aria-label={cancelLabel}
        onClick={onCancel}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="card-arcade pop relative w-full max-w-sm p-6 text-center"
      >
        <h2 className="font-display text-xl font-bold">{title}</h2>
        {message && <p className="mt-2 text-sm text-muted">{message}</p>}
        <div className="mt-6 flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="btn-ghost px-5 py-2.5 text-sm"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            // biome-ignore lint/a11y/noAutofocus: focusing the primary action in a modal is expected
            autoFocus
            onClick={onConfirm}
            className="btn-key whitespace-nowrap px-5 py-2.5 text-sm"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
