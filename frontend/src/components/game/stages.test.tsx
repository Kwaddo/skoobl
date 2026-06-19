import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { GameActions } from "@/hooks/use-game-socket";
import { useGameStore } from "@/lib/store";
import { HostStage } from "./HostStage";
import { PlayerStage } from "./PlayerStage";

const noopActions = {
  configure: () => {},
  start: () => {},
  nextPhase: () => {},
  returnToLobby: () => {},
  leave: () => {},
  submitDrawing: () => {},
  submitGuess: () => {},
} as unknown as GameActions;

describe("stage split", () => {
  beforeEach(() => useGameStore.getState().reset());

  it("host shows the drawing (canvas) during guessing, with a prompt", () => {
    useGameStore.setState({
      phase: "guessing",
      players: [{ name: "ann" }, { name: "bob" }],
      currentDrawing: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }],
    });
    const { container, getByText } = render(
      <HostStage name="tv" actions={noopActions} />,
    );
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(getByText(/who drew this/i)).toBeTruthy();
  });

  it("player shows a pick list during guessing, never the drawing", () => {
    useGameStore.setState({
      phase: "guessing",
      players: [{ name: "ann" }, { name: "bob" }],
      currentDrawing: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }],
      youAreArtist: false,
      yourGuess: "",
    });
    const { container, getByText } = render(
      <PlayerStage name="ann" actions={noopActions} />,
    );
    expect(container.querySelector("canvas")).toBeNull();
    expect(getByText("bob")).toBeTruthy();
  });

  it("host ended screen offers Play again", () => {
    useGameStore.setState({
      phase: "ended",
      players: [{ name: "ann", score: 100 }],
    });
    const { getByText } = render(<HostStage name="tv" actions={noopActions} />);
    expect(getByText(/play again/i)).toBeTruthy();
  });

  it("player ended screen has no Play again button, just a wait", () => {
    useGameStore.setState({
      phase: "ended",
      players: [{ name: "ann", score: 100 }],
    });
    const { queryByText, getByText } = render(
      <PlayerStage name="ann" actions={noopActions} />,
    );
    expect(queryByText(/play again/i)).toBeNull();
    expect(getByText(/waiting for the host/i)).toBeTruthy();
  });
});
