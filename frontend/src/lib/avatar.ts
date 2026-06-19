// Deterministic neon color per player name, so the same person keeps the same
// chip color across the lobby.
const PALETTE = [
  "#d9fb06", // lime
  "#ff5c8a", // pink
  "#5ad1ff", // cyan
  "#ffb347", // amber
  "#b388ff", // violet
  "#5affb0", // mint
];

export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

// A fun, deterministic icon per player — same name always gets the same critter,
// so people are recognizable across the lobby, canvas, and scoreboard. Emoji
// keep this self-contained (no external avatar service / network calls).
const ICONS = [
  "🦊", "🐼", "🐸", "🐵", "🦁", "🐯", "🐙", "🦄",
  "🐳", "🐝", "🦖", "🐧", "🦉", "🐲", "🦋", "🐢",
  "🐬", "🦜", "👾", "🤖", "👻", "🦀", "🦩", "🦦",
  "🦥", "🐗", "🦝", "🐨", "🦔", "🐙",
];

export function avatarEmoji(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return ICONS[Math.abs(h) % ICONS.length];
}
