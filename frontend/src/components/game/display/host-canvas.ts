// The big drawing on the host TV is a box that FILLS its cell (so the screen
// never looks half-empty); the strokes scale up inside it with object-contain,
// keeping their aspect ratio. HOST_CANVAS_BOX styles the box, HOST_CANVAS the
// canvas that fills it. Shared by the host stages and the end-game carousel.
export const HOST_CANVAS_BOX =
  "min-h-0 overflow-hidden rounded-xl border-[2.5px] border-foreground bg-surface shadow-[6px_7px_0_0_var(--ink-edge),0_24px_60px_-28px_rgba(0,0,0,0.55)]";
export const HOST_CANVAS = "h-full w-full object-contain";
