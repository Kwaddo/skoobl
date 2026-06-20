import { useEffect, useState } from "react";

// Hosting is the shared "big screen" — it assumes a large canvas and a layout
// that doesn't fit a phone, so we gate it behind a width check. Mobile is
// anything below Tailwind's `sm` breakpoint (640px), matching the `sm:` styles
// used across the app. Tracks live so a resize or rotate flips the gate.
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
