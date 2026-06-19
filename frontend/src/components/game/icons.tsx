// Icons for skoobl. Two families:
//  • Player avatars — filled silhouettes from game-icons.net (see
//    avatar-paths.ts), drawn with currentColor on a 512 viewBox.
//  • UI glyphs — minimal monochrome line-icons drawn with a consistent stroke.
// Everything uses currentColor so the surrounding text color drives it.
import { useLayoutEffect, useSyncExternalStore } from "react";
import { avatarIndex } from "@/lib/avatar";
import { AVATAR_PATHS } from "./avatar-paths";

type IconProps = { className?: string };

// ── avatar normalization ────────────────────────────────────────────────────
// The game-icons each fill a different slice of the 512 box (some are tall, some
// off-centre, some have built-in margins), so drawn as-is they'd look wildly
// inconsistent in the chips. We measure each glyph's bounding box once (off-DOM)
// and crop it to a centred square with uniform padding, so every avatar lands at
// the same visual size, dead-centre.
const FALLBACK_VB = "0 0 512 512";
let viewBoxes: Record<string, string> | null = null;
const vbListeners = new Set<() => void>();

function measureViewBoxes() {
  if (viewBoxes || typeof document === "undefined") return;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", FALLBACK_VB);
  svg.setAttribute(
    "style",
    "position:absolute;left:-9999px;top:0;width:512px;height:512px;visibility:hidden",
  );
  const g = document.createElementNS(NS, "g");
  svg.appendChild(g);
  document.body.appendChild(svg);
  const out: Record<string, string> = {};
  try {
    for (const icon of AVATAR_PATHS) {
      g.replaceChildren();
      for (const d of icon.paths) {
        const p = document.createElementNS(NS, "path");
        p.setAttribute("d", d);
        g.appendChild(p);
      }
      const b = (g as SVGGraphicsElement).getBBox();
      const size = Math.max(b.width, b.height) || 512;
      const pad = size * 0.12;
      const full = size + pad * 2;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      out[icon.name] = `${cx - full / 2} ${cy - full / 2} ${full} ${full}`;
    }
    viewBoxes = out;
  } catch {
    // No getBBox in this environment (e.g. jsdom under tests) — keep the full
    // 512 box. Set an empty map so we don't keep retrying every mount.
    viewBoxes = {};
  } finally {
    document.body.removeChild(svg);
  }
  for (const l of vbListeners) l();
}

function useAvatarViewBox(name: string): string {
  return useSyncExternalStore(
    (l) => {
      vbListeners.add(l);
      return () => vbListeners.delete(l);
    },
    () => viewBoxes?.[name] ?? FALLBACK_VB,
    () => FALLBACK_VB,
  );
}

// Svg is the shared frame for the line glyphs: 24×24 viewBox, rounded joins,
// no fill. Children are the paths/shapes unique to each icon.
function Svg({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// little filled dot — used for eyes, gems, etc.
const dot = (cx: number, cy: number, r = 0.95) => (
  <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
);

// ── player avatars (filled silhouettes) ────────────────────────────────────

// Avatar is the player chip: a deterministic grayscale tile with a filled
// game-icon, both recolored by theme via CSS vars. Caller controls size/rounding
// via className (e.g. "h-10 w-10 rounded-xl"); the glyph scales to fit.
export function Avatar({
  name,
  className = "",
}: {
  name: string;
  className?: string;
}) {
  const icon = AVATAR_PATHS[avatarIndex(name, AVATAR_PATHS.length)];
  const viewBox = useAvatarViewBox(icon.name);
  // Measure on mount (before paint) so the normalized viewBox is used first time.
  useLayoutEffect(() => {
    measureViewBoxes();
  }, []);
  return (
    <span
      className={`relative flex shrink-0 items-center justify-center overflow-hidden border border-black/10 transition-colors duration-500 ease-out-soft ${className}`}
      style={{ backgroundColor: "var(--av-bg)", color: "var(--av-ink)" }}
    >
      <svg
        viewBox={viewBox}
        fill="currentColor"
        className="h-[70%] w-[70%]"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        {icon.paths.map((d) => (
          <path key={d.slice(0, 24)} d={d} />
        ))}
      </svg>
    </span>
  );
}

// ── UI glyphs (line icons) ──────────────────────────────────────────────────

export const Crown = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M4 8.5 7.5 12 12 6l4.5 6L20 8.5V18H4z" />
    <path d="M4 18h16" />
  </Svg>
);

export const Sun = ({ className }: IconProps) => (
  <Svg className={className}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9 6.7 6.7M17.3 17.3l1.8 1.8M19.1 4.9 17.3 6.7M6.7 17.3 4.9 19.1" />
  </Svg>
);

export const Moon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M20.5 13.5A8.5 8.5 0 1 1 11 4.2a6.6 6.6 0 0 0 9.5 9.3z" />
  </Svg>
);

export const Trophy = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M7 4h10v3a5 5 0 0 1-10 0z" />
    <path d="M7 5H4.5v1.5A2.5 2.5 0 0 0 7 9M17 5h2.5v1.5A2.5 2.5 0 0 1 17 9M12 12v3M9 19.5h6M10 19.5l.5-4.5h3l.5 4.5" />
  </Svg>
);

export const Lock = ({ className }: IconProps) => (
  <Svg className={className}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3M12 15v2.5" />
  </Svg>
);

export const Brush = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M4 20l1.2-4.2L16 5l3 3L8.2 18.8z" />
    <path d="M14 7l3 3" />
  </Svg>
);

export const Check = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M5 12.5 10 17.5 19 7" />
  </Svg>
);

export const Cross = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const Eyes = ({ className }: IconProps) => (
  <Svg className={className}>
    <circle cx="8" cy="12" r="3.4" />
    <circle cx="16" cy="12" r="3.4" />
    {dot(8, 12, 1.1)}
    {dot(16, 12, 1.1)}
  </Svg>
);

export const Alert = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M12 3.5 22 20H2z" />
    <path d="M12 10v4" />
    {dot(12, 17, 0.85)}
  </Svg>
);

export const ArrowUp = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M12 20V5M6 11l6-6 6 6" />
  </Svg>
);

export const Sparkle = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
  </Svg>
);
