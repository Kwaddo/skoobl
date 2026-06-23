import { useEffect, useState } from "react";
import { now as serverTime } from "@/lib/clock";

// useCountdown returns whole seconds remaining until `endsAt` (a unix-ms
// timestamp from the server), ticking down once a second. Returns null when
// there's no active deadline. It reads the server-anchored clock (see lib/clock),
// not the raw device clock, so a host and a player with skewed clocks still show
// the same time left.
export function useCountdown(endsAt: number): number | null {
  const [remaining, setRemaining] = useState(() =>
    endsAt ? Math.max(0, Math.ceil((endsAt - serverTime()) / 1000)) : null,
  );

  useEffect(() => {
    if (!endsAt) {
      setRemaining(null);
      return;
    }
    // Compute and set immediately on endsAt change
    const next = Math.max(0, Math.ceil((endsAt - serverTime()) / 1000));
    setRemaining((prev) => (prev === next ? prev : next));

    const id = setInterval(() => {
      const next = Math.max(0, Math.ceil((endsAt - serverTime()) / 1000));
      setRemaining((prev) => (prev === next ? prev : next));
    }, 250);
    return () => clearInterval(id);
  }, [endsAt]);

  return remaining;
}
