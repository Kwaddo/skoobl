import { useEffect, useMemo, useState } from "react";
import { now as serverTime } from "@/lib/clock";
import type { Powerup } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";

// useActiveEffects returns the set of powerup kinds currently affecting this
// client. It re-evaluates on a short interval so each effect drops out the moment
// its server-stamped endsAt passes (compared against the server-anchored clock).
export function useActiveEffects(): Set<Powerup> {
  const effects = useGameStore((s) => s.yourEffects);
  const [, tick] = useState(0);

  useEffect(() => {
    if (effects.length === 0) return;
    const id = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(id);
  }, [effects]);

  const t = serverTime();
  // An effect is active only inside its [startsAt, endsAt) window. startsAt is in
  // the near future when a wave first arrives — the hit lurks, then strikes — so
  // this filter is what makes the timing land unexpectedly mid-stroke.
  const active = effects.filter((e) => (e.startsAt ?? 0) <= t && e.endsAt > t);
  // `kinds` is a stable primitive key: the Set reference only changes when the
  // sorted list of active effect kinds changes. This intentionally omits `active`
  // from the dep array because we want identity stability across sub-second ticks.
  const kinds = active
    .map((e) => e.kind)
    .sort()
    .join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — keyed on `kinds` (a derived primitive) to stabilise the Set reference across ticks when active kinds are unchanged
  const set = useMemo(() => new Set(active.map((e) => e.kind)), [kinds]);
  return set;
}
