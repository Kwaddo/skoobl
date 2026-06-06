import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGameStore } from "@/lib/store";
import { useGameSocket } from "./use-game-socket";

class MockWS {
  static last: MockWS;
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    MockWS.last = this;
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe("useGameSocket", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", MockWS as unknown as typeof WebSocket);
    useGameStore.getState().reset();
  });

  it("sends join on open and applies state events", async () => {
    const { result } = renderHook(() => useGameSocket("abc123", "alice"));
    act(() => MockWS.last.open());

    expect(MockWS.last.sent.some((m) => m.includes('"join"'))).toBe(true);

    act(() =>
      MockWS.last.emit({
        type: "state",
        payload: {
          code: "abc123",
          phase: "lobby",
          host: "alice",
          players: [{ name: "alice" }],
        },
      }),
    );
    await waitFor(() => expect(useGameStore.getState().host).toBe("alice"));

    act(() => result.current.send({ type: "start" }));
    expect(MockWS.last.sent.some((m) => m.includes('"start"'))).toBe(true);
  });

  it("applies error events", async () => {
    renderHook(() => useGameSocket("abc123", "alice"));
    act(() => MockWS.last.open());
    act(() =>
      MockWS.last.emit({ type: "error", payload: { message: "nope" } }),
    );
    await waitFor(() => expect(useGameStore.getState().error).toBe("nope"));
  });
});
