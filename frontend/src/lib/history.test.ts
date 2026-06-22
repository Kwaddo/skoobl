import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSavedGame,
  clearHistory,
  currentGameId,
  deleteGame,
  getSaveGalleryPref,
  historyPngName,
  loadHistory,
  MAX_GAMES,
  type SavedGame,
  saveHistory,
  setSaveGalleryPref,
  upsertGame,
} from "./history";

const game = (id: string, over: Partial<SavedGame> = {}): SavedGame => ({
  id,
  code: "abc",
  playedAt: 1000,
  you: "me",
  mine: { 1: { prompt: "cat", strokes: [], thumb: "t" } },
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("loadHistory", () => {
  it("returns [] when empty", () => {
    expect(loadHistory()).toEqual([]);
  });
  it("returns [] on corrupt JSON", () => {
    localStorage.setItem("skoobl:history", "{not json");
    expect(loadHistory()).toEqual([]);
  });
  it("returns [] when stored value is not an array", () => {
    localStorage.setItem("skoobl:history", '{"id":"x"}');
    expect(loadHistory()).toEqual([]);
  });
});

describe("upsertGame", () => {
  it("prepends a new game", () => {
    upsertGame(game("a"));
    upsertGame(game("b"));
    expect(loadHistory().map((g) => g.id)).toEqual(["b", "a"]);
  });
  it("merges rounds into an existing game and keeps original playedAt", () => {
    upsertGame(
      game("a", {
        playedAt: 5,
        mine: { 1: { prompt: "", strokes: [], thumb: "x" } },
      }),
    );
    upsertGame(
      game("a", {
        playedAt: 999,
        mine: { 2: { prompt: "dog", strokes: [], thumb: "y" } },
      }),
    );
    const [g] = loadHistory();
    expect(g.playedAt).toBe(5);
    expect(Object.keys(g.mine)).toEqual(["1", "2"]);
  });
  it("caps at MAX_GAMES, dropping oldest", () => {
    for (let i = 0; i < MAX_GAMES + 3; i++) upsertGame(game(`g${i}`));
    const ids = loadHistory().map((g) => g.id);
    expect(ids).toHaveLength(MAX_GAMES);
    expect(ids[0]).toBe(`g${MAX_GAMES + 2}`);
    expect(ids).not.toContain("g0");
  });
  it("deep-merges gallery by artist within shared rounds", () => {
    upsertGame(
      game("g", {
        gallery: {
          1: {
            alice: { prompt: "", strokes: [], thumb: "t" },
          },
        },
      }),
    );
    upsertGame(
      game("g", {
        gallery: {
          1: {
            bob: { prompt: "", strokes: [], thumb: "t" },
          },
        },
      }),
    );
    const [g] = loadHistory();
    // biome-ignore lint/style/noNonNullAssertion: gallery is non-null after upsertGame with gallery
    expect(Object.keys(g.gallery![1])).toHaveLength(2);
    // biome-ignore lint/style/noNonNullAssertion: gallery is non-null after upsertGame with gallery
    expect(Object.keys(g.gallery![1])).toContain("alice");
    // biome-ignore lint/style/noNonNullAssertion: gallery is non-null after upsertGame with gallery
    expect(Object.keys(g.gallery![1])).toContain("bob");
  });
});

describe("saveHistory quota fallback", () => {
  it("drops the oldest and retries on QuotaExceededError", () => {
    const games = [game("new"), game("old")];
    let calls = 0;
    // Throw once (simulating a full quota), succeed on the retry. The retry
    // happens only after saveHistory drops the tail, so a success proves the
    // fallback ran. We assert on call count, not a write-through read.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      calls++;
      if (calls === 1) throw new DOMException("quota", "QuotaExceededError");
    });
    expect(saveHistory(games)).toBe(true);
    expect(calls).toBe(2);
  });
  it("gives up (returns false) when a single game still won't fit", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(saveHistory([game("solo")])).toBe(false);
  });
});

describe("deleteGame / clearHistory", () => {
  it("removes one game by id", () => {
    upsertGame(game("a"));
    upsertGame(game("b"));
    deleteGame("a");
    expect(loadHistory().map((g) => g.id)).toEqual(["b"]);
  });
  it("clears everything", () => {
    upsertGame(game("a"));
    clearHistory();
    expect(loadHistory()).toEqual([]);
  });
});

describe("gallery pref", () => {
  it("defaults to false and round-trips", () => {
    expect(getSaveGalleryPref()).toBe(false);
    setSaveGalleryPref(true);
    expect(getSaveGalleryPref()).toBe(true);
  });
});

