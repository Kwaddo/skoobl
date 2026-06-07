import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { API_BASE } from "@/lib/config";
import { rememberName } from "@/lib/identity";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
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
          Spin up a room, share the code, and pile your friends into the lobby.
        </p>
      </header>

      {/* console card */}
      <section
        className="card-arcade rise flex flex-col gap-6 p-6 sm:p-8"
        style={{ "--d": "90ms" } as React.CSSProperties}
      >
        <label className="flex flex-col gap-2">
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            Your name
          </span>
          <input
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
        </label>

        <button
          type="button"
          className="btn-key w-full px-6 py-4 text-lg"
          onClick={host}
          disabled={busy}
        >
          {busy ? "Creating room…" : "Host a game"}
        </button>

        <div className="flex items-center gap-4 text-muted">
          <span className="h-px flex-1 bg-border" />
          <span className="font-mono text-xs uppercase tracking-widest">
            or
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            className="field px-4 py-3.5 text-center font-mono uppercase tracking-[0.3em] sm:flex-1"
            placeholder="code"
            value={code}
            maxLength={6}
            onChange={(e) => {
              setCode(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && join()}
          />
          <button
            type="button"
            className="btn-ghost px-6 py-3.5 sm:w-auto"
            onClick={join}
          >
            Join room
          </button>
        </div>

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
