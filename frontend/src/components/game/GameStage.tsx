import { Navigate, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCountdown } from "@/hooks/use-countdown";
import { useGameSocket } from "@/hooks/use-game-socket";
import { avatarColor, avatarEmoji } from "@/lib/avatar";
import { recallName } from "@/lib/identity";
import type { Player, Stroke } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";
import { DrawingCanvas } from "./DrawingCanvas";
import { StrokesView } from "./StrokesView";

const MIN_PLAYERS = 4;

type Actions = ReturnType<typeof useGameSocket>;

// parseCategories turns the host's free-text box (one word per line, commas also
// accepted) into a clean list. The server re-validates and caps it.
function parseCategories(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

// GameStage is the whole in-room experience, shared by the /host and /play
// routes — everyone draws, guesses, and scores; the host additionally configures
// the lobby and advances rounds. It renders the right phase view from the store.
export function GameStage({ code }: { code: string }) {
  const name = recallName();
  const navigate = useNavigate();
  const actions = useGameSocket(code, name);
  const phase = useGameStore((s) => s.phase);
  const host = useGameStore((s) => s.host);
  const round = useGameStore((s) => s.round);
  const error = useGameStore((s) => s.error);
  const isHost = name === host;

  // Leave now: tell the room to remove us (immediate host promotion / reap),
  // then head home — the socket disconnects on unmount as a no-op follow-up.
  const handleLeave = useCallback(() => {
    actions.leave();
    navigate({ to: "/" });
  }, [actions, navigate]);

  if (!name) return <Navigate to="/" />;
  if (error) return <ErrorPanel message={error} />;

  return (
    <main className="grain-above mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 px-5 py-8">
      <RoomHeader code={code} name={name} onLeave={handleLeave} />

      <section className="flex flex-1 flex-col">
        {phase === "lobby" && <LobbyStage code={code} isHost={isHost} actions={actions} />}
        {phase === "drawing" && <DrawingStage key={round} actions={actions} />}
        {phase === "guessing" && <GuessingStage key={round} name={name} actions={actions} />}
        {phase === "reveal" && <RevealStage isHost={isHost} actions={actions} />}
        {phase === "ended" && <EndedStage name={name} />}
      </section>
    </main>
  );
}

// ── header ────────────────────────────────────────────────────────────────

function RoomHeader({
  code,
  name,
  onLeave,
}: {
  code: string;
  name: string;
  onLeave: () => void;
}) {
  const phase = useGameStore((s) => s.phase);
  const round = useGameStore((s) => s.round);
  const totalRounds = useGameStore((s) => s.totalRounds);
  return (
    <header className="rise flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span
          className="flex h-11 w-11 items-center justify-center rounded-xl text-2xl"
          style={{ backgroundColor: avatarColor(name) }}
        >
          {avatarEmoji(name)}
        </span>
        <div className="flex flex-col">
          <span dir="auto" className="font-display text-lg font-bold leading-tight">
            {name}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            room {code}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden items-center gap-2 rounded-full border border-border bg-surface-2 px-3 py-1.5 sm:flex">
          <span className="live-dot h-2 w-2 rounded-full bg-primary" />
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            {phase === "lobby" || phase === "ended"
              ? phase
              : `round ${round}/${totalRounds} · ${phase}`}
          </span>
        </span>
        <button
          type="button"
          onClick={onLeave}
          className="btn-ghost px-3 py-1.5 text-sm"
          title="Leave the room"
        >
          Leave
        </button>
      </div>
    </header>
  );
}

// ── lobby ─────────────────────────────────────────────────────────────────

function LobbyStage({
  code,
  isHost,
  actions,
}: {
  code: string;
  isHost: boolean;
  actions: Actions;
}) {
  const players = useGameStore((s) => s.players);
  const connected = players.filter((p) => p.connected).length;
  const canStart = connected >= MIN_PLAYERS;

  return (
    <div className="flex flex-col gap-6">
      <CodeCard code={code} />

      <div>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-xl font-bold">In the lobby</h2>
          <span className="font-mono text-sm text-muted">
            {players.length} {players.length === 1 ? "player" : "players"}
          </span>
        </div>
        <PlayerGrid players={players} />
      </div>

      {isHost ? (
        <>
          <HostConfig actions={actions} />
          <button
            type="button"
            className="btn-key w-full px-6 py-4 text-lg"
            onClick={actions.start}
            disabled={!canStart}
          >
            {canStart
              ? "Start the game →"
              : `Need ${MIN_PLAYERS - connected} more player${
                  MIN_PLAYERS - connected === 1 ? "" : "s"
                }…`}
          </button>
        </>
      ) : (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted">
          Waiting for the host to start the game
          <span className="live-dot ml-1 text-primary">●</span>
        </p>
      )}
    </div>
  );
}

function CodeCard({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="card-arcade flex items-center justify-between gap-4 p-5">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-xs uppercase tracking-widest text-muted">
          Room code
        </span>
        <button type="button" onClick={copy} className="group flex items-center gap-3 text-left">
          <span className="font-mono text-3xl font-bold uppercase tracking-[0.2em] text-primary">
            {code}
          </span>
          <span className="rounded-lg border border-border px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors group-hover:border-primary group-hover:text-primary">
            {copied ? "copied!" : "copy"}
          </span>
        </button>
      </div>
    </div>
  );
}

const DRAW_TIME_OPTIONS = [30, 60, 80, 120];
const GUESS_TIME_OPTIONS = [15, 25, 40, 60];
type CategoryMode = "random" | "custom";

function HostConfig({ actions }: { actions: Actions }) {
  // Local form state is the source of truth while editing (only the host edits,
  // so it isn't clobbered by other clients' broadcasts). Seeded once from the
  // store's current/default values, then pushed to the server on every change.
  const [rounds, setRounds] = useState(() => useGameStore.getState().totalRounds);
  const [language, setLanguage] = useState(() => useGameStore.getState().language);
  const [drawSec, setDrawSec] = useState(() =>
    Math.round(useGameStore.getState().drawMs / 1000),
  );
  const [guessSec, setGuessSec] = useState(() =>
    Math.round(useGameStore.getState().guessMs / 1000),
  );
  const [mode, setMode] = useState<CategoryMode>("random");
  const [categories, setCategories] = useState("");

  const sync = useCallback(
    (
      over: Partial<{
        rounds: number;
        language: typeof language;
        drawSec: number;
        guessSec: number;
        mode: CategoryMode;
        categories: string;
      }>,
    ) => {
      const next = { rounds, language, drawSec, guessSec, mode, categories, ...over };
      actions.configure({
        rounds: next.rounds,
        language: next.language,
        drawMs: next.drawSec * 1000,
        guessMs: next.guessSec * 1000,
        categories:
          next.mode === "custom" ? parseCategories(next.categories) : [],
      });
    },
    [actions, rounds, language, drawSec, guessSec, mode, categories],
  );

  return (
    <div className="card-arcade flex flex-col gap-5 p-5">
      <h3 className="font-display text-lg font-bold">Game settings</h3>

      <Row label="Rounds">
        <Stepper
          value={rounds}
          min={1}
          max={8}
          onChange={(n) => {
            setRounds(n);
            sync({ rounds: n });
          }}
        />
      </Row>

      <Row label="Category language">
        <Segmented
          value={language}
          options={[
            { value: "en" as const, label: "English" },
            { value: "ar" as const, label: "العربية" },
          ]}
          onChange={(v) => {
            setLanguage(v);
            sync({ language: v });
          }}
        />
      </Row>

      <Row label="Draw time">
        <Segmented
          value={drawSec}
          options={DRAW_TIME_OPTIONS.map((s) => ({ value: s, label: `${s}s` }))}
          onChange={(v) => {
            setDrawSec(v);
            sync({ drawSec: v });
          }}
        />
      </Row>

      <Row label="Guess time">
        <Segmented
          value={guessSec}
          options={GUESS_TIME_OPTIONS.map((s) => ({ value: s, label: `${s}s` }))}
          onChange={(v) => {
            setGuessSec(v);
            sync({ guessSec: v });
          }}
        />
      </Row>

      <Row label="Categories">
        <Segmented
          value={mode}
          options={[
            { value: "random" as const, label: "Random" },
            { value: "custom" as const, label: "Custom" },
          ]}
          onChange={(v) => {
            setMode(v);
            sync({ mode: v });
          }}
        />
      </Row>

      {mode === "custom" && (
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">
            One word per line — these replace the random pool.
          </span>
          <textarea
            dir="auto"
            rows={3}
            value={categories}
            placeholder={"pizza\nrobot\ncastle"}
            onChange={(e) => setCategories(e.target.value)}
            onBlur={() => sync({})}
            className="field resize-y px-3 py-2 text-sm"
          />
        </label>
      )}
    </div>
  );
}

// Row is a labelled settings line: label on the left, control on the right.
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </div>
  );
}

