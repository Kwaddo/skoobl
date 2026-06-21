import { useEffect, useState } from "react";
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
  return new Set(effects.filter((e) => e.endsAt > t).map((e) => e.kind));
}
