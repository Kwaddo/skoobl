import { useCallback, useState } from "react";
import { Segmented } from "@/components/Segmented";
import type { GameActions } from "@/hooks/use-game-socket";
import { getSaveGalleryPref, setSaveGalleryPref } from "@/lib/history";
import type { GameMode } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";

const DRAW_TIME_OPTIONS = [30, 60, 80, 120];
const GUESS_TIME_OPTIONS = [15, 25, 40, 60];
type CategoryMode = "random" | "custom";

// parseCategories turns the host's free-text box (one word per line, commas also
// accepted) into a clean list. The server re-validates and caps it.
function parseCategories(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

// HostConfig is the lobby settings form — rounds, category language, draw/guess
// time, and the random-vs-custom category pool. Only the host edits it, so local
// form state is the source of truth and is pushed to the server on every change.
export function HostConfig({ actions }: { actions: GameActions }) {
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
  const [gameMode, setGameMode] = useState<GameMode>(
    () => useGameStore.getState().mode,
  );
  const [mode, setMode] = useState<CategoryMode>("random");
  const [categories, setCategories] = useState("");
  // Device-local pref (not a game setting): also archive every player's drawing
  // to THIS device's history. Persisted to localStorage, never sent to the server.
  const [saveGallery, setSaveGallery] = useState(getSaveGalleryPref);

  const sync = useCallback(
    (
      over: Partial<{
        rounds: number;
        language: typeof language;
        drawSec: number;
        guessSec: number;
        gameMode: GameMode;
        mode: CategoryMode;
        categories: string;
      }>,
    ) => {
      const next = {
        rounds,
        language,
        drawSec,
        guessSec,
        gameMode,
        mode,
        categories,
        ...over,
      };
      actions.configure({
        rounds: next.rounds,
        language: next.language,
        drawMs: next.drawSec * 1000,
        guessMs: next.guessSec * 1000,
        mode: next.gameMode,
        categories:
          next.mode === "custom" ? parseCategories(next.categories) : [],
      });
    },
    [actions, rounds, language, drawSec, guessSec, gameMode, mode, categories],
  );

  return (
    <div className="card-arcade flex h-full min-h-0 flex-col gap-5 overflow-auto p-4 sm:p-5">
      <h3 className="ink-underline w-fit shrink-0 font-display text-lg font-black">
        Game settings
      </h3>

      <Row label="Mode">
        <Segmented
          value={gameMode}
          options={[
            { value: "classic" as const, label: "Classic" },
            { value: "flipped" as const, label: "Whose Doodle" },
            { value: "frenzy" as const, label: "Frenzy" },
          ]}
          onChange={(v) => {
            setGameMode(v);
            sync({ gameMode: v });
          }}
        />
      </Row>

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

      <Row label="Save everyone's art here">
        <Segmented
          value={saveGallery ? "on" : "off"}
          options={[
            { value: "off" as const, label: "Off" },
            { value: "on" as const, label: "On" },
          ]}
          onChange={(v) => {
            const on = v === "on";
            setSaveGallery(on);
            setSaveGalleryPref(on);
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
            <span className="font-hand text-lg text-muted">
              one word per line — these replace the random pool.
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
      <span className="text-sm font-bold">{label}</span>
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
