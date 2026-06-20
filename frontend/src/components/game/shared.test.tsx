import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CodeCard } from "./shared";

describe("CodeCard", () => {
  it("renders a join QR and a scan hint alongside the code", () => {
    const { container, getByText } = render(<CodeCard code="frog42" />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(getByText("frog42")).toBeTruthy();
    expect(getByText(/scan to join/i)).toBeTruthy();
  });
});
