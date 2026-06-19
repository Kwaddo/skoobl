import { useCallback, useState } from "react";
import { useCountdown } from "@/hooks/use-countdown";
import type { GameActions } from "@/hooks/use-game-socket";
import { useGameStore } from "@/lib/store";
import { StrokesView } from "./StrokesView";
import {
  CodeCard,
  EndedStage,
  PlayerGrid,
  Roster,
  Scoreboard,
  Timer,
} from "./shared";

const MIN_PLAYERS = 4;

// parseCategories turns the host's free-text box (one word per line, commas also
// accepted) into a clean list. The server re-validates and caps it.
function parseCategories(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

// HostStage is the shared "TV": a non-playing display. It shows the lobby +
// settings, who has finished each phase, the drawing to be guessed, and the
// reveal/scoreboard. It never draws or guesses.
export function HostStage({
  name,
  actions,
}: {
  name: string;
  actions: GameActions;
}) {
  const phase = useGameStore((s) => s.phase);
  const round = useGameStore((s) => s.round);

  switch (phase) {
    case "lobby":
      return <HostLobby actions={actions} />;
    case "drawing":
      return <HostDrawing key={round} />;
    case "guessing":
      return <HostGuessing key={round} />;
    case "reveal":
      return <HostReveal actions={actions} />;
    case "ended":
      return <EndedStage name={name} onPlayAgain={actions.returnToLobby} />;
    default:
      return null;
  }
}

function HostLobby({ actions }: { actions: GameActions }) {
  const code = useGameStore((s) => s.code);
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
    </div>
  );
}

function HostDrawing() {
  const prompt = useGameStore((s) => s.yourPrompt);
  const endsAt = useGameStore((s) => s.phaseEndsAt);
  const players = useGameStore((s) => s.players);
  const remaining = useCountdown(endsAt);
  const drawn = players.filter((p) => p.hasDrawn).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            Everyone is drawing
          </span>
          <span
            dir="auto"
            className="font-display text-3xl font-bold text-primary"
          >
            {prompt || "…"}
          </span>
        </div>
        <Timer remaining={remaining} />
      </div>
      <p className="font-mono text-sm text-muted">
        {drawn} of {players.length} finished
      </p>
      <Roster players={players} mode="drawing" />
    </div>
  );
}

function HostGuessing() {
  const drawing = useGameStore((s) => s.currentDrawing);
  const players = useGameStore((s) => s.players);
  const endsAt = useGameStore((s) => s.phaseEndsAt);
  const remaining = useCountdown(endsAt);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-3xl font-bold">Who drew this?</h2>
        <Timer remaining={remaining} />
      </div>
      <StrokesView strokes={drawing} />
      <Roster players={players} mode="guessing" />
    </div>
  );
}

function HostReveal({ actions }: { actions: GameActions }) {
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
        <span
          dir="auto"
          className="font-display text-2xl font-bold text-primary"
        >
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

      <button
        type="button"
        className="btn-key btn-key--pink w-full px-6 py-4 text-lg"
        onClick={actions.nextPhase}
      >
        {isLast ? "See final results →" : "Next round →"}
      </button>
    </div>
  );
}

// ── host settings ───────────────────────────────────────────────────────---

const DRAW_TIME_OPTIONS = [30, 60, 80, 120];
const GUESS_TIME_OPTIONS = [15, 25, 40, 60];
type CategoryMode = "random" | "custom";

function HostConfig({ actions }: { actions: GameActions }) {
  // Local form state is the source of truth while editing (only the host edits,
  // so it isn't clobbered by other clients' broadcasts). Seeded once from the
  // store's current/default values, then pushed to the server on every change.
  const [rounds, setRounds] = useState(
    () => useGameStore.getState().totalRounds,
  );
  const [language, setLanguage] = useState(
    () => useGameStore.getState().language,
  );
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
      const next = {
        rounds,
        language,
        drawSec,
        guessSec,
        mode,
        categories,
        ...over,
      };
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
          options={GUESS_TIME_OPTIONS.map((s) => ({
            value: s,
            label: `${s}s`,
          }))}
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
function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
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
      <span className="w-6 text-center font-display text-lg font-bold">
        {value}
      </span>
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
