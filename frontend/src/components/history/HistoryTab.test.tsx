import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertGame } from "@/lib/history";
import { HistoryTab } from "./HistoryTab";

// Mock only downloadStrokesPng; keep drawStrokes/CANVAS_* real for StrokesView.
const downloadSpy = vi.fn();
vi.mock("@/lib/canvas", async (orig) => ({
  ...(await orig<typeof import("@/lib/canvas")>()),
  downloadStrokesPng: (...args: unknown[]) => downloadSpy(...args),
}));

const stroke = [{ color: "#fff", width: 5, points: [{ x: 1, y: 1 }] }];

beforeEach(() => {
  localStorage.clear();
  downloadSpy.mockClear();
});
afterEach(() => localStorage.clear());

describe("HistoryTab", () => {
  it("shows an empty state when there is no history", () => {
    render(<HistoryTab />);
    expect(screen.getByText(/no saved drawings/i)).toBeTruthy();
  });

  it("lists a saved game with its room code", () => {
    upsertGame({
      id: "abc:2026-06-22",
      code: "abc",
      playedAt: 1_000_000,
      you: "me",
      mine: { 1: { prompt: "cat", strokes: stroke, thumb: "" } },
    });
    render(<HistoryTab />);
    expect(screen.getByText(/abc/i)).toBeTruthy();
  });

  it("closes the viewer when Escape is pressed on the focused backdrop", () => {
    upsertGame({
      id: "esc:2026-06-22",
      code: "esc",
      playedAt: 2_000_000,
      you: "me",
      mine: {
        1: {
          prompt: "dog",
          strokes: stroke,
          thumb: "data:image/png;base64,abc",
        },
      },
    });
    render(<HistoryTab />);
    const tileButton = screen
      .getByRole("img", { name: /round 1/i })
      .closest("button") as HTMLElement;
    act(() => fireEvent.click(tileButton));
    expect(screen.queryByRole("button", { name: /close/i })).toBeTruthy();
    const backdrop = document.activeElement as HTMLElement;
    act(() => fireEvent.keyDown(backdrop, { key: "Escape" }));
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });

  it("groups a gallery game by round with artist captions, host shown once", () => {
    upsertGame({
      id: "OD57CF:2026-06-22",
      code: "OD57CF",
      playedAt: 3_000_000,
      you: "Host",
      mine: { 1: { prompt: "", strokes: stroke, thumb: "" } },
      gallery: {
        1: {
          alice: { prompt: "", strokes: stroke, thumb: "" },
          bob: { prompt: "", strokes: stroke, thumb: "" },
        },
      },
    });
    render(<HistoryTab />);
    // Round heading is visible.
    expect(screen.getByText(/round 1/i)).toBeTruthy();
    // Artist captions are visible text.
    expect(screen.getByText(/alice/i)).toBeTruthy();
    expect(screen.getByText(/bob/i)).toBeTruthy();
    // Host's own art shows once, labeled "you" (not the literal name "Host").
    expect(screen.getByText(/^you$/i)).toBeTruthy();
    expect(screen.queryByText(/^host$/i)).toBeNull();
  });

  it("downloads a PNG with a verbose, slugified filename from the viewer", () => {
    upsertGame({
      id: "OD57CF:2026-06-22",
      code: "OD57CF",
      playedAt: 4_000_000,
      you: "Host",
      mine: {},
      gallery: { 2: { Alice: { prompt: "", strokes: stroke, thumb: "" } } },
    });
    render(<HistoryTab />);
    // Open the only tile (Alice, round 2).
    const tile = screen.getAllByRole("button")[0];
    // The artist tile is among the buttons; open via its caption's tile.
    const aliceTile = screen
      .getByText(/alice/i)
      .closest("li")
      ?.querySelector("button") as HTMLElement;
    act(() => fireEvent.click(aliceTile ?? tile));
    const dl = screen.getByRole("button", { name: /download/i });
    act(() => fireEvent.click(dl));
    expect(downloadSpy).toHaveBeenCalledWith(
      stroke,
      "skoobl-OD57CF-round2-alice.png",
    );
  });

  it("steps between drawings via the next button and arrow keys", () => {
    upsertGame({
      id: "OD57CF:2026-06-22",
      code: "OD57CF",
      playedAt: 5_000_000,
      you: "Host",
      mine: { 1: { prompt: "", strokes: stroke, thumb: "" } },
      gallery: { 1: { alice: { prompt: "", strokes: stroke, thumb: "" } } },
    });
    render(<HistoryTab />);
    // Open the host's own tile (caption "you") — first in round 1.
    const youTile = screen
      .getByText(/^you$/i)
      .closest("li")
      ?.querySelector("button") as HTMLElement;
    act(() => fireEvent.click(youTile));
    expect(screen.getByText(/round 1 · you/i)).toBeTruthy();
    expect(screen.getByText("1 / 2")).toBeTruthy();

    // Next → alice.
    act(() =>
      fireEvent.click(screen.getByRole("button", { name: /next drawing/i })),
    );
    expect(screen.getByText(/round 1 · alice/i)).toBeTruthy();
    expect(screen.getByText("2 / 2")).toBeTruthy();

    // ArrowLeft bubbles to the window listener → back to "you".
    act(() =>
      fireEvent.keyDown(document.activeElement as HTMLElement, {
        key: "ArrowLeft",
      }),
    );
    expect(screen.getByText(/round 1 · you/i)).toBeTruthy();
    expect(screen.getByText("1 / 2")).toBeTruthy();
  });
});
