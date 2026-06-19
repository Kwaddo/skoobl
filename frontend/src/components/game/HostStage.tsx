import { useCallback, useState } from "react";
import { Segmented } from "@/components/Segmented";
import { useCountdown } from "@/hooks/use-countdown";
import type { GameActions } from "@/hooks/use-game-socket";
import { useGameStore } from "@/lib/store";
import { Brush } from "./icons";
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

// The big drawing on the host TV is a box that FILLS its cell (so the screen
// never looks half-empty); the strokes scale up inside it with object-contain,
// keeping their aspect ratio. HOST_CANVAS_BOX styles the box, HOST_CANVAS the
// canvas that fills it.
const HOST_CANVAS_BOX =
  "min-h-0 overflow-hidden rounded-2xl border-2 border-border bg-surface shadow-[0_24px_60px_-28px_rgba(0,0,0,0.55)]";
const HOST_CANVAS = "h-full w-full object-contain";

// Panel is a host dashboard card that fills its column and scrolls its body when
// the content is taller than the space — the workhorse that keeps the big screen
// looking full and organized instead of leaving floating gaps.
function Panel({
  title,
  aside,
  children,
  className = "",
}: {
  title?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card-arcade flex min-h-0 flex-col p-4 sm:p-5 ${className}`}>
      {(title || aside) && (
        <div className="mb-3 flex shrink-0 items-baseline justify-between gap-3">
          {title && (
            <h2 className="font-display text-lg font-bold sm:text-xl">{title}</h2>
          )}
          {aside}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto pr-1">{children}</div>
    </div>
  );
}

function HostLobby({ actions }: { actions: GameActions }) {
  const code = useGameStore((s) => s.code);
  const players = useGameStore((s) => s.players);
  const connected = players.filter((p) => p.connected).length;
  const canStart = connected >= MIN_PLAYERS;

  return (
    <div className="grid h-full min-h-0 gap-6 lg:grid-cols-[1.05fr_0.95fr]">
      {/* left: share the code + see who's in */}
      <div className="flex min-h-0 flex-col gap-5">
        <CodeCard code={code} />
        <Panel
          className="flex-1"
          title="In the lobby"
          aside={
            <span className="font-mono text-sm text-muted">
              {players.length} {players.length === 1 ? "player" : "players"}
            </span>
          }
        >
          <PlayerGrid players={players} />
        </Panel>
      </div>

      {/* right: settings + start */}
      <div className="flex min-h-0 flex-col gap-5">
        <div className="flex min-h-0 flex-1 flex-col">
          <HostConfig actions={actions} />
        </div>
        <button
          type="button"
          className="btn-key w-full shrink-0 px-6 py-4 text-lg"
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
    <div className="flex h-full min-h-0 flex-col gap-5">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            Everyone is drawing
          </span>
          <span
            dir="auto"
            className="font-display text-3xl font-bold sm:text-4xl"
          >
            {prompt || "…"}
          </span>
        </div>
        <Timer remaining={remaining} />
      </div>
      <Panel
        className="flex-1"
        title="Sketching…"
        aside={
          <span className="font-mono text-sm text-muted">
            {drawn} of {players.length} finished
          </span>
        }
      >
        <Roster players={players} mode="drawing" />
      </Panel>
    </div>
  );
}

function HostGuessing() {
  const drawing = useGameStore((s) => s.currentDrawing);
  const players = useGameStore((s) => s.players);
  const endsAt = useGameStore((s) => s.phaseEndsAt);
  const remaining = useCountdown(endsAt);
  const guessed = players.filter((p) => p.hasGuessed).length;

  return (
    <div className="grid h-full min-h-0 gap-6 lg:grid-cols-[1.6fr_1fr]">
      <div className="flex min-h-0 flex-col gap-4">
        <div className="flex shrink-0 items-center justify-between gap-3">
          <h2 className="font-display text-2xl font-bold sm:text-3xl">
            Who drew this?
          </h2>
          <Timer remaining={remaining} />
        </div>
        <div className={`flex-1 ${HOST_CANVAS_BOX}`}>
          <StrokesView strokes={drawing} className={HOST_CANVAS} />
        </div>
      </div>
      <Panel
        className="flex-1"
        title="Players"
        aside={
          <span className="font-mono text-sm text-muted">
            {guessed}/{players.length} guessed
          </span>
        }
      >
        <Roster players={players} mode="guessing" />
      </Panel>
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
  // A round where nobody drew anything skips guessing and lands here with no
  // artist — show a "nobody drew" message instead of a blank canvas.
  const noArtist = !reveal?.artist;

  return (
    <div className="grid h-full min-h-0 gap-6 lg:grid-cols-[1.6fr_1fr]">
      {noArtist ? (
        <div
          className={`flex flex-col items-center justify-center gap-3 p-8 text-center ${HOST_CANVAS_BOX}`}
        >
          <Brush className="h-12 w-12 text-muted" />
          <p className="font-display text-2xl font-bold">
            Nobody drew anything
          </p>
          <p className="text-sm text-muted">
            Everyone ran out of time or left the canvas blank.
          </p>
        </div>
      ) : (
        <div className={HOST_CANVAS_BOX}>
          <StrokesView strokes={drawing} className={HOST_CANVAS} />
        </div>
      )}

      <div className="flex min-h-0 flex-col gap-4">
        <div className="card-arcade rise flex shrink-0 flex-col gap-1 p-5 text-center">
          {noArtist ? (
            <>
              <span className="font-display text-2xl font-bold">
                No drawing this round
              </span>
              {reveal?.prompt && (
                <span dir="auto" className="text-sm text-muted">
                  the word was: {reveal.prompt}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="font-mono text-xs uppercase tracking-widest text-muted">
                It was drawn by
              </span>
              <span dir="auto" className="font-display text-2xl font-bold">
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
            </>
          )}
        </div>

        <Panel className="flex-1" title="Leaderboard">
          <Scoreboard players={players} />
        </Panel>

        <button
          type="button"
          className="btn-key w-full shrink-0 px-6 py-4 text-lg"
          onClick={actions.nextPhase}
        >
          {isLast ? "See final results →" : "Next round →"}
        </button>
      </div>
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
    <div className="card-arcade flex h-full min-h-0 flex-col gap-5 overflow-auto p-4 sm:p-5">
      <h3 className="shrink-0 font-display text-lg font-bold">Game settings</h3>

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

      {/* Slides + fades open/closed. The grid-rows 0fr→1fr trick animates the
          height smoothly; the negative margin cancels the parent's gap while
          collapsed so nothing leaves a dead space behind. */}
      <div
        className={`grid transition-all duration-300 ease-out-soft ${
          mode === "custom"
            ? "mt-0 grid-rows-[1fr] opacity-100"
            : "-mt-5 grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
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
              disabled={mode !== "custom"}
              tabIndex={mode === "custom" ? 0 : -1}
              className="field resize-y px-3 py-2 text-sm"
            />
          </label>
        </div>
      </div>
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
      <span className="w-6 overflow-hidden text-center font-display text-lg font-bold">
        <span key={value} className="pop block">
          {value}
        </span>
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
