import { useEffect, useState } from "react";
import { now as serverTime } from "@/lib/clock";

// useCountdown returns whole seconds remaining until `endsAt` (a unix-ms
// timestamp from the server), ticking down once a second. Returns null when
// there's no active deadline. It reads the server-anchored clock (see lib/clock),
// not the raw device clock, so a host and a player with skewed clocks still show
// the same time left.
export function useCountdown(endsAt: number): number | null {
  const [now, setNow] = useState(() => serverTime());

  useEffect(() => {
    if (!endsAt) return;
    setNow(serverTime());
    const id = setInterval(() => setNow(serverTime()), 250);
    return () => clearInterval(id);
  }, [endsAt]);

  if (!endsAt) return null;
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}
