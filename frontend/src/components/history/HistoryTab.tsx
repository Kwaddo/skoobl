import { useEffect, useRef, useState } from "react";
import { StrokesView } from "@/components/game/canvas/StrokesView";
import {
  clearHistory,
  deleteGame,
  loadHistory,
  type SavedDrawing,
  type SavedGame,
} from "@/lib/history";

// A flat drawing entry for the expanded viewer: a round's own drawing or a
// gallery artist's drawing.
interface Selected {
  title: string;
  drawing: SavedDrawing;
}

// HistoryTab is the landing-page History panel: a newest-first list of past
// games saved on THIS device, each a strip of round thumbnails. Tapping a
// thumbnail opens a full-resolution replay. Games can be removed individually or
// all at once. Reads localStorage into local state on mount; mutations refresh it.
export function HistoryTab() {
  const [games, setGames] = useState<SavedGame[]>(loadHistory);
  const [selected, setSelected] = useState<Selected | null>(null);

  const refresh = () => setGames(loadHistory());

  const remove = (id: string) => {
    deleteGame(id);
    refresh();
  };
  const clearAll = () => {
    clearHistory();
    setGames([]);
  };

  if (games.length === 0) {
    return (
      <p className="rounded-xl border-2 border-dashed border-border px-5 py-10 text-center font-hand text-xl leading-snug text-muted">
        no saved drawings yet — play a game and your art shows up here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs uppercase tracking-widest text-muted">
          {games.length} saved {games.length === 1 ? "game" : "games"}
        </span>
        <button
          type="button"
          className="btn-ghost px-3 py-1.5 text-sm"
          onClick={clearAll}
        >
          Clear all
        </button>
      </div>

      <ul className="flex max-h-[50vh] flex-col gap-4 overflow-auto pr-1">
        {games.map((g) => (
          <li key={g.id} className="card-arcade flex flex-col gap-3 p-3">
            <div className="flex items-center justify-between">
              <span className="font-display text-sm font-bold uppercase tracking-widest">
                {g.code}
              </span>
              <div className="flex items-center gap-3">
                <span className="font-hand text-lg text-muted">
                  {new Date(g.playedAt).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  aria-label={`Delete game ${g.code}`}
                  className="btn-ghost px-2 py-1 text-sm"
                  onClick={() => remove(g.id)}
                >
                  ✕
                </button>
              </div>
            </div>
            <Thumbs game={g} onPick={setSelected} />
          </li>
        ))}
      </ul>

      {selected && (
        <Viewer selected={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// Thumbs renders a game's round thumbnails: the player's own drawings first,
// then any saved gallery art (round → artist). Each opens the viewer on click.
function Thumbs({
  game,
  onPick,
}: {
  game: SavedGame;
  onPick: (s: Selected) => void;
}) {
  const tiles: Selected[] = [];
  for (const r of Object.keys(game.mine)
    .map(Number)
    .sort((a, b) => a - b)) {
    tiles.push({ title: `Round ${r}`, drawing: game.mine[r] });
  }
  for (const r of Object.keys(game.gallery ?? {})
    .map(Number)
    .sort((a, b) => a - b)) {
    const byArtist = game.gallery?.[r] ?? {};
    for (const artist of Object.keys(byArtist)) {
      tiles.push({
        title: `Round ${r} · ${artist}`,
        drawing: byArtist[artist],
      });
    }
  }

  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {tiles.map((t) => (
        <li key={t.title}>
          <button
            type="button"
            className="block w-full overflow-hidden rounded-lg border-2 border-border bg-surface"
            onClick={() => onPick(t)}
          >
            {t.drawing.thumb ? (
              <img
                src={t.drawing.thumb}
                alt={t.title}
                className="aspect-4/3 w-full object-contain"
              />
            ) : (
              <StrokesView strokes={t.drawing.strokes} />
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

// Viewer is the full-resolution replay overlay for one picked drawing.
function Viewer({
  selected,
  onClose,
}: {
  selected: Selected;
  onClose: () => void;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    backdropRef.current?.focus();
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss on click/key is intentional; focused on mount so Escape fires here
    <div
      ref={backdropRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 outline-none"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stop-propagation guard, not a semantic element */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stop-propagation guard only; Close button handles keyboard dismiss */}
      <div
        className="flex w-full max-w-2xl flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="font-display text-lg font-bold">
            {selected.title}
            {selected.drawing.prompt ? ` — ${selected.drawing.prompt}` : ""}
          </span>
          <button
            type="button"
            className="btn-ghost px-3 py-1.5 text-sm"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <StrokesView strokes={selected.drawing.strokes} />
      </div>
    </div>
  );
}
