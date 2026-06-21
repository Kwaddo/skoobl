import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useGameStore } from "@/lib/store";
import { useActiveEffects } from "./use-effects";

describe("useActiveEffects", () => {
  it("returns only effects whose endsAt is still in the future", () => {
    act(() => {
      useGameStore.getState().reset();
      useGameStore.setState({
        yourEffects: [
          { kind: "fog", endsAt: Date.now() + 5000, from: "bob" },
          { kind: "squint", endsAt: Date.now() - 5000, from: "carol" },
        ],
      });
    });
    const { result } = renderHook(() => useActiveEffects());
    expect(result.current.has("fog")).toBe(true);
    expect(result.current.has("squint")).toBe(false);
  });
});