// Segmented is a pill-style single-choice control matching the arcade theme.
function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-xl border-2 border-border bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
            value === o.value
              ? "bg-primary text-primary-foreground"
              : "text-muted hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Stepper is a −/＋ number control, avoiding the jank of a controlled number
// input that round-trips through the (clamping) server on every keystroke.
function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const set = (n: number) => onChange(Math.max(min, Math.min(max, n)));
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        aria-label="decrease"
        className="btn-ghost h-9 w-9 p-0 text-xl leading-none"
        onClick={() => set(value - 1)}
        disabled={value <= min}
      >
        −
      </button>
      <span className="w-6 text-center font-display text-lg font-bold">{value}</span>
      <button
        type="button"
        aria-label="increase"
        className="btn-ghost h-9 w-9 p-0 text-xl leading-none"
        onClick={() => set(value + 1)}
        disabled={value >= max}
      >
        +
      </button>
    </div>
  );
}

// ── drawing ─────────────────────────────────────────────────────────────--

function DrawingStage({ actions }: { actions: Actions }) {
  const prompt = useGameStore((s) => s.yourPrompt);
  const endsAt = useGameStore((s) => s.phaseEndsAt);
  const players = useGameStore((s) => s.players);
  const remaining = useCountdown(endsAt);
  const [submitted, setSubmitted] = useState(false);
  const strokesRef = useRef<Stroke[]>([]);

  const submit = useCallback(() => {
    setSubmitted((was) => {
      if (!was) actions.submitDrawing(strokesRef.current);
      return true;
    });
  }, [actions]);

  // Auto-submit whatever is on the canvas when the clock runs out.
  useEffect(() => {
    if (remaining === 0 && !submitted) submit();
  }, [remaining, submitted, submit]);

  const drawn = players.filter((p) => p.hasDrawn).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            Draw this
          </span>
          <span dir="auto" className="font-display text-2xl font-bold text-primary">
            {prompt || "…"}
          </span>
        </div>
        <Timer remaining={remaining} />
      </div>

      {submitted ? (
        <div className="card-arcade flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
          <span className="text-3xl">🔒</span>
          <h2 className="font-display text-xl font-bold">Drawing locked in</h2>
          <p className="text-sm text-muted">
            {drawn} of {players.length} done — waiting for the rest…
          </p>
        </div>
      ) : (
        <>
          <DrawingCanvas
            onChange={(s) => {
              strokesRef.current = s;
            }}
          />
          <button type="button" className="btn-key w-full px-6 py-4 text-lg" onClick={submit}>
            Lock in my drawing →
          </button>
        </>
      )}
    </div>
  );
}

