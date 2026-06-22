import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCountdown } from "./use-countdown";

// use-countdown ticks every 250ms; we use fake timers to control the clock.
describe("useCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not re-render between sub-second ticks within the same second", () => {
    // endsAt ~2 seconds from "now"
    const endsAt = Date.now() + 2000;

    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount++;
      return useCountdown(endsAt);
    });

    // Reset counter after initial render
    renderCount = 0;

    // Advance 250ms — first sub-second tick
    act(() => {
      vi.advanceTimersByTime(250);
    });
    const rendersAfterFirstTick = renderCount;

    // Advance another 250ms — second sub-second tick, still same second
    act(() => {
      vi.advanceTimersByTime(250);
    });
    const rendersAfterSecondTick = renderCount;

    // The returned integer value should be stable
    expect(typeof result.current).toBe("number");

    // After the second tick (still within the same second), there should be
    // no additional renders compared to after the first tick.
    // This fails with the current implementation because setNow() is always called.
    expect(rendersAfterSecondTick).toBe(rendersAfterFirstTick);
  });

  it("returns null when endsAt is 0/falsy", () => {
    const { result } = renderHook(() => useCountdown(0));
    expect(result.current).toBeNull();
  });

  it("counts down by 1 after a full second passes", () => {
    const endsAt = Date.now() + 3000;
    const { result } = renderHook(() => useCountdown(endsAt));

    const initial = result.current as number;

    act(() => {
      vi.advanceTimersByTime(1100); // a bit past 1 second
    });

    expect(result.current).toBe(initial - 1);
  });
});
