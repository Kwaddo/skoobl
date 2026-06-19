import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Segmented } from "@/components/Segmented";
import { ThemeToggle } from "@/components/ThemeToggle";
import { API_BASE } from "@/lib/config";
import { takeFlash } from "@/lib/flash";
import { recallName, rememberName } from "@/lib/identity";
import { preflightJoin } from "@/lib/preflight";

export const Route = createFileRoute("/")({
  component: Home,
});

type Tab = "join" | "host";

// The host is just the shared screen, not a player — it doesn't need a nickname.
// We give it a fixed identity so the backend (which requires a name) is happy.
const HOST_NAME = "Host";

function Home() {
  // If a room route bounced us back (name taken, bad code, …), seed the form
  // from the one-shot flash so the message shows inline and the fields are
  // prefilled for a quick retry.
  const [flash] = useState(takeFlash);
  const [tab, setTab] = useState<Tab>(flash?.tab ?? "join");
  // Prefill the player's last name, but never the auto "Host" identity.
  const [name, setName] = useState(() => {
    const n = recallName();
    return n === HOST_NAME ? "" : n;
  });
  const [code, setCode] = useState(flash?.code ?? "");
  const [error, setError] = useState<string | null>(flash?.message ?? null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const cleanName = name.trim();
  const cleanCode = code.trim().toLowerCase();

  const host = async () => {
    // No nickname needed — the host is the screen, not a player.
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/games`, { method: "POST" });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { code: string };
      // Validate the host seat before leaving the form, so any rejection stays
      // here inline instead of flashing the room screen.
      const err = await preflightJoin(data.code, HOST_NAME, true);
      if (err) {
        setError(err);
        setBusy(false);
        return;
      }
      rememberName(HOST_NAME);
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
    <main className="grain-above relative mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-10 px-6 py-12">
      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>

      {/* wordmark */}
      <header className="rise flex flex-col items-center gap-3 text-center">
        <span className="font-mono text-xs uppercase tracking-[0.45em] text-muted">
          party rounds · live
        </span>
        <h1 className="font-display text-7xl font-black leading-none tracking-tight text-foreground sm:text-8xl">
          sk
          <span
            className="float inline-block"
            style={{
              WebkitTextStroke: "2px var(--color-foreground)",
              color: "transparent",
            }}
          >
            oo
          </span>
          bl
        </h1>
        <p className="max-w-xs text-balance text-sm text-muted">
          Draw the word, then guess who drew the one on screen.
        </p>
      </header>

      {/* console card */}
      <section
        className="card-arcade rise flex flex-col gap-6 p-6 sm:p-8"
        style={{ "--d": "90ms" } as React.CSSProperties}
      >
        {/* tabs */}
        <Segmented
          value={tab}
          onChange={(v) => switchTab(v)}
          options={[
            { value: "join", label: "Join a room" },
            { value: "host", label: "Host a game" },
          ]}
          itemClassName="flex-1 px-4 py-2.5 text-sm font-bold"
        />

        {/* swapped per tab — keyed so it crossfades in on each switch. Join asks
            for a name + code; hosting needs neither (the host is the screen). */}
        <div key={tab} className="rise flex min-h-[11rem] flex-col justify-center gap-6">
          {tab === "join" ? (
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
            <p className="rounded-xl border border-dashed border-border px-5 py-6 text-center text-sm text-muted">
              You're the big screen — no nickname needed. Start a room and share
              the code for everyone to join from their phones.
            </p>
          )}
        </div>

        <button
          type="button"
          className="btn-key w-full px-6 py-4 text-lg"
          onClick={tab === "host" ? host : join}
          disabled={busy}
        >
          {tab === "host"
            ? busy
              ? "Creating room…"
              : "Host a game"
            : busy
              ? "Joining…"
              : "Join room"}
        </button>

        {error && (
          <p className="rise rounded-xl border-2 border-red-500/70 bg-red-500/10 px-4 py-3 text-center text-sm font-medium text-red-500">
            {error}
          </p>
        )}
      </section>

      <p
        className="rise text-center font-mono text-[11px] uppercase tracking-widest text-muted/70"
        style={{ "--d": "180ms" } as React.CSSProperties}
      >
        no app · no signup · just a code
      </p>
    </main>
  );
}
