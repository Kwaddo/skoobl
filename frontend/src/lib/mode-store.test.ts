import { describe, expect, it } from "vitest";
import type { GameState } from "./protocol";
import { useGameStore } from "./store";

describe("game mode in the store", () => {
  it("defaults to classic and carries an applied mode", () => {
    useGameStore.getState().reset();
    expect(useGameStore.getState().mode).toBe("classic");

    useGameStore.getState().applyState({
      code: "ABCD",
      phase: "lobby",
      host: "tv",
      players: [],
      mode: "flipped",
    } as GameState);

    expect(useGameStore.getState().mode).toBe("flipped");
  });
});
