import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Option<T> = { value: T; label: string };

// Segmented is a pill-style single-choice control. The selected highlight is a
// single "thumb" that slides to the chosen option (measured from the live button
// positions) instead of snapping between them. Used for the game settings and
// the home Join/Host tabs.
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  className = "",
  itemClassName = "px-3 py-1.5 text-sm font-semibold",
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  className?: string;
  itemClassName?: string;
}) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const [thumb, setThumb] = useState({ left: 0, width: 0 });
  // `ready` gates the slide transition so the thumb appears in place on mount
  // (no grow-from-zero) but animates on every change after.
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const el = btnRefs.current[active];
    if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
  }, [active]);

  useEffect(() => {
    const measure = () => {
      const el = btnRefs.current[active];
      if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
    };
    const id = window.requestAnimationFrame(() => setReady(true));
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(id);
      window.removeEventListener("resize", measure);
    };
  }, [active]);

  return (
    <div
      className={`relative flex gap-1 rounded-xl border-2 border-foreground bg-surface-2 p-1 ${className}`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute bottom-1 top-1 rounded-lg border-2 border-foreground bg-primary shadow-[2px_2px_0_0_var(--ink-edge)] ${
          ready ? "transition-[left,width] duration-300 ease-out-soft" : ""
        }`}
        style={{ left: thumb.left, width: thumb.width }}
      />
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          ref={(el) => {
            btnRefs.current[i] = el;
          }}
          type="button"
          onClick={() => onChange(o.value)}
          className={`relative z-10 rounded-lg transition-colors duration-300 ${itemClassName} ${
            value === o.value
              ? "text-primary-foreground"
              : "text-muted hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
