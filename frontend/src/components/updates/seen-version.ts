import { LATEST_VERSION } from "./changelog";

// Tracks the newest release version this device has seen, so the Updates tab can
// show a "new" dot until it's opened. Best-effort: storage may be unavailable
// (private mode), in which case the dot simply always shows / never persists.
const KEY = "skoobl:seen-version";

export function recallSeenVersion(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberSeenVersion(v: string): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // ignore — no persistence available
  }
}

export function hasUnseenUpdate(): boolean {
  return !!LATEST_VERSION && recallSeenVersion() !== LATEST_VERSION;
}
