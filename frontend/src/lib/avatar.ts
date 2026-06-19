// Deterministic player identity. A name always maps to the same avatar icon, so
// people stay recognizable across the lobby, canvas, roster, and scoreboard. The
// chip background/ink are uniform (theme vars --av-bg / --av-ink); only the icon
// varies. The icon set lives in components/game/icons.tsx — this file only does
// the (JSX-free) hashing so it can be imported anywhere.

function hash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// avatarIndex picks an icon from a pool of `mod` icons.
export function avatarIndex(name: string, mod: number): number {
  return hash(name) % mod;
}
