// Per-tab player identity. Kept in sessionStorage rather than the URL so the
// name is never exposed as a ?name= query param. It survives a refresh within
// the same tab (matching the old URL behaviour); a fresh tab or a direct link
// has none, and the room routes bounce such visitors back to the home screen
// to pick a name.

const KEY = "skoobl:name";
const HOST_PLAY_KEY = "skoobl:hostplay";

export function rememberName(name: string): void {
  sessionStorage.setItem(KEY, name);
}

export function recallName(): string {
  return sessionStorage.getItem(KEY) ?? "";
}

// The host's chosen room mode: true ⇒ the host plays along (is a player), false
// ⇒ the host is the display-only big screen. Set on the home screen before the
// host route opens, so the socket join and the host UI both know which to be.
export function rememberHostPlay(play: boolean): void {
  sessionStorage.setItem(HOST_PLAY_KEY, play ? "1" : "0");
}

export function recallHostPlay(): boolean {
  return sessionStorage.getItem(HOST_PLAY_KEY) === "1";
}
