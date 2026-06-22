import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PALETTE } from "@/lib/canvas";
import { DrawingCanvas } from "./DrawingCanvas";

function drawAStroke(canvas: HTMLElement) {
  fireEvent.pointerDown(canvas, {
    isPrimary: true,
    clientX: 10,
    clientY: 10,
    pointerId: 1,
  });
  fireEvent.pointerMove(canvas, {
    isPrimary: true,
    clientX: 20,
    clientY: 20,
    pointerId: 1,
  });
  fireEvent.pointerUp(canvas, {
    isPrimary: true,
    clientX: 20,
    clientY: 20,
    pointerId: 1,
  });
}

describe("DrawingCanvas tools", () => {
  it("offers pen and fill tools plus a color popover of presets and a custom picker", () => {
    const { getByLabelText, queryByLabelText } = render(<DrawingCanvas />);
    expect(getByLabelText(/pen tool/i)).toBeTruthy();
    expect(getByLabelText(/fill tool/i)).toBeTruthy();
    // The popover is closed initially — presets and the hex input are hidden.
    expect(queryByLabelText(`color ${PALETTE[0]}`)).toBeNull();
    expect(queryByLabelText(/hex color/i)).toBeNull();
    // Opening it reveals the preset swatches and the custom picker.
    fireEvent.click(getByLabelText(/pick color/i));
    expect(getByLabelText(`color ${PALETTE[0]}`)).toBeTruthy();
    expect(getByLabelText(/hex color/i)).toBeTruthy();
  });

  it("opens a stroke-size slider from the pen, and the fill tool closes it", () => {
    const { getByLabelText, queryByLabelText } = render(<DrawingCanvas />);
    // The slider lives in the pen popover — closed until the pen is pressed.
    expect(queryByLabelText(/stroke size/i)).toBeNull();
    fireEvent.click(getByLabelText(/pen tool/i));
    expect(getByLabelText(/stroke size/i)).toBeTruthy();
    // Switching to the fill tool dismisses the pen popover.
    fireEvent.click(getByLabelText(/fill tool/i));
    expect(queryByLabelText(/stroke size/i)).toBeNull();
  });
});

function tap(canvas: HTMLElement, pointerId: number) {
  fireEvent.pointerDown(canvas, {
    isPrimary: true,
    clientX: 5,
    clientY: 5,
    pointerId,
  });
  fireEvent.pointerUp(canvas, {
    isPrimary: true,
    clientX: 5,
    clientY: 5,
    pointerId,
  });
}

describe("DrawingCanvas client-first", () => {
  it("streams a moved stroke live via onDraftReplace (throttled, not per point)", () => {
    const onDraftAppend = vi.fn();
    const onDraftReplace = vi.fn();
    render(
      <DrawingCanvas
        onDraftAppend={onDraftAppend}
        onDraftReplace={onDraftReplace}
      />,
    );
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    drawAStroke(canvas);
    // A stroke that moves is still growing, so it can't be appended — it syncs as
    // a full replace. The replace carries the whole strokes array (one stroke),
    // not one emit per point.
    expect(onDraftReplace).toHaveBeenCalled();
    expect(onDraftReplace.mock.calls.at(-1)?.[0]).toHaveLength(1);
    expect(onDraftAppend).not.toHaveBeenCalled();
  });

  it("flushes a pure tap via the cheap onDraftAppend, not a replace", () => {
    const onDraftAppend = vi.fn();
    const onDraftReplace = vi.fn();
    render(
      <DrawingCanvas
        onDraftAppend={onDraftAppend}
        onDraftReplace={onDraftReplace}
      />,
    );
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    tap(canvas, 1);
    expect(onDraftAppend).toHaveBeenCalledTimes(1);
    expect(onDraftAppend.mock.calls[0][0]).toHaveLength(1); // the new stroke only
    expect(onDraftReplace).not.toHaveBeenCalled();
  });

  it("appends only the delta after a streamed stroke (no re-send / duplication)", () => {
    vi.useFakeTimers();
    try {
      const onDraftAppend = vi.fn();
      const onDraftReplace = vi.fn();
      render(
        <DrawingCanvas
          onDraftAppend={onDraftAppend}
          onDraftReplace={onDraftReplace}
        />,
      );
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      drawAStroke(canvas); // stroke A streams via replace; synced count -> 1
      vi.advanceTimersByTime(200); // let the throttle settle
      tap(canvas, 2); // stroke B (a tap) appends
      vi.advanceTimersByTime(200);
      // The append must carry ONLY the new stroke, proving sync bookkeeping didn't
      // re-send (or drop) the already-streamed stroke A.
      expect(onDraftAppend).toHaveBeenCalled();
      expect(onDraftAppend.mock.calls.at(-1)?.[0]).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clear reports an empty draft via onDraftReplace", () => {
    const onDraftReplace = vi.fn();
    render(<DrawingCanvas onDraftReplace={onDraftReplace} />);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    drawAStroke(canvas);
    fireEvent.click(screen.getByLabelText("clear"));
    expect(onDraftReplace).toHaveBeenCalledWith([]);
  });
});

describe("DrawingCanvas eyedropper", () => {
  it("samples a color on tap then snaps back to the pen, never laying a stroke", () => {
    const onDraftAppend = vi.fn();
    const onDraftReplace = vi.fn();
    render(
      <DrawingCanvas
        onDraftAppend={onDraftAppend}
        onDraftReplace={onDraftReplace}
      />,
    );
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    // Pick the eyedropper, then tap the canvas: it samples that pixel's color and
    // must NOT draw, so no draft is emitted.
    fireEvent.click(screen.getByLabelText(/eyedropper/i));
    tap(canvas, 1);
    expect(onDraftAppend).not.toHaveBeenCalled();
    expect(onDraftReplace).not.toHaveBeenCalled();
    // It's one-shot: the sample snapped the tool back to the pen, so the next tap
    // draws as normal (proving it didn't stay stuck in eyedropper mode).
    tap(canvas, 2);
    expect(onDraftAppend).toHaveBeenCalledTimes(1);
  });
});
