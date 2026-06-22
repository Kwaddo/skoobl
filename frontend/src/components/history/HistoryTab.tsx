import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { StrokesView } from "@/components/game/canvas/StrokesView";
import { downloadStrokesPng } from "@/lib/canvas";
import {
  clearHistory,
  deleteGame,
  historyPngName,
  loadHistory,
  type SavedDrawing,
  type SavedGame,
} from "@/lib/history";

// One tile in the history grid: a drawing plus the label shown beneath it, the
// viewer title, and the download filename. `caption` is the small label under
// the thumbnail ("you", an artist name, or "Round n").
interface Tile {
  caption: string;
  title: string;
  filename: string;
  drawing: SavedDrawing;
}

// One round's worth of tiles, used when a host saved everyone's art.
interface RoundGroup {
  round: number;
  tiles: Tile[];
}

// What the viewer overlays: a game's full ordered tile list plus which one is
// open, so the arrows can step through them. `list` is in the same order the
// tiles render, so left/right matches the on-screen reading order.
interface Picked {
  list: Tile[];
  index: number;
}

const sortedRounds = (obj: Record<number, unknown> | undefined): number[] =>
  Object.keys(obj ?? {})
    .map(Number)
    .sort((a, b) => a - b);

// HistoryTab is the landing-page History panel: a newest-first list of past
// games saved on THIS device. A normal game shows one thumbnail per round; a
// host's "everyone's art" game groups drawings by round with artist captions.
// Tapping a thumbnail opens a full-resolution viewer that arrows between the
// drawings and downloads each as a PNG.
export function HistoryTab() {
  const [games, setGames] = useState<SavedGame[]>(loadHistory);
  const [picked, setPicked] = useState<Picked | null>(null);

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
            <GameBody
              game={g}
              onPick={(list, index) => setPicked({ list, index })}
            />
          </li>
        ))}
      </ul>

      {picked && (
        <Viewer
          list={picked.list}
          index={picked.index}
          onIndex={(index) => setPicked({ list: picked.list, index })}
          onClose={() => setPicked(null)}
        />
      )}
    </div>
  );
}

// onPick opens the viewer with the game's whole ordered tile list and the index
// of the clicked tile.
type OnPick = (list: Tile[], index: number) => void;

// GameBody picks the layout: a host game with saved gallery art groups by round
// (artist captions, host's own shown once as "you"); any other game is the
// simple one-per-round strip.
function GameBody({ game, onPick }: { game: SavedGame; onPick: OnPick }) {
  if (game.gallery && Object.keys(game.gallery).length > 0) {
    return <GalleryRounds game={game} onPick={onPick} />;
  }
  return <OwnStrip game={game} onPick={onPick} />;
}

// OwnStrip renders the player's own drawings, one tile per round.
function OwnStrip({ game, onPick }: { game: SavedGame; onPick: OnPick }) {
  const tiles: Tile[] = sortedRounds(game.mine).map((r) => ({
    caption: `Round ${r}`,
    title: `Round ${r}`,
    filename: historyPngName(game.code, r),
    drawing: game.mine[r],
  }));
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {tiles.map((t, i) => (
        <TileButton key={t.title} tile={t} onOpen={() => onPick(tiles, i)} />
      ))}
    </ul>
  );
}

