import { useCallback, useEffect, useRef, useState } from "react";
import { useCountdown } from "@/hooks/use-countdown";
import { useActiveEffects } from "@/hooks/use-effects";
import type { GameActions } from "@/hooks/use-game-socket";
import { downloadStrokesPng, pngFilename } from "@/lib/canvas";
import type { Stroke } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";
import { DrawingCanvas } from "../canvas/DrawingCanvas";
import { StrokesView } from "../canvas/StrokesView";
import { EffectLayer } from "../display/EffectLayer";
import { EndedStage } from "../display/EndedStage";
import { FeatureProgress } from "../display/FeatureProgress";
import { FlippedGuessing } from "../display/FlippedGuessing";
import { PlayerGrid } from "../display/PlayerList";
import { PowerupTray } from "../display/PowerupTray";
import { Timer } from "../display/Timer";
import { ArrowUp, Avatar, Brush, Check, Cross, Lock } from "../icons";

// PlayerStage is the phone controller. It owns the canvas (drawing) and the
// pick list (guessing); it never renders the drawing — players look at the host
// screen for that.
export function PlayerStage({
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
      return <PlayerLobby />;
    case "drawing":
      return <PlayerDrawing key={round} actions={actions} />;
    case "guessing":
      return <PlayerGuessing key={round} name={name} actions={actions} />;
    case "reveal":
      return <PlayerReveal name={name} />;
    case "ended":
      return <EndedStage name={name} screen="player" />;
    default:
      return null;
  }
}

function PlayerLobby() {
  const players = useGameStore((s) => s.players);
  return (
    <div className="m-auto flex w-full max-h-full min-h-0 flex-col gap-5 lg:max-w-3xl">
      <p className="shrink-0 rounded-xl border-2 border-dashed border-border px-4 py-5 text-center font-hand text-2xl leading-tight text-muted">
        you're in! waiting for the host to start
        <span className="live-dot ml-1 text-foreground">●</span>
      </p>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mb-3 flex shrink-0 items-baseline justify-between">
          <h2 className="ink-underline font-display text-xl font-black">
            Players
          </h2>
          <span
            className="sticker px-2 py-0.5 font-mono text-sm text-foreground"
            style={{ "--rot": "3deg" } as React.CSSProperties}
          >
            {players.length}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto pr-1">
          <PlayerGrid players={players} />
        </div>
      </div>
    </div>
  );
}

export function PlayerDrawing({ actions }: { actions: GameActions }) {
  const prompt = useGameStore((s) => s.yourPrompt);
  const endsAt = useGameStore((s) => s.phaseEndsAt);
  const players = useGameStore((s) => s.players);
  const round = useGameStore((s) => s.round);
  const drawMs = useGameStore((s) => s.drawMs);
  const recordDrawing = useGameStore((s) => s.recordDrawing);
  const connected = useGameStore((s) => s.connected);
  const mode = useGameStore((s) => s.mode);
  const remaining = useCountdown(endsAt);
  const effects = useActiveEffects();
  const [submitted, setSubmitted] = useState(false);
  const strokesRef = useRef<Stroke[]>([]);

  const submit = useCallback(() => {
    setSubmitted((was) => {
      if (!was) actions.submitDrawing(strokesRef.current);
      return true;
    });
  }, [actions]);

  // Auto-submit whatever is on the canvas when the clock runs out — but only
  // while connected. During a server restart (deploy) the socket drops yet the
  // local countdown keeps ticking; without this guard every client would hit 0
  // mid-blackout and buffer a lock-in, flipping the host to "everyone done" the
  // moment the new build resumes. On reconnect the server hands back a fresh
  // deadline, so remaining is no longer 0 and no spurious submit fires.
  useEffect(() => {
    if (remaining === 0 && !submitted && connected) submit();
  }, [remaining, submitted, submit, connected]);

  // Keep this round's final strokes for the player's own gallery + download,
  // even if they never tapped Lock-in (the cleanup fires when the round ends).
  useEffect(() => {
    return () => recordDrawing(round, strokesRef.current);
  }, [round, recordDrawing]);

  const drawn = players.filter((p) => p.locked).length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex flex-col items-start gap-1">
          <span
            className="sticker px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-foreground"
            style={{ "--rot": "-2.5deg" } as React.CSSProperties}
          >
            ✎ draw this
          </span>
          <span
            dir="auto"
            className="font-display text-3xl font-black text-foreground"
          >
            {prompt || "…"}
          </span>
        </div>
        <Timer remaining={remaining} total={Math.round(drawMs / 1000)} />
      </div>

      {mode === "frenzy" && <PowerupTray actions={actions} />}

      {submitted ? (
        <div className="ink-block tilt-l rise flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-10 text-center lg:mx-auto lg:max-w-2xl">
          <span className="stamp">
            <Lock className="float h-10 w-10 text-foreground" />
          </span>
          <h2 className="font-display text-xl font-black">Drawing locked in</h2>
          <p className="font-hand text-2xl leading-tight text-muted">
            {drawn} of {players.length} done — look up at the screen…
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <DrawingCanvas
            effects={effects}
            onChange={(s) => {
              strokesRef.current = s;
            }}
            onDraftAppend={(s) => actions.draftAppend(s)}
            onDraftReplace={(s) => actions.draftReplace(s)}
            footer={
              <button
                type="button"
                className="btn-key w-full whitespace-nowrap px-6 py-4 text-lg short:px-3 short:py-2.5 short:text-sm lg:px-3 lg:py-2.5 lg:text-sm"
                onClick={submit}
              >
                {/* full label when the button is full-width (stacked); the wide
                    display font overflows the narrow side column (short/lg), so
                    use a short label there instead of letting it clip */}
                <span className="short:hidden lg:hidden">
                  Lock in my drawing →
                </span>
                <span className="hidden short:inline lg:inline">Lock in →</span>
              </button>
            }
          />
        </div>
      )}
    </div>
  );
}

