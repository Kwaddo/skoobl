import type { Stroke } from "./protocol";

// Fixed logical canvas resolution. Strokes are stored in this coordinate space so
// every viewer renders the same picture regardless of their display size. MUST
// match the backend's canvasW/canvasH (used for server-side clamping).
export const CANVAS_W = 1000;
export const CANVAS_H = 750;

// Background the canvas is painted on (matches the arcade "surface" token).
const CANVAS_BG = "#16161f";

// Drawing palette — the theme neons plus a few primaries, chosen to read well on
// the dark surface. These are the colors the player can pick from.
export const PALETTE = [
  "#f5f4ec", // chalk
  "#d9fb06", // acid lime
  "#ff5c8a", // hot pink
  "#5ad1ff", // cyan
  "#ff8a3d", // orange
  "#8aff6a", // green
  "#b18cff", // violet
  "#0c0c11", // ink
] as const;

// Brush sizes (logical px).
export const BRUSHES = [5, 12, 24] as const;

// drawStrokes paints a full strokes list onto a 2D context sized CANVAS_W ×
// CANVAS_H. Used by both the interactive canvas and the read-only viewer.
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
): void {
  ctx.fillStyle = CANVAS_BG;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    if (!s.points.length) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    const [first, ...rest] = s.points;
    ctx.moveTo(first.x, first.y);
    if (rest.length === 0) {
      // A single tap: nudge so the round line cap renders as a dot.
      ctx.lineTo(first.x + 0.01, first.y + 0.01);
    } else {
      for (const p of rest) ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
}
