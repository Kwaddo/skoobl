import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGameStore } from "@/lib/store";
import { useGameSocket } from "./use-game-socket";

// Minimal Socket.IO mock: records emits and lets tests fire server events.
class MockSocket {
  static last: MockSocket;
  handlers: Record<string, (arg: unknown) => void> = {};
  emitted: Array<{ event: string; payload?: unknown }> = [];
  constructor() {
    MockSocket.last = this;
  }
  on(event: string, fn: (arg: unknown) => void) {
    this.handlers[event] = fn;
  }
  emit(event: string, payload?: unknown) {
    this.emitted.push({ event, payload });
  }
  removeAllListeners() {}
  disconnect() {}
  fire(event: string, arg?: unknown) {
    this.handlers[event]?.(arg);
  }
}

vi.mock("socket.io-client", () => ({
  io: () => new MockSocket(),
}));

describe("useGameSocket", () => {
  beforeEach(() => {
    useGameStore.getState().reset();
  });

  it("emits join on connect and applies state events", async () => {
    renderHook(() => useGameSocket("abc123", "alice"));
    act(() => MockSocket.last.fire("connect"));

    const join = MockSocket.last.emitted.find((e) => e.event === "join");
    expect(join?.payload).toEqual({ code: "abc123", name: "alice" });

    act(() =>
      MockSocket.last.fire("state", {
        code: "abc123",
        phase: "lobby",
        host: "alice",
        players: [{ name: "alice" }],
      }),
    );
    await waitFor(() => expect(useGameStore.getState().host).toBe("alice"));
  });

  it("forwards player actions as named events", () => {
    const { result } = renderHook(() => useGameSocket("abc123", "alice"));
    act(() => result.current.start());
    act(() => result.current.submitGuess("bob"));
    act(() =>
      result.current.submitDrawing([
        { color: "#fff", width: 4, points: [{ x: 1, y: 2 }] },
      ]),
    );
    expect(MockSocket.last.emitted).toContainEqual({ event: "start" });
    expect(MockSocket.last.emitted).toContainEqual({
      event: "submitGuess",
      payload: { artist: "bob" },
    });
    expect(MockSocket.last.emitted).toContainEqual({
      event: "submitDrawing",
      payload: { strokes: [{ color: "#fff", width: 4, points: [{ x: 1, y: 2 }] }] },
    });
  });

  it("applies error events", async () => {
    renderHook(() => useGameSocket("abc123", "alice"));
    act(() => MockSocket.last.fire("connect"));
    act(() => MockSocket.last.fire("error", { message: "nope" }));
    await waitFor(() => expect(useGameStore.getState().error).toBe("nope"));
  });
});
