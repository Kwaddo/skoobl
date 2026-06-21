// Timer renders the remaining seconds inside a circular progress ring that drains
// as the phase runs down, inverting and pounding under 5s. Pass `total` (the
// phase length in seconds) to draw the ring; without it, a plain dial is shown.
export function Timer({
  remaining,
  total,
}: {
  remaining: number | null;
  total?: number;
}) {
  if (remaining === null) return null;
  const low = remaining <= 5;
  const R = 21;
  const C = 2 * Math.PI * R;
  const frac =
    total && total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 1;

  return (
    <span
      className={`relative flex h-12 w-12 shrink-0 items-center justify-center ${
        low ? "heartbeat" : ""
      }`}
    >
      {total ? (
        // -rotate-90 starts the arc at 12 o'clock; the offset transitions over a
        // second so the ring sweeps smoothly instead of jumping each tick.
        <svg
          viewBox="0 0 48 48"
          className="absolute inset-0 h-full w-full -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="24"
            cy="24"
            r={R}
            fill="none"
            stroke="var(--color-border)"
            strokeWidth="3"
          />
          <circle
            cx="24"
            cy="24"
            r={R}
            fill="none"
            stroke="var(--color-foreground)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - frac)}
            style={{ transition: "stroke-dashoffset 1s linear" }}
          />
        </svg>
      ) : null}
      <span
        className={`flex h-8 w-8 items-center justify-center rounded-full font-mono text-base font-bold transition-colors ${
          low ? "bg-foreground text-background" : "text-foreground"
        } ${!total ? "border-2 border-border" : ""}`}
      >
        {remaining}
      </span>
    </span>
  );
}
