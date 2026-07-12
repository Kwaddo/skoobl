import { describe, expect, it } from "vitest";
import { CHANGELOG, LATEST_VERSION } from "./changelog";

describe("changelog", () => {
  it("is non-empty and newest-first by date", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    const dates = CHANGELOG.map((r) => r.date);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
  });

  it("gives every release a version, title, and at least one change", () => {
    for (const r of CHANGELOG) {
      expect(r.version).toBeTruthy();
      expect(r.title).toBeTruthy();
      expect(r.changes.length).toBeGreaterThan(0);
    }
  });

  it("derives LATEST_VERSION from the first entry", () => {
    expect(LATEST_VERSION).toBe(CHANGELOG[0].version);
  });
});