describe("buildSavedGame", () => {
  const thumb = (s: unknown[]) => `thumb:${s.length}`;
  it("returns null when there is nothing to save", () => {
    const g = buildSavedGame({
      id: "a:1",
      code: "a",
      you: "me",
      playedAt: 7,
      myDrawings: {},
      galleryHistory: {},
      saveGallery: false,
      thumb,
    });
    expect(g).toBeNull();
  });
  it("builds mine from non-empty drawings and skips empty ones", () => {
    const g = buildSavedGame({
      id: "a:1",
      code: "a",
      you: "me",
      playedAt: 7,
      myDrawings: {
        1: [{ color: "#fff", width: 5, points: [{ x: 1, y: 1 }] }],
        2: [],
      },
      galleryHistory: {},
      saveGallery: false,
      thumb,
    });
    expect(g).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: g is non-null, asserted above
    expect(Object.keys(g!.mine)).toEqual(["1"]);
    // biome-ignore lint/style/noNonNullAssertion: g is non-null, asserted above
    expect(g!.gallery).toBeUndefined();
  });
  it("includes gallery only when saveGallery is true", () => {
    const input = {
      id: "a:1",
      code: "a",
      you: "Host",
      playedAt: 7,
      myDrawings: {},
      galleryHistory: {
        1: { bob: [{ color: "#fff", width: 5, points: [{ x: 1, y: 1 }] }] },
      },
      thumb,
    };
    expect(buildSavedGame({ ...input, saveGallery: false })).toBeNull();
    const g = buildSavedGame({ ...input, saveGallery: true });
    expect(g?.gallery?.[1]?.bob.thumb).toBe("thumb:1");
  });
  it("excludes the host (you) from gallery; host art stays only in mine", () => {
    const stroke = [{ color: "#fff", width: 5, points: [{ x: 1, y: 1 }] }];
    const g = buildSavedGame({
      id: "a:2026-06-22",
      code: "a",
      you: "Host",
      playedAt: 7,
      myDrawings: { 1: stroke },
      galleryHistory: {
        1: { Host: stroke, bob: stroke },
      },
      saveGallery: true,
      thumb,
    });
    expect(g).not.toBeNull();
    // Host's own art lives in mine...
    // biome-ignore lint/style/noNonNullAssertion: g asserted non-null above
    expect(Object.keys(g!.mine)).toEqual(["1"]);
    // ...and the gallery holds only the OTHER artists.
    // biome-ignore lint/style/noNonNullAssertion: gallery present when saveGallery true with art
    expect(Object.keys(g!.gallery![1])).toEqual(["bob"]);
  });
});

describe("currentGameId", () => {
  it("is deterministic per code+local-day (YYYY-MM-DD)", () => {
    vi.useFakeTimers();
    // A fixed local wall-clock instant.
    vi.setSystemTime(new Date(2026, 5, 22, 9, 30, 0)); // 2026-06-22 local
    const id = currentGameId("OD57CF");
    expect(id).toMatch(/^OD57CF:\d{4}-\d{2}-\d{2}$/);
    expect(id.endsWith(":2026-06-22")).toBe(true);
    // Same day, later time → same id (so a replay merges).
    vi.setSystemTime(new Date(2026, 5, 22, 23, 0, 0));
    expect(currentGameId("OD57CF")).toBe(id);
    vi.useRealTimers();
  });

  it("changes with the room code and with the day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 22, 12, 0, 0));
    const a = currentGameId("AAA");
    expect(currentGameId("BBB")).not.toBe(a);
    vi.setSystemTime(new Date(2026, 5, 23, 12, 0, 0));
    expect(currentGameId("AAA")).not.toBe(a);
    vi.useRealTimers();
  });
});

describe("historyPngName", () => {
  it("names own art with code and round", () => {
    expect(historyPngName("OD57CF", 2)).toBe("skoobl-OD57CF-round2.png");
  });
  it("names gallery art with a slugified artist", () => {
    expect(historyPngName("OD57CF", 1, "Alice")).toBe(
      "skoobl-OD57CF-round1-alice.png",
    );
    expect(historyPngName("OD57CF", 3, "Big Bob 99!")).toBe(
      "skoobl-OD57CF-round3-big-bob-99.png",
    );
  });
  it("treats an empty artist as own art", () => {
    expect(historyPngName("AAA", 1, "")).toBe("skoobl-AAA-round1.png");
  });
});
