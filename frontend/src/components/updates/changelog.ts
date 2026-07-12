// The user-facing release log shown on the home "Updates" tab. Newest entry
// first. Edit this by hand on every release: bump the version, set today's date,
// and write the changes in plain player-facing language. `tag` is the dominant
// nature of the release (a small coloured sticker in the UI).
export type ChangeTag = "new" | "improve" | "fix";

export type Release = {
  version: string; // e.g. "1.6.0"
  date: string; // ISO date, "2026-06-23"
  title: string; // short headline
  tag?: ChangeTag; // dominant nature of the release
  changes: string[]; // user-facing bullet points
};

export const CHANGELOG: Release[] = [
  {
    version: "1.6.0",
    date: "2026-06-23",
    title: "Frenzy mode",
    tag: "new",
    changes: [
      "New chaotic Frenzy game mode: timed waves throw effects at everyone at once.",
      "Waves are tiered, shared across the room, and scale with the round timer.",
    ],
  },
  {
    version: "1.5.0",
    date: "2026-06-22",
    title: "Smoother canvas & polished results",
    tag: "improve",
    changes: [
      "Drawing canvas is faster and lighter, with client-first strokes for instant feedback.",
      "Refreshed end-of-game results screen.",
      "New “Whose Doodle?” flipped guessing mode.",
      "Drawing toolbar moves to the side on short screens.",
    ],
  },
  {
    version: "1.4.0",
    date: "2026-06-21",
    title: "Your drawing history",
    tag: "new",
    changes: [
      "Every doodle you make is saved locally and browsable from the new History tab.",
    ],
  },
  {
    version: "1.3.0",
    date: "2026-06-20",
    title: "Points & saved artwork",
    tag: "new",
    changes: [
      "New points system rewards fast, correct guesses.",
      "Round drawings are kept as shareable artifacts.",
    ],
  },
  {
    version: "1.2.0",
    date: "2026-06-19",
    title: "Big-screen party mode",
    tag: "new",
    changes: [
      "Host on a shared screen while everyone plays from their phones.",
    ],
  },
  {
    version: "1.1.0",
    date: "2026-06-07",
    title: "Rooms that survive a wobble",
    tag: "improve",
    changes: [
      "Reconnect after a brief drop without losing your seat.",
      "If the host leaves, another player takes over instead of the game ending.",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-06-06",
    title: "Skoobl launch",
    tag: "new",
    changes: ["Draw the word, then guess who drew the one on screen."],
  },
];

export const LATEST_VERSION = CHANGELOG[0]?.version ?? "";
