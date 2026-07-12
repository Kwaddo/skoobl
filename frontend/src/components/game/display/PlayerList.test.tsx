import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGameStore } from "@/lib/store";
import { PlayerGrid } from "./PlayerList";

describe("PlayerGrid kick button", () => {
  const players = [{ name: "tv" }, { name: "alice" }];

  it("shows a kick button for non-host players when onKick is given", () => {
    useGameStore.setState({ host: "tv" });
    const onKick = vi.fn();
    const { getByRole } = render(
      <PlayerGrid players={players} onKick={onKick} />,
    );
    const btn = getByRole("button", { name: /remove alice/i });
    btn.click();
    expect(onKick).toHaveBeenCalledWith("alice");
  });

  it("renders no kick buttons without onKick", () => {
    useGameStore.setState({ host: "tv" });
    const { queryAllByRole } = render(<PlayerGrid players={players} />);
    expect(queryAllByRole("button")).toHaveLength(0);
  });

  it("never offers a kick button for the host", () => {
    useGameStore.setState({ host: "tv" });
    const { queryByRole } = render(
      <PlayerGrid players={players} onKick={vi.fn()} />,
    );
    expect(queryByRole("button", { name: /remove tv/i })).toBeNull();
  });
});
