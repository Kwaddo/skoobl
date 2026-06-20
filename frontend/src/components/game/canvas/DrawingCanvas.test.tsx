import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PALETTE } from "@/lib/canvas";
import { DrawingCanvas } from "./DrawingCanvas";

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
