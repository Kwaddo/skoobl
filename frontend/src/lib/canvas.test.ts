import { describe, expect, it } from "vitest";
import { floodFill, hexToRgba, pngFilename, rgbToHex } from "./canvas";

describe("hexToRgba", () => {
  it("parses #rrggbb", () => {
    expect(hexToRgba("#ff0000")).toEqual([255, 0, 0, 255]);
  });
  it("parses #rgb shorthand", () => {
    expect(hexToRgba("#0f0")).toEqual([0, 255, 0, 255]);
  });
});

describe("rgbToHex", () => {
  it("formats channels as lowercase #rrggbb", () => {
    expect(rgbToHex(255, 0, 0)).toBe("#ff0000");
    expect(rgbToHex(0, 255, 0)).toBe("#00ff00");
  });
  it("zero-pads single-digit channels", () => {
    expect(rgbToHex(1, 2, 3)).toBe("#010203");
  });
  it("round-trips a sampled pixel back through hexToRgba", () => {
    const [r, g, b] = hexToRgba("#5ad1ff"); // a palette cyan
    expect(rgbToHex(r, g, b)).toBe("#5ad1ff");
  });
});

describe("floodFill", () => {
  // 3×1 row: [bg][barrier][bg]. A fill from the left must stop at the barrier.
  it("stops at a differing-color barrier", () => {
    const bg = 0;
    const barrier = 255;
    // RGBA per pixel.
    const data = new Uint8ClampedArray([
      bg,
      bg,
      bg,
      255, // x=0
      barrier,
      barrier,
      barrier,
      255, // x=1 (barrier)
      bg,
      bg,
      bg,
      255, // x=2
    ]);
    floodFill(data, 3, 1, 0, 0, [10, 20, 30, 255], 0);
    expect([data[0], data[1], data[2]]).toEqual([10, 20, 30]); // filled
    expect([data[4], data[5], data[6]]).toEqual([255, 255, 255]); // barrier intact
    expect([data[8], data[9], data[10]]).toEqual([0, 0, 0]); // unreached
  });

  it("fills a contiguous region", () => {
    const data = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
    floodFill(data, 2, 1, 0, 0, [9, 9, 9, 255], 0);
    expect([data[0], data[4]]).toEqual([9, 9]);
  });
});

describe("pngFilename", () => {
  it("names by round", () => {
    expect(pngFilename(2)).toBe("skoobl-round-2.png");
  });
});
