import { useEffect, useState } from "react";

// useCountdown returns whole seconds remaining until `endsAt` (a unix-ms
// timestamp from the server), ticking down once a second. Returns null when
// there's no active deadline. The clock is the server's, so all clients agree.
export function useCountdown(endsAt: number): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!endsAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [endsAt]);

  if (!endsAt) return null;
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}
