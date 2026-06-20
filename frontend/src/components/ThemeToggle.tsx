import { toggleTheme, useTheme } from "@/lib/theme";
import { Moon, Sun } from "./game/icons";

// ThemeToggle flips light/dark. The sun and moon are stacked and cross-fade with
// a rotate+scale so the swap glides; the actual page transition (circular reveal
// from the click point) is handled in lib/theme.
export function ThemeToggle({ className = "" }: { className?: string }) {
  const dark = useTheme() === "dark";
  return (
    <button
      type="button"
      onClick={(e) => toggleTheme({ x: e.clientX, y: e.clientY })}
      className={`btn-ghost relative h-9 w-9 shrink-0 overflow-hidden p-0 ${className}`}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle light or dark mode"
    >
      <Sun
        className={`absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 transition-all duration-500 ease-out-soft ${
          dark
            ? "rotate-0 scale-100 opacity-100"
            : "-rotate-90 scale-50 opacity-0"
        }`}
      />
      <Moon
        className={`absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 transition-all duration-500 ease-out-soft ${
          dark
            ? "rotate-90 scale-50 opacity-0"
            : "rotate-0 scale-100 opacity-100"
        }`}
      />
    </button>
  );
}
