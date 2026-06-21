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
  draftDrawing: () => {},
  submitGuess: () => {},
  submitDoodleGuess: () => {},
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
      // bob drew something, so he's a valid "who drew this?" option
      players: [{ name: "ann" }, { name: "bob", hasDrawn: true }],
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

  it("host drawing roster counts locked-in players, not mere drafts", () => {
    useGameStore.setState({
      phase: "drawing",
      // A draft is auto-saved on every stroke (hasDrawn flips true), but only a
      // real lock-in (locked) should read as "finished". bob drafted but hasn't
      // locked, so he must still show as drawing.
      players: [
        { name: "ann", hasDrawn: true, locked: true },
        { name: "bob", hasDrawn: true, locked: false },
      ],
      yourPrompt: "cat",
    });
    const { getByText } = render(<HostStage name="tv" actions={noopActions} />);
    expect(getByText("1 of 2 finished")).toBeTruthy();
    expect(getByText("drawing…")).toBeTruthy();
  });

  it("auto-submits a drawing at time-up only while connected", () => {
    const calls: number[] = [];
    const actions = {
      ...noopActions,
      submitDrawing: () => calls.push(1),
    } as unknown as GameActions;
    // Deadline already passed → the countdown reads 0 on mount.
    const past = Date.now() - 100_000;

    // Mid-deploy blackout: the socket is down but the local clock still hits 0.
    // No lock-in must fire, or every client buffers a submit during the restart.
    useGameStore.setState({
      phase: "drawing",
      players: [{ name: "ann" }],
      yourPrompt: "cat",
      phaseEndsAt: past,
      connected: false,
    });
    const offline = render(<PlayerStage name="ann" actions={actions} />);
    expect(calls.length).toBe(0);
    offline.unmount();

    // Reconnected with the deadline genuinely past → the auto-submit fires.
    useGameStore.setState({
      phase: "drawing",
      players: [{ name: "ann" }],
      yourPrompt: "cat",
      phaseEndsAt: past,
      connected: true,
    });
    render(<PlayerStage name="ann" actions={actions} />);
    expect(calls.length).toBe(1);
  });

  it("host guessing keeps who-guessed anonymous and counts non-artists", () => {
    useGameStore.setState({
      phase: "guessing",
      // bob is the hidden artist (never guesses). Showing a per-player "guessed"
      // tick would expose him by elimination, so nobody is marked, and progress
      // counts against the non-artist total (3 - 1 = 2).
      players: [
        { name: "ann", hasGuessed: true },
        { name: "bob", hasGuessed: false },
        { name: "cat", hasGuessed: false },
      ],
      currentDrawing: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }],
    });
    const { getByText, queryByText } = render(
      <HostStage name="tv" actions={noopActions} />,
    );
    expect(getByText("1/2 guessed")).toBeTruthy();
    // No per-player "guessed ✓" badge anywhere in the roster.
    expect(queryByText("guessed", { exact: true })).toBeNull();
  });

  it("host ended screen offers Play again", () => {
    useGameStore.setState({
      phase: "ended",
      players: [{ name: "ann", score: 100 }],
    });
    const { getByText } = render(<HostStage name="tv" actions={noopActions} />);
    expect(getByText(/play again/i)).toBeTruthy();
  });

  it("host ended carousels through every drawing of the game", () => {
    useGameStore.setState({
      phase: "ended",
      players: [
        { name: "ann", score: 120 },
        { name: "bob", score: 80 },
      ],
      galleryHistory: {
        1: {
          ann: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }],
          bob: [{ color: "#f00", width: 4, points: [{ x: 2, y: 2 }] }],
        },
        2: { ann: [{ color: "#0f0", width: 4, points: [{ x: 3, y: 3 }] }] },
      },
    });
    const { container, getByText, getByLabelText } = render(
      <HostStage name="tv" actions={noopActions} />,
    );
    // The carousel renders a drawing, names the artist, and offers navigation —
    // and the final scoreboard + Play again are still present beside it.
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(getByText(/drawn by/i)).toBeTruthy();
    expect(getByLabelText(/next drawing/i)).toBeTruthy();
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

  it("scoreboard shows the round delta during reveal", () => {
    useGameStore.setState({
      phase: "reveal",
      players: [{ name: "ann", score: 167, roundScore: 67 }],
      reveal: { artist: "ann", prompt: "cat" },
    });
    const { getByText } = render(<HostStage name="tv" actions={noopActions} />);
    expect(getByText("+67")).toBeTruthy();
  });

  it("player reveal shows the points earned this round", () => {
    useGameStore.setState({
      phase: "reveal",
      players: [{ name: "ann", score: 92, roundScore: 92 }],
      reveal: { artist: "bob", prompt: "cat" },
      youAreArtist: false,
    });
    const { getByText } = render(
      <PlayerStage name="ann" actions={noopActions} />,
    );
    expect(getByText("+92")).toBeTruthy();
  });

  it("player reveal shows their own drawing with a download button", () => {
    useGameStore.setState({
      phase: "reveal",
      round: 1,
      players: [{ name: "ann" }, { name: "bob" }],
      reveal: { artist: "bob", prompt: "cat" },
      myDrawings: {
        1: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }],
      },
    });
    const { container, getByText } = render(
      <PlayerStage name="ann" actions={noopActions} />,
    );
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(getByText(/download/i)).toBeTruthy();
  });

  it("host reveal shows a labeled gallery of every drawing", () => {
    useGameStore.setState({
      phase: "reveal",
      round: 1,
      players: [{ name: "ann" }, { name: "bob" }],
      reveal: { artist: "bob", prompt: "cat" },
      currentDrawing: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }],
      gallery: {
        ann: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }],
        bob: [{ color: "#f00", width: 4, points: [{ x: 2, y: 2 }] }],
      },
    });
    const { container, getAllByText } = render(
      <HostStage name="tv" actions={noopActions} />,
    );
    // Featured (big) + 2 gallery tiles = at least 3 canvases.
    expect(container.querySelectorAll("canvas").length).toBeGreaterThanOrEqual(
      3,
    );
    expect(getAllByText("ann").length).toBeGreaterThanOrEqual(1);
    expect(getAllByText("bob").length).toBeGreaterThanOrEqual(1);
  });

  it("flipped guessing shows a doodle grid for the target, not name buttons", () => {
    useGameStore.setState({
      phase: "guessing",
      mode: "flipped",
      target: "bob",
      youAreTarget: false,
      players: [{ name: "ann" }, { name: "bob", hasDrawn: true }],
      pool: [
        {
          id: "d1",
          strokes: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }],
        },
        {
          id: "d2",
          strokes: [{ color: "#f00", width: 4, points: [{ x: 2, y: 2 }] }],
        },
      ],
    });
    const { container, getByText, queryByText } = render(
      <PlayerStage name="ann" actions={noopActions} />,
    );
    // Two candidate doodles rendered as canvases (the grid).
    expect(container.querySelectorAll("canvas").length).toBe(2);
    // Header names the target.
    expect(getByText(/bob/i)).toBeTruthy();
    // Not the classic "who drew it?" name list.
    expect(queryByText(/who drew it/i)).toBeNull();
  });

  it("host flipped guessing shows the doodle grid and names the target", () => {
    useGameStore.setState({
      phase: "guessing",
      mode: "flipped",
      target: "bob",
      players: [{ name: "ann" }, { name: "bob" }],
      pool: [
        {
          id: "d1",
          strokes: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }],
        },
        {
          id: "d2",
          strokes: [{ color: "#f00", width: 4, points: [{ x: 2, y: 2 }] }],
        },
      ],
    });
    const { container, getByText } = render(
      <HostStage name="tv" actions={noopActions} />,
    );
    expect(container.querySelectorAll("canvas").length).toBe(2);
    expect(getByText(/bob/i)).toBeTruthy();
  });

  it("player ended shows their drawings with downloads, not the scoreboard", () => {
    useGameStore.setState({
      phase: "ended",
      players: [
        { name: "ann", score: 120 },
        { name: "bob", score: 80 },
      ],
      myDrawings: {
        1: [{ color: "#fff", width: 4, points: [{ x: 1, y: 1 }] }],
        2: [{ color: "#f00", width: 4, points: [{ x: 2, y: 2 }] }],
      },
    });
    const { container, getAllByText, queryByText } = render(
      <PlayerStage name="ann" actions={noopActions} />,
    );
    // Two own drawings → two canvases, each with a download control.
    expect(container.querySelectorAll("canvas").length).toBe(2);
    expect(getAllByText(/download/i).length).toBeGreaterThanOrEqual(2);
    // No leaderboard rank numbers on the phone.
    expect(queryByText(/play again/i)).toBeNull();
    // "bob" only appears if the Scoreboard rendered — it must not.
    expect(queryByText("bob")).toBeNull();
  });
});
