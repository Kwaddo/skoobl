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

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + second).toUpperCase();
}
