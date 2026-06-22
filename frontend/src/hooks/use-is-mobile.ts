import { useEffect, useState } from "react";

// Big-screen hosting needs a real shared screen, so on phones we offer only the
// Play-along host mode (the big-screen option is hidden). Mobile is anything
// below Tailwind's `sm` breakpoint (640px). Tracks live so a resize or rotate
// flips the gate.
const MOBILE_QUERY = "(max-width: 639px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(MOBILE_QUERY).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