// GalleryRounds renders a host's "everyone's art" game grouped by round: the
// host's own drawing first (captioned "you"), then each other artist. The flat
// list (groups in order) feeds the viewer's arrows so they step round-by-round.
function GalleryRounds({ game, onPick }: { game: SavedGame; onPick: OnPick }) {
  const rounds = Array.from(
    new Set([...sortedRounds(game.mine), ...sortedRounds(game.gallery)]),
  ).sort((a, b) => a - b);

  const groups: RoundGroup[] = rounds.map((r) => {
    const tiles: Tile[] = [];
    const own = game.mine[r];
    if (own) {
      tiles.push({
        caption: "you",
        title: `Round ${r} · you`,
        filename: historyPngName(game.code, r),
        drawing: own,
      });
    }
    const byArtist = game.gallery?.[r] ?? {};
    for (const artist of Object.keys(byArtist)) {
      tiles.push({
        caption: artist,
        title: `Round ${r} · ${artist}`,
        filename: historyPngName(game.code, r, artist),
        drawing: byArtist[artist],
      });
    }
    return { round: r, tiles };
  });

  const flat = groups.flatMap((grp) => grp.tiles);

  return (
    <div className="flex flex-col gap-4">
      {groups.map((grp) => (
        <div key={grp.round} className="flex flex-col gap-2">
          <span className="font-mono text-xs uppercase tracking-widest text-muted">
            Round {grp.round}
          </span>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {grp.tiles.map((t) => (
              <TileButton
                key={t.title}
                tile={t}
                onOpen={() => onPick(flat, flat.indexOf(t))}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// TileButton is one clickable thumbnail with its caption beneath.
function TileButton({ tile, onOpen }: { tile: Tile; onOpen: () => void }) {
  return (
    <li className="flex flex-col gap-1">
      <button
        type="button"
        className="block w-full overflow-hidden rounded-lg border-2 border-border bg-surface"
        onClick={onOpen}
      >
        {tile.drawing.thumb ? (
          <img
            src={tile.drawing.thumb}
            alt={tile.title}
            className="aspect-4/3 w-full object-contain"
          />
        ) : (
          <StrokesView strokes={tile.drawing.strokes} />
        )}
      </button>
      <span className="truncate text-center font-hand text-base text-muted">
        {tile.caption}
      </span>
    </li>
  );
}

// Viewer is the full-resolution replay overlay for the picked drawing, with a
// PNG download and arrows that step through the game's drawings (wrapping at the
// ends; ← / → keys too). It is portalled to document.body: the landing card's
// entrance animation (.rise) leaves a transform on an ancestor, which would
// otherwise trap this `position: fixed` overlay inside the card. The backdrop
// fades and the panel pops in so it animates rather than cutting in.
function Viewer({
  list,
  index,
  onIndex,
  onClose,
}: {
  list: Tile[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const many = list.length > 1;
  const current = list[index];

  useEffect(() => {
    backdropRef.current?.focus();
  }, []);

  // Step through the drawings, wrapping past either end.
  const go = (delta: number) =>
    onIndex((index + delta + list.length) % list.length);

  // Arrow keys navigate, Escape closes — handled on the window so it works
  // regardless of which control last held focus (e.g. after clicking an arrow).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (many && e.key === "ArrowRight") {
        e.preventDefault();
        onIndex((index + 1) % list.length);
      } else if (many && e.key === "ArrowLeft") {
        e.preventDefault();
        onIndex((index - 1 + list.length) % list.length);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, list.length, many, onClose, onIndex]);

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss on click is intentional; key handling lives on the window listener above
    // biome-ignore lint/a11y/useKeyWithClickEvents: dismiss-on-click backdrop; Escape/arrow keys are handled by the window listener above
    <div
      ref={backdropRef}
      tabIndex={-1}
      className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 outline-none backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stop-propagation guard, not a semantic element */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stop-propagation guard only; window listener handles keyboard */}
      <div
        className="card-arcade pop flex max-h-[90dvh] w-full max-w-xl flex-col gap-4 overflow-y-auto p-4 sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-display text-lg font-bold">
            {current.title}
            {current.drawing.prompt ? ` — ${current.drawing.prompt}` : ""}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="btn-ghost px-3 py-1.5 text-sm"
              onClick={() =>
                downloadStrokesPng(current.drawing.strokes, current.filename)
              }
            >
              Download PNG
            </button>
            <button
              type="button"
              className="btn-ghost px-3 py-1.5 text-sm"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>

        <div className="relative">
          {/* Re-key on index so each navigation cross-fades the new drawing in. */}
          <div key={index} className="fade-in">
            <StrokesView strokes={current.drawing.strokes} />
          </div>
          {many && (
            <>
              <button
                type="button"
                aria-label="Previous drawing"
                className="btn-ghost absolute left-2 top-1/2 -translate-y-1/2 rounded-full border-2 border-border bg-surface/80 px-3 py-2 text-xl leading-none backdrop-blur-sm"
                onClick={() => go(-1)}
              >
                ‹
              </button>
              <button
                type="button"
                aria-label="Next drawing"
                className="btn-ghost absolute right-2 top-1/2 -translate-y-1/2 rounded-full border-2 border-border bg-surface/80 px-3 py-2 text-xl leading-none backdrop-blur-sm"
                onClick={() => go(1)}
              >
                ›
              </button>
            </>
          )}
        </div>

        {many && (
          <p className="text-center font-mono text-xs uppercase tracking-widest text-muted">
            {index + 1} / {list.length}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
