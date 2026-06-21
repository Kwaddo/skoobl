import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertGame } from "@/lib/history";
import { HistoryTab } from "./HistoryTab";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("HistoryTab", () => {
  it("shows an empty state when there is no history", () => {
    render(<HistoryTab />);
    expect(screen.getByText(/no saved drawings/i)).toBeTruthy();
  });

  it("lists a saved game with its room code", () => {
    upsertGame({
      id: "abc:1",
      code: "abc",
      playedAt: 1_000_000,
      you: "me",
      mine: {
        1: {
          prompt: "cat",
          strokes: [{ color: "#fff", width: 5, points: [{ x: 1, y: 1 }] }],
          thumb: "",
        },
      },
    });
    render(<HistoryTab />);
    expect(screen.getByText(/abc/i)).toBeTruthy();
  });

  it("closes the viewer when Escape is pressed on the focused backdrop", () => {
    upsertGame({
      id: "esc:1",
      code: "esc",
      playedAt: 2_000_000,
      you: "me",
      mine: {
        1: {
          prompt: "dog",
          strokes: [{ color: "#000", width: 3, points: [{ x: 2, y: 2 }] }],
          thumb: "data:image/png;base64,abc",
        },
      },
    });
    render(<HistoryTab />);

    // Find the tile button that contains the thumbnail img (aria-label not set,
    // but it wraps an <img> with alt="Round 1").
    const tileButton = screen
      .getByRole("img", { name: /round 1/i })
      .closest("button") as HTMLElement;

    // Open the viewer — wrap in act so React state update flushes.
    act(() => {
      fireEvent.click(tileButton);
    });

    // Viewer should now be open (Close button present).
    expect(screen.queryByRole("button", { name: /close/i })).toBeTruthy();

    // The backdrop should have received focus on mount; fire Escape on it.
    const backdrop = document.activeElement as HTMLElement;
    act(() => {
      fireEvent.keyDown(backdrop, { key: "Escape" });
    });

    // Viewer should be closed.
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
  });
});
