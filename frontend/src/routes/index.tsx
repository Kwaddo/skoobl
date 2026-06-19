import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { API_BASE } from "@/lib/config";
import { rememberName } from "@/lib/identity";

export const Route = createFileRoute("/")({
  component: Home,
});

type Tab = "join" | "host";

function Home() {
  const [tab, setTab] = useState<Tab>("join");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const cleanName = name.trim();
  const cleanCode = code.trim().toLowerCase();

  const host = async () => {
    if (!cleanName) return setError("Pick a name before hosting.");
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/games`, { method: "POST" });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { code: string };
      rememberName(cleanName);
      navigate({ to: "/host/$code", params: { code: data.code } });
    } catch {
      setError("Couldn't reach the server. Try again.");
      setBusy(false);
    }
  };

  const join = () => {
    if (!cleanName) return setError("Pick a name before joining.");
    if (!cleanCode) return setError("Enter a room code to join.");
    setError(null);
    rememberName(cleanName);
    navigate({ to: "/play/$code", params: { code: cleanCode } });
  };

  const switchTab = (next: Tab) => {
    setTab(next);
    setError(null);
  };

  return (
    <main className="grain-above relative mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-10 px-6 py-12">
      {/* wordmark */}
      <header className="rise flex flex-col items-center gap-3 text-center">
        <span className="font-mono text-xs uppercase tracking-[0.45em] text-muted">
          party rounds · live
        </span>
        <h1 className="font-display text-7xl font-black leading-none tracking-tight text-foreground sm:text-8xl">
          sk
          <span className="text-primary">oo</span>
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
        <div className="flex gap-1 rounded-2xl border-2 border-border bg-surface-2 p-1">
          <TabButton active={tab === "join"} onClick={() => switchTab("join")}>
            Join a room
          </TabButton>
          <TabButton active={tab === "host"} onClick={() => switchTab("host")}>
            Host a game
          </TabButton>
        </div>

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
            onKeyDown={(e) => e.key === "Enter" && (tab === "host" ? host() : join())}
          />
        </label>

        {tab === "join" ? (
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
        ) : (
          <p className="rounded-xl border border-dashed border-border px-4 py-3 text-center text-sm text-muted">
            You'll get a room code to share once the lobby opens.
          </p>
        )}

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
            : "Join room"}
        </button>

        {error && (
          <p className="rounded-xl border-2 border-secondary/40 bg-secondary/10 px-4 py-3 text-center text-sm font-medium text-secondary">
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

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
