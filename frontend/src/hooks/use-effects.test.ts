import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGameStore } from "@/lib/store";
import { useActiveEffects } from "./use-effects";

describe("useActiveEffects", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    act(() => {
      useGameStore.getState().reset();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns only effects whose endsAt is still in the future", () => {
    act(() => {
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

  it("returns a stable Set reference across ticks when active-effect kinds are unchanged", () => {
    // Set up an active effect well into the future so it won't expire during the test
    act(() => {
      useGameStore.setState({
        yourEffects: [{ kind: "fog", endsAt: Date.now() + 60000, from: "bob" }],
      });
    });

    const { result } = renderHook(() => useActiveEffects());

    // Capture the Set reference after initial render
    const firstSet = result.current;

    // Advance 200ms to trigger the interval tick
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const secondSet = result.current;

    // Advance another 200ms — another tick, same effects
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const thirdSet = result.current;

    // The active kinds haven't changed, so the Set reference should be stable
    // (same object identity across ticks). This fails with the current implementation
    // because a new Set is created on every render.
    expect(firstSet).toBe(secondSet);
    expect(secondSet).toBe(thirdSet);
  });
});
