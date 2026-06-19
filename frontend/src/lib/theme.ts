// Global light/dark theme. The choice is mirrored onto <html data-theme> (CSS
// does the actual recoloring via variables) and persisted to localStorage. A
// tiny inline script in index.html applies it before first paint to avoid a
// flash; this module keeps it in sync at runtime and drives the toggle.
import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const KEY = "skoobl:theme";

function read(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

let current: Theme =
  (typeof document !== "undefined" &&
    (document.documentElement.getAttribute("data-theme") as Theme)) ||
  read();

// Make sure the attribute reflects the resolved theme even if the pre-paint
// inline script in index.html didn't run.
if (typeof document !== "undefined") {
  document.documentElement.setAttribute("data-theme", current);
}

const listeners = new Set<() => void>();

function commit(next: Theme) {
  current = next;
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode — fine, it just won't persist */
  }
  for (const l of listeners) l();
}

// toggleTheme flips the theme. Where the View Transitions API is available it
// plays a circular reveal that grows from the click point; everywhere else it
// falls back to a full-page colour crossfade (the .theme-anim class). Honors
// prefers-reduced-motion.
export function toggleTheme(origin?: { x: number; y: number }) {
  const next: Theme = current === "dark" ? "light" : "dark";
  const root = document.documentElement;
  const reduce = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  const start = document.startViewTransition?.bind(document);

  if (reduce || !start) {
    root.classList.add("theme-anim");
    commit(next);
    window.setTimeout(() => root.classList.remove("theme-anim"), 480);
    return;
  }

  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? 0;
  // radius reaching the farthest corner, so the circle fully covers the screen
  const r = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );
  root.style.setProperty("--vt-x", `${x}px`);
  root.style.setProperty("--vt-y", `${y}px`);
  root.style.setProperty("--vt-r", `${r}px`);

  start(() => commit(next));
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}
