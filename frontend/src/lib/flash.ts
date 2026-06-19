// A one-shot, in-memory hand-off used when a room route bounces the player back
// to the home form (e.g. the name is taken or the code is wrong). It carries the
// small message + which tab to show + the code to prefill, so the player can fix
// it and retry without a full-screen error page. Kept in memory (not the URL or
// storage) because it's only relevant for the very next render of "/".

export type Flash = {
  message: string;
  tab: "join" | "host";
  code?: string;
};

let pending: Flash | null = null;

export function setFlash(f: Flash): void {
  pending = f;
}

// takeFlash returns the pending flash once, then clears it.
export function takeFlash(): Flash | null {
  const f = pending;
  pending = null;
  return f;
}
