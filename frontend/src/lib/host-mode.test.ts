import { describe, expect, it } from "vitest";
import { hostModeOptions } from "./host-mode";

describe("hostModeOptions", () => {
  it("offers big-screen and play-along on large screens", () => {
    expect(hostModeOptions(false).map((o) => o.value)).toEqual([
      "screen",
      "play",
    ]);
  });

  it("offers only play-along on mobile (a phone is not a shared TV)", () => {
    expect(hostModeOptions(true).map((o) => o.value)).toEqual(["play"]);
  });
});
