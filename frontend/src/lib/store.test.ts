import { beforeEach, describe, expect, it } from "vitest";
import type { GameState } from "./protocol";
import { useGameStore } from "./store";

const sample: GameState = {
  code: "abc123",
  phase: "lobby",
  host: "alice",
  players: [{ name: "alice" }],
};

describe("useGameStore", () => {
  beforeEach(() => useGameStore.getState().reset());

  it("applies a state event", () => {
    useGameStore.getState().applyState(sample);
    const s = useGameStore.getState();
    expect(s.host).toBe("alice");
    expect(s.players).toHaveLength(1);
    expect(s.phase).toBe("lobby");
  });

  it("records an error and clears it", () => {
    useGameStore.getState().setError("nope");
    expect(useGameStore.getState().error).toBe("nope");
    useGameStore.getState().setError(null);
    expect(useGameStore.getState().error).toBeNull();
  });

  it("reset clears state", () => {
    useGameStore.getState().applyState(sample);
    useGameStore.getState().reset();
    expect(useGameStore.getState().players).toHaveLength(0);
    expect(useGameStore.getState().code).toBe("");
  });
});
