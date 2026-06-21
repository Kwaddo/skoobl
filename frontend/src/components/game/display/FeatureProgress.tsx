// FeatureProgress shows how far through a round's drawings the room is — a label
// ("Drawing 2/3") beside a row of pips, the current one widened and breathing,
// done ones solid, upcoming ones outlined. A round now guesses several drawings
// in a row (more players ⇒ more drawings, see the backend's guessesForPlayers),
// so this keeps everyone oriented on which drawing is on show. Renders nothing
// for a single-drawing round, where there's no sequence to track.
export function FeatureProgress({
  index,
  count,
  className = "",
}: {
  index: number;
  count: number;
  className?: string;
}) {
  if (!count || count <= 1) return null;
  const current = Math.min(Math.max(index, 1), count);
  // Precompute the pips with stable ids (positions never reorder) so the row
  // needs no array-index keys.
  const pips = [];
  for (let n = 1; n <= count; n++) {
    pips.push({
      id: `pip-${n}`,
      tone: n < current ? "pip-done" : n === current ? "pip-active" : "pip",
      wide: n === current,
    });
  }
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted">
        Drawing {current}/{count}
      </span>
      <div className="flex items-center gap-1.5">
        {pips.map((p) => (
          <span
            key={p.id}
            className={`pip h-2 rounded-full ${p.tone} ${p.wide ? "w-6" : "w-2"}`}
          />
        ))}
      </div>
    </div>
  );
}
