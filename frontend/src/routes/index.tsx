import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { HistoryTab } from "@/components/history/HistoryTab";
import { Segmented } from "@/components/Segmented";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { API_BASE } from "@/lib/config";
import { takeFlash } from "@/lib/flash";
import { recallName, rememberHostPlay, rememberName } from "@/lib/identity";
import { codeFromSearch } from "@/lib/join-link";
import { preflightJoin } from "@/lib/preflight";

export const Route = createFileRoute("/")({
  component: Home,
});

type Tab = "join" | "host" | "history";

// Marquee phrase (with a trailing separator so the repeated copies chain cleanly).
const TICKER = "draw • guess • laugh • win • ";

// The host is just the shared screen, not a player — it doesn't need a nickname.
// We give it a fixed identity so the backend (which requires a name) is happy.
const HOST_NAME = "Host";

function Home() {
  // If a room route bounced us back (name taken, bad code, …), seed the form
  // from the one-shot flash so the message shows inline and the fields are
  // prefilled for a quick retry.
  const [flash] = useState(takeFlash);
  // A scanned QR lands here with ?code=… ; prefill it and show the Join tab so
  // the player only has to enter a name. (Join is already the default tab.)
  const [scannedCode] = useState(() => codeFromSearch(window.location.search));
  const [tab, setTab] = useState<Tab>(flash?.tab ?? "join");
  // Prefill the player's last name, but never the auto "Host" identity.
  const [name, setName] = useState(() => {
    const n = recallName();
    return n === HOST_NAME ? "" : n;
  });
  const [code, setCode] = useState(flash?.code ?? scannedCode);
  const [error, setError] = useState<string | null>(flash?.message ?? null);
  const [busy, setBusy] = useState(false);
  // Host mode: "screen" ⇒ the host is the shared big screen (doesn't play);
  // "play" ⇒ the host joins the game as a player too.
  const [hostMode, setHostMode] = useState<"screen" | "play">("screen");
  const navigate = useNavigate();
  // Hosting is the shared big screen and can't run on a phone, so on mobile we
  // hide the Host tab and pin the form to Join. Tracked live in case of resize.
  const isMobile = useIsMobile();
  useEffect(() => {
    if (isMobile && tab === "host") setTab("join");
  }, [isMobile, tab]);

  const cleanName = name.trim();
  const cleanCode = code.trim().toLowerCase();

  const host = async () => {
    const playing = hostMode === "play";
    // A playing host is a real player, so it needs a name; a display host is just
    // the screen and uses the fixed Host identity.
    if (playing && !cleanName) return setError("Pick a name to play along.");
    const hostName = playing ? cleanName : HOST_NAME;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/games`, { method: "POST" });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { code: string };
      // Validate the host seat before leaving the form, so any rejection stays
      // here inline instead of flashing the room screen.
      const err = await preflightJoin(data.code, hostName, !playing, playing);
      if (err) {
        setError(err);
        setBusy(false);
        return;
      }
      rememberName(hostName);
      rememberHostPlay(playing);
      navigate({ to: "/host/$code", params: { code: data.code } });
    } catch {
      setError("Couldn't reach the server. Try again.");
      setBusy(false);
    }
  };

  const join = async () => {
    if (!cleanName) return setError("Pick a name before joining.");
    if (!cleanCode) return setError("Enter a room code to join.");
    setError(null);
    setBusy(true);
    // Validate against the room first: a wrong code or taken name shows inline
    // and the form stays put. Only a clean join transitions to the room.
    const err = await preflightJoin(cleanCode, cleanName, false);
    if (err) {
      setError(err);
      setBusy(false);
      return;
    }
    rememberName(cleanName);
    navigate({ to: "/play/$code", params: { code: cleanCode } });
  };

  const switchTab = (next: Tab) => {
    setTab(next);
    setError(null);
  };

  return (
    // The page locks to the viewport and centres the form when it fits; on a
    // short screen the inner column grows past the viewport and this scrolls, so
    // the whole form stays reachable on any height.
    <main className="grain-above relative h-dvh w-full overflow-y-auto overflow-x-hidden">
      <div className="fixed right-5 top-5 z-10">
        <ThemeToggle />
      </div>

      <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-7 px-6 py-8">
        {/* wordmark — the "oo" are a pair of wide-open eyes (draw + guess); a
          slapped-on sticker tags it above, a hand-inked marker swipe sits below */}
        <header className="rise flex flex-col items-center gap-3 text-center">
          <span
            className="sticker stick-on px-3 py-0.5 font-hand text-lg text-foreground"
            style={{ "--rot": "-3deg" } as React.CSSProperties}
          >
            ✎ party draw-&-guess
          </span>
          <h1 className="font-display text-7xl font-black leading-none tracking-tight text-foreground sm:text-8xl">
            sk
            <span
              className="float inline-block"
              style={{
                WebkitTextStroke: "2.5px var(--color-foreground)",
                color: "transparent",
              }}
            >
              oo
            </span>
            bl
          </h1>
          <span
            aria-hidden
            className="-mt-1 h-2.5 w-44 -rotate-1 rounded-full bg-foreground"
            style={{ borderRadius: "999px 999px 999px 3px" }}
          />
          <p className="mt-1 max-w-xs text-balance font-hand text-2xl leading-tight text-muted">
            draw the word, then guess who drew the one on screen.
          </p>
        </header>

        {/* console card — an inked, crop-marked panel like a printed game box */}
        <section
          className="ink-block crop-marks rise flex flex-col gap-6 p-6 sm:p-8"
          style={{ "--d": "90ms" } as React.CSSProperties}
        >
          {/* tabs — hosting needs a big screen, so phones only get Join + History */}
          <Segmented
            value={tab}
            onChange={(v) => switchTab(v)}
            options={
              isMobile
                ? [
                    { value: "join" as const, label: "Join" },
                    { value: "history" as const, label: "History" },
                  ]
                : [
                    { value: "join" as const, label: "Join a room" },
                    { value: "host" as const, label: "Host a game" },
                    { value: "history" as const, label: "History" },
                  ]
            }
            itemClassName="flex-1 px-4 py-2.5 text-sm font-bold"
          />

          {/* swapped per tab — keyed so it crossfades in on each switch. Join asks
            for a name + code; hosting needs neither (the host is the screen). */}
          <div
            key={tab}
            className="rise flex min-h-44 flex-col justify-center gap-6"
          >
            {tab === "history" ? (
              <HistoryTab />
            ) : tab === "join" ? (
              <>
                <label className="flex flex-col gap-2">
                  <span className="font-mono text-xs uppercase tracking-widest text-muted">
                    Your name
                  </span>
                  <input
                    dir="auto"
                    className="field px-4 py-3.5"
                    placeholder="e.g. captain chaos"
                    value={name}
                    maxLength={20}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (error) setError(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && join()}
                  />
                </label>
                <label className="flex flex-col gap-2">
                  <span className="font-mono text-xs uppercase tracking-widest text-muted">
                    Room code
                  </span>
                  <input
                    className="field px-4 py-3.5 text-center font-mono text-lg uppercase tracking-[0.3em]"
                    placeholder="code"
                    value={code}
                    maxLength={6}
                    onChange={(e) => {
                      setCode(e.target.value);
                      if (error) setError(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && join()}
                  />
                </label>
              </>
            ) : (
              <div className="flex flex-col gap-5">
                <Segmented
                  value={hostMode}
                  onChange={(v) => {
                    setHostMode(v);
                    setError(null);
                  }}
                  options={[
                    { value: "screen" as const, label: "Big screen" },
                    { value: "play" as const, label: "Play along" },
                  ]}
                  itemClassName="flex-1 px-4 py-2.5 text-sm font-bold"
                />
                {hostMode === "play" ? (
                  <label className="flex flex-col gap-2">
                    <span className="font-mono text-xs uppercase tracking-widest text-muted">
                      Your name
                    </span>
                    <input
                      dir="auto"
                      className="field px-4 py-3.5"
                      placeholder="e.g. captain chaos"
                      value={name}
                      maxLength={20}
                      onChange={(e) => {
                        setName(e.target.value);
                        if (error) setError(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && host()}
                    />
                    <span className="font-hand text-lg text-muted">
                      you'll draw &amp; guess like everyone — the drawing shows
                      on each player's own screen.
                    </span>
                  </label>
                ) : (
                  <p className="rounded-xl border-2 border-dashed border-border px-5 py-6 text-center font-hand text-xl leading-snug text-muted">
                    you're the big screen — no nickname needed. start a room and
                    share the code for everyone to join from their phones.
                  </p>
                )}
              </div>
            )}
          </div>

          {tab !== "history" && (
            <button
              type="button"
              className="btn-key w-full px-6 py-4 text-lg"
              onClick={tab === "host" ? host : join}
              disabled={busy}
            >
              {tab === "host"
                ? busy
                  ? "Creating room…"
                  : hostMode === "play"
                    ? "Host & play"
                    : "Host a game"
                : busy
                  ? "Joining…"
                  : "Join room"}
            </button>
          )}

          {error && (
            <p className="rise flex items-center justify-center gap-2 rounded-xl border-2 border-foreground bg-surface-2 px-4 py-3 text-center text-sm font-bold text-foreground">
              <span aria-hidden className="font-display text-base">
                !
              </span>
              {error}
            </p>
          )}
        </section>

        {/* gamey ticker strip — two identical halves so the loop is seamless */}
        <div
          className="rise overflow-hidden rounded-full border-2 border-border py-1.5"
          style={{ "--d": "150ms" } as React.CSSProperties}
        >
          <div className="marquee-track font-display text-[11px] font-black uppercase tracking-[0.35em] text-muted">
            <span className="px-2">{TICKER.repeat(6)}</span>
            <span className="px-2">{TICKER.repeat(6)}</span>
          </div>
        </div>

        <p
          className="rise text-center font-hand text-xl text-muted"
          style={{ "--d": "200ms" } as React.CSSProperties}
        >
          no app · no signup · just a code
        </p>
      </div>
    </main>
  );
}