export function PlayerGuessing({
  name,
  actions,
}: {
  name: string;
  actions: GameActions;
}) {
  const youAreArtist = useGameStore((s) => s.youAreArtist);
  const yourGuess = useGameStore((s) => s.yourGuess);
  const players = useGameStore((s) => s.players);
  const endsAt = useGameStore((s) => s.phaseEndsAt);
  const guessMs = useGameStore((s) => s.guessMs);
  const featureIndex = useGameStore((s) => s.featureIndex);
  const featureCount = useGameStore((s) => s.featureCount);
  // In play-along rooms there is no shared screen, so the drawing to guess is
  // shown right here on each player's device instead of "look up at the screen".
  const hostPlays = useGameStore((s) => s.hostPlays);
  const drawing = useGameStore((s) => s.currentDrawing);
  const revealed = useGameStore((s) => s.revealed);
  const remaining = useCountdown(endsAt);

  const mode = useGameStore((s) => s.mode);
  const target = useGameStore((s) => s.target);
  const pool = useGameStore((s) => s.pool);
  const youAreTarget = useGameStore((s) => s.youAreTarget);
  const me = players.find((p) => p.name === name);
  const effects = useActiveEffects();

  if (pool.length > 0) {
    return (
      <FlippedGuessing
        target={target}
        pool={pool}
        youAreTarget={youAreTarget}
        alreadyGuessed={me?.hasGuessed ?? false}
        remaining={remaining}
        guessMs={guessMs}
        featureIndex={featureIndex}
        featureCount={featureCount}
        onPick={(id) => actions.submitDoodleGuess(id)}
        effects={effects}
        tray={mode === "frenzy" ? <PowerupTray actions={actions} /> : null}
      />
    );
  }

  // Only players who actually drew something this round can be the artist, so
  // they're the only ones worth voting for (non-drawers are excluded). Artists
  // already revealed earlier this round are dropped too — each player draws once,
  // so a revealed artist can't be behind the drawing on show.
  const options = players.filter(
    (p) => p.name !== name && p.hasDrawn && !revealed.includes(p.name),
  );
  const shownOptions = effects.has("shuffle")
    ? [...options].reverse()
    : options;
  // hidenames masks each option's name + avatar, so the victim must guess from
  // the drawing alone with no roster to read off.
  const hideNames = effects.has("hidenames");
  // Play-along rooms show the drawing inline, so desktop gets a two-pane split
  // (drawing beside the guess list); otherwise it's a single centred column.
  const showDrawing = hostPlays && !youAreArtist;

  return (
    <div
      className={`m-auto flex w-full max-h-full min-h-0 flex-col gap-4 ${
        showDrawing ? "lg:max-w-6xl" : "lg:max-w-3xl"
      }`}
    >
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex flex-col gap-2">
          <h2 className="ink-underline w-fit font-display text-2xl font-black">
            Who drew it?
          </h2>
          <FeatureProgress index={featureIndex} count={featureCount} />
          {!hostPlays && (
            <span className="flex items-center gap-1 font-hand text-xl text-muted">
              look up at the screen
              <ArrowUp className="h-4 w-4 text-foreground" />
            </span>
          )}
        </div>
        <Timer remaining={remaining} total={Math.round(guessMs / 1000)} />
      </div>

      {mode === "frenzy" && <PowerupTray actions={actions} />}

      {/* `contents` keeps the mobile stack identical (no extra box); on desktop
          it becomes the two-pane row holding the drawing and the guess list */}
      <div className="contents lg:flex lg:min-h-0 lg:flex-1 lg:flex-row lg:items-stretch lg:gap-6">
        {showDrawing && (
          <EffectLayer
            key={`drawing-${featureIndex}`}
            effects={effects}
            className="tape reveal-clip mt-2 aspect-4/3 max-h-[42vh] w-full overflow-hidden rounded-xl border-[2.5px] border-foreground bg-surface shadow-[5px_6px_0_0_var(--ink-edge)] lg:mt-0 lg:aspect-auto lg:h-full lg:w-3/5 lg:shrink-0"
          >
            <StrokesView strokes={drawing} className="h-full w-full" />
          </EffectLayer>
        )}

        {youAreArtist ? (
          <p className="ink-block tilt-r flex items-center justify-center gap-2 px-5 py-6 text-center font-hand text-2xl leading-tight text-muted lg:flex-1">
            <Brush className="h-5 w-5 shrink-0 text-foreground" />
            this one's yours — sit tight while everyone guesses.
          </p>
        ) : yourGuess ? (
          <p className="ink-block tilt-l px-5 py-6 text-center font-hand text-2xl leading-tight text-muted lg:flex-1 lg:self-center">
            you guessed{" "}
            <span
              dir="auto"
              className="font-display text-xl font-black text-foreground"
            >
              {yourGuess}
            </span>{" "}
            — waiting for the reveal…
          </p>
        ) : (
          // keyed by drawing so each new "who drew it?" re-staggers the choices in
          <ul
            key={`options-${featureIndex}`}
            className={`grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-auto p-1 sm:grid-cols-3 lg:auto-rows-min lg:content-start ${
              showDrawing ? "lg:grid-cols-2" : "lg:grid-cols-4"
            }`}
          >
            {shownOptions.map((p, i) => (
              <li key={p.name}>
                <button
                  type="button"
                  onClick={() => actions.submitGuess(p.name)}
                  className="card-arcade card-hover card-press pop flex h-full w-full items-center gap-2 p-3 text-left"
                  style={{ "--d": `${i * 35}ms` } as React.CSSProperties}
                >
                  {hideNames ? (
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-black/10 bg-foreground/10 font-display text-lg font-black text-muted">
                      ?
                    </span>
                  ) : (
                    <Avatar name={p.name} className="h-9 w-9 rounded-lg" />
                  )}
                  <span
                    dir="auto"
                    className={`truncate font-semibold ${hideNames ? "select-none blur-sm" : ""}`}
                  >
                    {hideNames ? "???" : p.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function PlayerReveal({
  name,
  actions,
  isHost = false,
}: {
  name: string;
  actions?: GameActions;
  isHost?: boolean;
}) {
  const reveal = useGameStore((s) => s.reveal);
  const players = useGameStore((s) => s.players);
  const round = useGameStore((s) => s.round);
  const mode = useGameStore((s) => s.mode);
  const answer = useGameStore((s) => s.currentDrawing);
  const totalRounds = useGameStore((s) => s.totalRounds);
  const featureIndex = useGameStore((s) => s.featureIndex);
  const featureCount = useGameStore((s) => s.featureCount);
  const myDrawings = useGameStore((s) => s.myDrawings);
  const mine = myDrawings[round] ?? [];
  const me = players.find((p) => p.name === name);
  const noArtist = !reveal?.artist;
  const youAreArtist = reveal?.artist === name;
  const got = me?.correct ?? false;
  // A playing host advances the round from their own screen (there's no TV).
  const moreDrawings = featureIndex < featureCount;
  const nextLabel = moreDrawings
    ? "Next drawing →"
    : round >= totalRounds
      ? "See final results →"
      : "Next round →";

  return (
    // The action/status stays pinned at the bottom so "Next round" is never
    // pushed off a short screen; only the reveal + drawing scroll. The whole
    // block centres when it's shorter than the controller (m-auto + max-h-full).
    <div className="m-auto flex max-h-full min-h-0 w-full flex-col gap-4 lg:max-w-5xl">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-1 pr-0.5">
        <FeatureProgress
          index={featureIndex}
          count={featureCount}
          className="justify-center"
        />
        {/* `contents` keeps the mobile stack; desktop puts the reveal card and
            your drawing side by side */}
        <div className="contents lg:flex lg:flex-row lg:items-stretch lg:gap-6">
          <div className="ink-block tilt-r rise flex flex-col items-center gap-3 p-10 text-center lg:flex-1 lg:justify-center">
            {noArtist ? (
              <>
                <Brush className="h-16 w-16 text-muted" />
                <h2 className="font-display text-3xl font-black">No drawing</h2>
                <p className="font-hand text-2xl text-muted">
                  nobody drew anything this round.
                </p>
              </>
            ) : (
              <>
                {/* keyed by drawing so the glyph re-stamps for each reveal in a round */}
                <span key={featureIndex} className="stamp text-foreground">
                  {youAreArtist ? (
                    <Brush className="h-16 w-16" />
                  ) : got ? (
                    <Check className="h-16 w-16" />
                  ) : (
                    <Cross className="h-16 w-16" />
                  )}
                </span>
                <h2 className="font-display text-3xl font-black">
                  {youAreArtist
                    ? "That was your drawing!"
                    : got
                      ? "Nice — you got it!"
                      : "Not this time"}
                </h2>
                <p className="font-hand text-2xl text-muted">
                  it was drawn by{" "}
                  <span
                    dir="auto"
                    className="font-display text-xl font-black text-foreground"
                  >
                    {reveal?.artist ?? "—"}
                  </span>
                </p>
                <p className="mt-1 flex items-center justify-center gap-2 font-display text-2xl font-black text-foreground">
                  {me?.roundScore != null && me.roundScore > 0 && (
                    <span
                      className="sticker sticker-solid stick-on px-2 py-0.5 text-base"
                      style={{ "--rot": "-3deg" } as React.CSSProperties}
                    >
                      +{me.roundScore}
                    </span>
                  )}
                  {me?.score ?? 0} pts
                </p>
              </>
            )}
          </div>

          {mode === "flipped" && answer.length > 0 && (
            <div className="card-arcade tape mt-3 flex shrink-0 flex-col gap-3 p-4 lg:mt-0 lg:flex-1">
              <span className="font-hand text-xl text-muted">
                {reveal?.artist ? `${reveal.artist}'s doodle` : "the answer"}
              </span>
              <StrokesView strokes={answer} />
            </div>
          )}

          {mine.length > 0 && (
            // mt-3 leaves room for the tape strip so it doesn't touch the card above
            <div className="card-arcade tape mt-3 flex shrink-0 flex-col gap-3 p-4 lg:mt-0 lg:flex-1">
              <span className="font-hand text-xl text-muted">your drawing</span>
              <StrokesView strokes={mine} />
              <button
                type="button"
                className="btn-ghost w-full px-4 py-2.5 text-sm"
                onClick={() => downloadStrokesPng(mine, pngFilename(round))}
              >
                Download PNG ↓
              </button>
            </div>
          )}
        </div>
      </div>

      {isHost && actions ? (
        <button
          type="button"
          className="btn-key w-full shrink-0 px-6 py-4 text-lg"
          onClick={actions.nextPhase}
        >
          {nextLabel}
        </button>
      ) : (
        <p className="shrink-0 text-center font-hand text-xl text-muted">
          waiting for the host to continue
          <span className="live-dot ml-1 text-foreground">●</span>
        </p>
      )}
    </div>
  );
}
