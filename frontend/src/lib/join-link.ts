// Helpers for scan-to-join: the host renders buildJoinUrl(...) as a QR code, and
// the home form reads codeFromSearch(...) to prefill the room code so a scanned
// player only has to enter a name.

// codeFromSearch pulls the room code out of a URL query string ("" if absent).
export function codeFromSearch(search: string): string {
  return new URLSearchParams(search).get("code") ?? "";
}

// buildJoinUrl is the absolute link a phone lands on after scanning: the home
// page with the room code prefilled in the Join tab.
export function buildJoinUrl(origin: string, code: string): string {
  return `${origin}/?code=${encodeURIComponent(code)}`;
}
