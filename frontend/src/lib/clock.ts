// A shared, server-anchored clock. The countdown deadline (phaseEndsAt) is an
// absolute server timestamp, so rendering it against a device's own Date.now()
// makes the timer drift by however far that device's clock is off the server's —
// which is why the host and a player could show different seconds remaining.
//
// Every "state" broadcast carries the server's clock at send time (serverNow).
// syncClock turns that into an offset (serverNow − local now); now() then reports
// the server's time on this device, so all clients agree regardless of skew. The
// one-way network latency baked into the offset is tens of ms — negligible at the
// timer's 1s granularity, and roughly equal across clients.

let offset = 0; // serverNow − Date.now(), in ms

// syncClock records the server/device clock gap from a fresh serverNow stamp.
export function syncClock(serverNow: number | undefined): void {
  if (serverNow) offset = serverNow - Date.now();
}

// now returns the current time on the server's clock, as seen from this device.
export function now(): number {
  return Date.now() + offset;
}
