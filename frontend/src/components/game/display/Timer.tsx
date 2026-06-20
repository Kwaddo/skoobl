// Timer renders the remaining seconds, inverting and pounding under 5s.
export function Timer({ remaining }: { remaining: number | null }) {
  if (remaining === null) return null;
  const low = remaining <= 5;
  return (
    <span
      className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 font-mono text-lg font-bold transition-colors ${
        low
          ? "heartbeat border-foreground bg-foreground text-background"
          : "border-border text-foreground"
      }`}
    >
      {remaining}
    </span>
  );
}
