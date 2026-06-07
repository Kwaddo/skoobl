// Per-tab player identity. Kept in sessionStorage rather than the URL so the
// name is never exposed as a ?name= query param. It survives a refresh within
// the same tab (matching the old URL behaviour); a fresh tab or a direct link
// has none, and the room routes bounce such visitors back to the home screen
// to pick a name.

const KEY = "skoobl:name";

export function rememberName(name: string): void {
  sessionStorage.setItem(KEY, name);
}

export function recallName(): string {
  return sessionStorage.getItem(KEY) ?? "";
}
