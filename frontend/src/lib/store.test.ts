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

// A minimal valid broadcast; tests override only the fields they care about.
function frame(over: Partial<GameState>): GameState {
  return { code: "r", phase: "lobby", host: "tv", players: [], ...over };
}

describe("useGameStore notices", () => {
  beforeEach(() => useGameStore.getState().reset());

  it("toasts when a player drops out of the roster", () => {
    const { applyState } = useGameStore.getState();
    applyState(frame({ players: [{ name: "ann" }, { name: "bob" }] }));
    applyState(frame({ players: [{ name: "ann" }] })); // bob gone

    expect(useGameStore.getState().notices.map((n) => n.text)).toContain(
      "bob left the room",
    );
  });

  it("does not toast when a player only goes away (still in the roster)", () => {
    const { applyState } = useGameStore.getState();
    applyState(frame({ players: [{ name: "ann" }, { name: "bob" }] }));
    // bob is still present, just marked disconnected — not a real departure.
    applyState(
      frame({ players: [{ name: "ann" }, { name: "bob", connected: false }] }),
    );

    expect(useGameStore.getState().notices).toHaveLength(0);
  });

  it("toasts the bounce when a running game returns to the lobby", () => {
    const { applyState } = useGameStore.getState();
    applyState(frame({ phase: "drawing", players: [{ name: "ann" }] }));
    applyState(frame({ phase: "lobby", players: [{ name: "ann" }] }));

    expect(useGameStore.getState().notices.map((n) => n.text)).toContain(
      "Back in the lobby",
    );
  });

  it("suppresses the lobby toast when a departure already explains it", () => {
    const { applyState } = useGameStore.getState();
    applyState(
      frame({ phase: "drawing", players: [{ name: "ann" }, { name: "bob" }] }),
    );
    // bob leaves and the game bounces to the lobby — only the "left" toast fires.
    applyState(frame({ phase: "lobby", players: [{ name: "ann" }] }));

    const texts = useGameStore.getState().notices.map((n) => n.text);
    expect(texts).toContain("bob left the room");
    expect(texts).not.toContain("Back in the lobby");
  });

  it("flags closed when the host-left frame arrives, with no stray toast", () => {
    const { applyState } = useGameStore.getState();
    applyState(frame({ phase: "drawing", players: [{ name: "ann" }] }));
    applyState(
      frame({ phase: "drawing", players: [{ name: "ann" }], closed: true }),
    );

    expect(useGameStore.getState().closed).toBe(true);
    expect(useGameStore.getState().notices).toHaveLength(0);
  });
});