// ── guessing ────────────────────────────────────────────────────────────--

function GuessingStage({ name, actions }: { name: string; actions: Actions }) {
  const drawing = useGameStore((s) => s.currentDrawing);
  const youAreArtist = useGameStore((s) => s.youAreArtist);
  const yourGuess = useGameStore((s) => s.yourGuess);
  const players = useGameStore((s) => s.players);
  const endsAt = useGameStore((s) => s.phaseEndsAt);
  const remaining = useCountdown(endsAt);

  const options = players.filter((p) => p.name !== name);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-2xl font-bold">Who drew this?</h2>
        <Timer remaining={remaining} />
      </div>

      <StrokesView strokes={drawing} />

      {youAreArtist ? (
        <p className="card-arcade px-5 py-6 text-center text-sm text-muted">
          This one's yours 🎨 — sit tight while everyone guesses.
        </p>
      ) : yourGuess ? (
        <p className="card-arcade px-5 py-6 text-center">
          You guessed{" "}
          <span dir="auto" className="font-display font-bold text-primary">
            {yourGuess}
          </span>
          . Waiting for the reveal…
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {options.map((p) => (
            <li key={p.name}>
              <button
                type="button"
                onClick={() => actions.submitGuess(p.name)}
                className="card-arcade flex w-full items-center gap-2 p-3 text-left transition-transform hover:-translate-y-0.5 hover:border-primary"
              >
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg"
                  style={{ backgroundColor: avatarColor(p.name) }}
                >
                  {avatarEmoji(p.name)}
                </span>
                <span dir="auto" className="truncate font-semibold">
                  {p.name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── reveal ──────────────────────────────────────────────────────────────--

function RevealStage({ isHost, actions }: { isHost: boolean; actions: Actions }) {
  const drawing = useGameStore((s) => s.currentDrawing);
  const reveal = useGameStore((s) => s.reveal);
  const players = useGameStore((s) => s.players);
  const round = useGameStore((s) => s.round);
  const totalRounds = useGameStore((s) => s.totalRounds);
  const isLast = round >= totalRounds;
  const correct = players.filter((p) => p.correct);

  return (
    <div className="flex flex-col gap-4">
      <StrokesView strokes={drawing} />

      <div className="card-arcade flex flex-col gap-1 p-5 text-center">
        <span className="font-mono text-xs uppercase tracking-widest text-muted">
          It was drawn by
        </span>
        <span dir="auto" className="font-display text-2xl font-bold text-primary">
          {reveal?.artist ?? "—"}
        </span>
        {reveal?.prompt && (
          <span dir="auto" className="text-sm text-muted">
            prompt: {reveal.prompt}
          </span>
        )}
        <span className="mt-2 text-sm">
          {correct.length === 0
            ? "Nobody guessed right!"
            : `${correct.length} guessed it: `}
          <span dir="auto" className="font-semibold">
            {correct.map((p) => p.name).join(", ")}
          </span>
        </span>
      </div>

      <Scoreboard players={players} />

      {isHost ? (
        <button
          type="button"
          className="btn-key btn-key--pink w-full px-6 py-4 text-lg"
          onClick={actions.nextPhase}
        >
          {isLast ? "See final results →" : "Next round →"}
        </button>
      ) : (
        <p className="text-center text-sm text-muted">
          Waiting for the host to continue
          <span className="live-dot ml-1 text-primary">●</span>
        </p>
      )}
    </div>
  );
}

// ── ended ───────────────────────────────────────────────────────────────--

function EndedStage({ name }: { name: string }) {
  const navigate = useNavigate();
  const players = useGameStore((s) => s.players);
  const ranked = [...players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const winner = ranked[0];
  const youWon = winner?.name === name;

  return (
    <div className="flex flex-col gap-5">
      <div className="card-arcade flex flex-col items-center gap-2 p-8 text-center">
        <span className="text-4xl">{youWon ? "🏆" : "🎉"}</span>
        <h2 className="font-display text-2xl font-bold">Game over</h2>
        {winner && (
          <p className="text-sm text-muted">
            Winner:{" "}
            <span dir="auto" className="font-display font-bold text-primary">
              {winner.name}
            </span>{" "}
            with {winner.score ?? 0} pts
          </p>
        )}
      </div>

      <Scoreboard players={players} />

      <button
        type="button"
        className="btn-key w-full px-6 py-4 text-lg"
        onClick={() => navigate({ to: "/" })}
      >
        Back to start
      </button>
    </div>
  );
}

// ── shared bits ─────────────────────────────────────────────────────────--

function Scoreboard({ players }: { players: Player[] }) {
  const host = useGameStore((s) => s.host);
  const ranked = [...players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return (
    <ol className="flex flex-col gap-2">
      {ranked.map((p, i) => (
        <li
          key={p.name}
          className="card-arcade flex items-center gap-3 p-3"
        >
          <span className="w-6 text-center font-display text-sm font-bold text-muted">
            {i + 1}
          </span>
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg"
            style={{ backgroundColor: avatarColor(p.name) }}
          >
            {avatarEmoji(p.name)}
          </span>
          <span dir="auto" className="flex min-w-0 flex-1 items-center gap-1.5 font-semibold">
            <span className="truncate">{p.name}</span>
            {p.name === host && <LeaderBadge />}
            {p.connected === false && (
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
                away
              </span>
            )}
          </span>
          {p.correct && (
            <span title="guessed correctly" className="text-base font-bold text-[#7CFF6B]">
              ✓
            </span>
          )}
          <span className="font-mono text-sm font-bold text-primary">{p.score ?? 0}</span>
        </li>
      ))}
    </ol>
  );
}

// LeaderBadge marks the current host/leader wherever players are listed.
function LeaderBadge() {
  return (
    <span
      title="leader"
      className="flex items-center gap-1 rounded-full border border-primary/50 bg-primary/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-primary"
    >
      👑 leader
    </span>
  );
}

function PlayerGrid({ players }: { players: Player[] }) {
  const host = useGameStore((s) => s.host);
  if (players.length === 0) {
    return (
      <div className="card-arcade flex flex-col items-center gap-2 border-dashed px-6 py-10 text-center">
        <span className="live-dot text-3xl">👀</span>
        <p className="font-display text-lg font-bold">Nobody here yet</p>
        <p className="text-sm text-muted">Share the code above to fill the room.</p>
      </div>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {players.map((p) => (
        <li key={p.name} className="card-arcade flex items-center gap-3 p-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-2xl"
            style={{ backgroundColor: avatarColor(p.name) }}
          >
            {avatarEmoji(p.name)}
          </span>
          <span className="flex min-w-0 flex-col">
            <span dir="auto" className="truncate font-semibold">
              {p.name}
            </span>
            {p.name === host && (
              <span className="font-mono text-[10px] uppercase tracking-widest text-primary">
                👑 leader
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Timer({ remaining }: { remaining: number | null }) {
  if (remaining === null) return null;
  const low = remaining <= 5;
  return (
    <span
      className={`flex h-12 w-12 items-center justify-center rounded-xl border-2 font-mono text-lg font-bold ${
        low ? "border-secondary text-secondary" : "border-border text-foreground"
      }`}
    >
      {remaining}
    </span>
  );
}

function ErrorPanel({ message }: { message: string }) {
  const navigate = useNavigate();
  return (
    <main className="grain-above mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="card-arcade rise flex flex-col items-center gap-4 p-8">
        <span className="text-4xl">🚫</span>
        <h1 className="font-display text-2xl font-bold">{message}</h1>
        <button type="button" className="btn-key px-6 py-3" onClick={() => navigate({ to: "/" })}>
          Back to start
        </button>
      </div>
    </main>
  );
}
