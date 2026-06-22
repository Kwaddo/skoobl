// Confetti is a one-shot burst of small monochrome ink shards tumbling down the
// screen — a black-&-white celebration for a win or the final scoreboard. It's
// purely decorative (pointer-events-none, aria-hidden) and self-contained: mount
// it to fire once. Shards are deterministic from their index, so no randomness is
// needed at render time.
const COUNT = 30;

type Shard = {
  id: string;
  left: number;
  delay: number;
  dur: number;
  spin: number;
  size: number;
  kind: number;
};

const SHARDS: Shard[] = Array.from({ length: COUNT }, (_, i) => ({
  id: `shard-${i}`,
  left: (i * 37 + (i % 5) * 7) % 100,
  delay: (i % 9) * 80,
  dur: 2 + ((i * 13) % 18) / 10, // 2.0–3.7s
  spin: 360 + ((i * 97) % 600),
  size: 5 + (i % 3) * 3, // 5 / 8 / 11 px
  kind: i % 4, // square · bar · ring · triangle
}));

export function Confetti() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-30 overflow-hidden"
    >
      {SHARDS.map((s) => (
        <span
          key={s.id}
          className="confetti-piece"
          style={
            {
              left: `${s.left}%`,
              "--dur": `${s.dur}s`,
              "--d": `${s.delay}ms`,
              "--spin": `${s.spin}deg`,
            } as React.CSSProperties
          }
        >
          <Shard kind={s.kind} size={s.size} />
        </span>
      ))}
    </div>
  );
}

function Shard({ kind, size }: { kind: number; size: number }) {
  const base = { width: size, height: size };
  if (kind === 0) {
    return <span className="block rotate-12 bg-foreground" style={base} />;
  }
  if (kind === 1) {
    return (
      <span
        className="block bg-foreground"
        style={{ width: size + 4, height: Math.max(2, size - 3) }}
      />
    );
  }
  if (kind === 2) {
    return (
      <span
        className="block rounded-full border-2 border-foreground"
        style={base}
      />
    );
  }
  return (
    <span
      className="block"
      style={{
        width: 0,
        height: 0,
        borderLeft: `${size / 2}px solid transparent`,
        borderRight: `${size / 2}px solid transparent`,
        borderBottom: `${size}px solid var(--color-foreground)`,
      }}
    />
  );
}
