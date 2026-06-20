import { describe, expect, it } from "vitest";
import { buildJoinUrl, codeFromSearch } from "./join-link";

describe("join-link", () => {
  it("reads the room code from a query string", () => {
    expect(codeFromSearch("?code=frog42")).toBe("frog42");
  });

  it("returns an empty string when there is no code", () => {
    expect(codeFromSearch("")).toBe("");
    expect(codeFromSearch("?foo=bar")).toBe("");
  });

  it("builds an absolute join URL carrying the code", () => {
    expect(buildJoinUrl("https://skoobl.app", "frog42")).toBe(
      "https://skoobl.app/?code=frog42",
    );
  });

  it("url-encodes the code", () => {
    expect(buildJoinUrl("https://x", "a b")).toBe("https://x/?code=a%20b");
  });
});
