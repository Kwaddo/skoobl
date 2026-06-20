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

// How close a pixel's color must be to the seed to be filled (sum of |Δ| across
// RGBA, max 1020). Loose enough to flow under anti-aliased stroke edges, tight
// enough to stop at a drawn line of a different color.
export const FILL_TOLERANCE = 100;

// hexToRgba parses #rgb / #rrggbb / #rrggbbaa into an [r,g,b,a] tuple (0-255).
export function hexToRgba(hex: string): [number, number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const n = Number.parseInt(h.slice(0, 6), 16);
  const a = h.length >= 8 ? Number.parseInt(h.slice(6, 8), 16) : 255;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

// floodFill paints the 4-connected region of pixels matching the seed color
// (within tolerance) with `fill`. Operates in place on an RGBA buffer; a visited
// mask guarantees termination regardless of tolerance.
export function floodFill(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  sx: number,
  sy: number,
  fill: [number, number, number, number],
  tolerance: number,
): void {
  sx = Math.round(sx);
  sy = Math.round(sy);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return;
  const at = (x: number, y: number) => (y * width + x) * 4;
  const seed = at(sx, sy);
  const target = [data[seed], data[seed + 1], data[seed + 2], data[seed + 3]];
  // Nothing to do if the seed already is the fill color (avoids needless work).
  if (
    target[0] === fill[0] &&
    target[1] === fill[1] &&
    target[2] === fill[2] &&
    target[3] === fill[3]
  ) {
    return;
  }
  const matches = (i: number) =>
    Math.abs(data[i] - target[0]) +
      Math.abs(data[i + 1] - target[1]) +
      Math.abs(data[i + 2] - target[2]) +
      Math.abs(data[i + 3] - target[3]) <=
    tolerance;
  const visited = new Uint8Array(width * height);
  const stack: Array<[number, number]> = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop() as [number, number];
    const p = y * width + x;
    if (visited[p]) continue;
    visited[p] = 1;
    const i = at(x, y);
    if (!matches(i)) continue;
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill[3];
    if (x > 0) stack.push([x - 1, y]);
    if (x < width - 1) stack.push([x + 1, y]);
    if (y > 0) stack.push([x, y - 1]);
    if (y < height - 1) stack.push([x, y + 1]);
  }
}

// pngFilename is the download name for a round's drawing.
export function pngFilename(round: number): string {
  return `skoobl-round-${round}.png`;
}

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
    if (s.fill) {
      const seed = s.points[0];
      if (!seed) continue;
      const img = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
      floodFill(
        img.data,
        CANVAS_W,
        CANVAS_H,
        seed.x,
        seed.y,
        hexToRgba(s.color),
        FILL_TOLERANCE,
      );
      ctx.putImageData(img, 0, 0);
      continue;
    }
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

// downloadStrokesPng renders strokes to an offscreen canvas at full resolution
// and triggers a PNG download. No-ops where the 2D context is unavailable
// (e.g. jsdom in tests).
export function downloadStrokesPng(strokes: Stroke[], filename: string): void {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  drawStrokes(ctx, strokes);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}
