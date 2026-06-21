// Backdrop is the global "sketchbook margin" — faint hand-drawn doodles scattered
// around the edges of the viewport, each bobbing on its own slow loop. Purely
// decorative (pointer-events-none, aria-hidden) and pinned behind all content, it
// gives every screen the feel of a doodled-on page without touching the layout.
// Strictly monochrome: doodles inherit a very low-opacity foreground ink.

type Doodle = {
  id: string;
  top?: string;
  bottom?: string;
  left?: string;
  right?: string;
  size: number;
  rot: number;
  dur: string;
  delay: string;
  glyph: React.ReactNode;
};

const S = (children: React.ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-full w-full"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const squiggle = S(<path d="M2 15c2-5 5-5 6 0s4 5 6 0 4-5 6 0" />);
const star = S(<path d="M12 3l1.7 5L19 9.6l-4.4 3.3L16 18l-4-3-4 3 1.4-5.1L5 9.6l5.3-1.6z" />);
const spiral = S(
  <path d="M12 12a2 2 0 1 1 2 2 3.5 3.5 0 1 1-3.6-3.6 5 5 0 1 1 5.2 5.2" />,
);
const zigzag = S(<path d="M2 15l4-6 4 6 4-6 4 6 4-6" />);
const plus = S(<path d="M12 5v14M5 12h14" />);
const bolt = S(<path d="M13 2 5 13h5l-1 9 9-12h-5l2-8z" />);
const eye = S(
  <>
    <path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.4" />
  </>,
);
const arrow = S(<path d="M4 14c3-7 9-9 15-7M19 4l1 4-4 1" />);
const heart = S(<path d="M12 20S4 14.5 4 9a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 5.5-8 11-8 11z" />);
const triangle = S(<path d="M12 4 21 20H3z" />);
const tilde = S(<path d="M3 13c2-4 5-4 7 0s5 4 7 0" />);
const circle = S(<circle cx="12" cy="12" r="8" />);

const DOODLES: Doodle[] = [
  { id: "star", top: "7%", left: "6%", size: 56, rot: -14, dur: "7s", delay: "0s", glyph: star },
  { id: "squiggle", top: "14%", right: "9%", size: 44, rot: 12, dur: "8.5s", delay: "-2s", glyph: squiggle },
  { id: "plus", top: "4%", left: "44%", size: 34, rot: -6, dur: "6.5s", delay: "-4s", glyph: plus },
  { id: "spiral", bottom: "10%", left: "8%", size: 50, rot: 10, dur: "9s", delay: "-1.5s", glyph: spiral },
  { id: "eye", bottom: "7%", right: "7%", size: 58, rot: -10, dur: "7.5s", delay: "-3s", glyph: eye },
  { id: "zigzag", top: "40%", left: "3%", size: 40, rot: 16, dur: "8s", delay: "-2.5s", glyph: zigzag },
  { id: "bolt", top: "46%", right: "4%", size: 46, rot: -16, dur: "9.5s", delay: "-0.8s", glyph: bolt },
  { id: "heart", bottom: "30%", right: "12%", size: 34, rot: 8, dur: "6.8s", delay: "-4.5s", glyph: heart },
  { id: "tilde", top: "24%", left: "16%", size: 30, rot: -20, dur: "7.2s", delay: "-3.6s", glyph: tilde },
  { id: "arrow", bottom: "20%", left: "26%", size: 32, rot: 14, dur: "8.2s", delay: "-1s", glyph: arrow },
  { id: "triangle", top: "62%", left: "10%", size: 30, rot: -8, dur: "9.2s", delay: "-5s", glyph: triangle },
  { id: "circle", bottom: "40%", left: "46%", size: 26, rot: 18, dur: "7.7s", delay: "-2.2s", glyph: circle },
];

export function Backdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden text-foreground"
    >
      {DOODLES.map((d) => (
        <span
          key={d.id}
          className="doodle absolute opacity-[0.07]"
          style={
            {
              top: d.top,
              bottom: d.bottom,
              left: d.left,
              right: d.right,
              width: d.size,
              height: d.size,
              "--r": `${d.rot}deg`,
              animationDuration: d.dur,
              animationDelay: d.delay,
            } as React.CSSProperties
          }
        >
          {d.glyph}
        </span>
      ))}
    </div>
  );
}
