import type { PoolDrawing, Powerup } from "@/lib/protocol";
import { StrokesView } from "../canvas/StrokesView";
import { Brush } from "../icons";
import { EffectLayer } from "./EffectLayer";
import { FeatureProgress } from "./FeatureProgress";
import { Timer } from "./Timer";

// FlippedGuessing renders the "Whose Doodle" guess: a target name and a grid of
// anonymized candidate doodles. Pass onPick to make the tiles tappable (player
// controller); omit it for a read-only display (host TV).
export function FlippedGuessing({
  target,
  pool,
  youAreTarget = false,
  alreadyGuessed = false,
  remaining,
  guessMs,
  featureIndex,
  featureCount,
  onPick,
  effects = new Set<Powerup>(),
  tray,
}: {
  target: string;
  pool: PoolDrawing[];
  youAreTarget?: boolean;
  alreadyGuessed?: boolean;
  remaining: number | null;
  guessMs: number;
  featureIndex: number;
  featureCount: number;
  onPick?: (id: string) => void;
  effects?: Set<Powerup>;
  tray?: React.ReactNode;
}) {
  const shuffled = effects.has("shuffle")
    ? [...pool].sort((a, b) => a.id.localeCompare(b.id)).reverse()
    : pool;

  return (
    <div className="m-auto flex w-full max-h-full min-h-0 flex-col gap-4 lg:max-w-5xl">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex flex-col gap-2">
          <h2 className="ink-underline w-fit font-display text-2xl font-black">
            Which doodle is{" "}
            <span dir="auto" className="text-foreground">
              {target || "…"}
            </span>
            's?
          </h2>
          <FeatureProgress index={featureIndex} count={featureCount} />
        </div>
        <Timer remaining={remaining} total={Math.round(guessMs / 1000)} />
      </div>

      {tray}

      {youAreTarget ? (
        <p className="ink-block tilt-r flex items-center justify-center gap-2 px-5 py-6 text-center font-hand text-2xl leading-tight text-muted">
          <Brush className="h-5 w-5 shrink-0 text-foreground" />
          they're hunting for your doodle — sit tight.
        </p>
      ) : alreadyGuessed ? (
        <p className="ink-block tilt-l px-5 py-6 text-center font-hand text-2xl leading-tight text-muted">
          locked in — waiting for the reveal…
        </p>
      ) : (
        <EffectLayer effects={effects} className="min-h-0 flex-1">
          <ul
            key={`pool-${featureIndex}`}
            className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-auto p-1 sm:grid-cols-3 lg:grid-cols-4"
          >
            {shuffled.map((d, i) => (
              <li key={d.id}>
                <button
                  type="button"
                  disabled={!onPick}
                  onClick={() => onPick?.(d.id)}
                  className="card-arcade card-hover card-press pop tape block aspect-[4/3] w-full overflow-hidden p-1"
                  style={{ "--d": `${i * 35}ms` } as React.CSSProperties}
                >
                  <StrokesView strokes={d.strokes} className="h-full w-full" />
                </button>
              </li>
            ))}
          </ul>
        </EffectLayer>
      )}
    </div>
  );
}
