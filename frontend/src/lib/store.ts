import { create } from "zustand";
import { syncClock } from "./clock";
import type {
  GameMode,
  GameState,
  Language,
  Phase,
  Player,
  PoolDrawing,
  Reveal,
  Stroke,
} from "./protocol";

// A transient, dismissible toast (someone left, bounced back to lobby, …).
export interface Notice {
  id: number;
  text: string;
}

// Monotonic id for notices, so each toast is keyed and dismissed independently.
let noticeSeq = 0;

// inGamePhase mirrors the backend's Phase.inGame: a round is actively underway.
const inGamePhase = (p: Phase) =>
  p === "drawing" || p === "guessing" || p === "reveal";

// The store mirrors the latest server view of the room. Every "state" broadcast
// replaces it wholesale via applyState; components select the slices they need.
interface GameStore {
  code: string;
  phase: Phase;
  host: string;
  hostPlays: boolean;
  mode: GameMode;
  players: Player[];
  round: number;
  totalRounds: number;
  featureIndex: number;
  featureCount: number;
  language: Language;
  drawMs: number;
  guessMs: number;
  phaseEndsAt: number;
  yourPrompt: string;
  currentDrawing: Stroke[];
  gallery: Record<string, Stroke[]>;
  // The player's own drawings this game, keyed by round (for the game-end
  // gallery + download). Accumulated client-side; cleared back in the lobby.
  myDrawings: Record<number, Stroke[]>;
  // The host accumulates every reveal's gallery (all players' drawings, keyed by
  // round → artist) so the final results can carousel through the whole game.
  // Only the host receives `gallery`, so this stays empty on player clients.
  galleryHistory: Record<number, Record<string, Stroke[]>>;
  youAreArtist: boolean;
  yourGuess: string;
  reveal: Reveal | null;
  target: string;
  youAreTarget: boolean;
  pool: PoolDrawing[];
  revealed: string[];
  roundFeatured: string[];
  closed: boolean;
  notices: Notice[];
  self: string;
  error: string | null;
  // Whether this client has a live socket carrying current state. False between
  // a drop and the first broadcast after reconnect, so consumers can hold off on
  // clock-driven actions (e.g. the drawing auto-submit) during a blackout.
  connected: boolean;
  setSelf: (name: string) => void;
  applyState: (s: GameState) => void;
  recordDrawing: (round: number, strokes: Stroke[]) => void;
  dismissNotice: (id: number) => void;
  setError: (msg: string | null) => void;
  setConnected: (v: boolean) => void;
  reset: () => void;
}

const initial = {
  code: "",
  phase: "lobby" as Phase,
  host: "",
  hostPlays: false,
  mode: "classic" as GameMode,
  players: [] as Player[],
  round: 0,
  totalRounds: 3,
  featureIndex: 0,
  featureCount: 0,
  language: "en" as Language,
  drawMs: 80_000,
  guessMs: 25_000,
  phaseEndsAt: 0,
  yourPrompt: "",
  currentDrawing: [] as Stroke[],
  gallery: {} as Record<string, Stroke[]>,
  myDrawings: {} as Record<number, Stroke[]>,
  galleryHistory: {} as Record<number, Record<string, Stroke[]>>,
  youAreArtist: false,
  yourGuess: "",
  reveal: null as Reveal | null,
  target: "",
  youAreTarget: false,
  pool: [] as PoolDrawing[],
  revealed: [] as string[],
  roundFeatured: [] as string[],
  closed: false,
  notices: [] as Notice[],
  self: "",
  error: null as string | null,
  connected: false,
};

export const useGameStore = create<GameStore>((set) => ({
  ...initial,
  setSelf: (name) => set({ self: name }),
  recordDrawing: (round, strokes) =>
    set((s) => ({ myDrawings: { ...s.myDrawings, [round]: strokes } })),
  applyState: (s) =>
    set((prev) => {
      // Re-anchor the shared clock to the server on every broadcast, so the
      // countdown is immune to this device's clock being off (see lib/clock).
      syncClock(s.serverNow);
      // Diff the roster against the previous broadcast: any name that vanished
      // was actually removed (left or pruned past grace) — a mere disconnect
      // keeps them in the roster marked away, so this never false-fires. Skip
      // while closing; the player is about to be kicked to the menu anyway.
      const nextNames = new Set((s.players ?? []).map((p) => p.name));
      const departed = prev.players
        .map((p) => p.name)
        .filter((n) => !nextNames.has(n));
      const notices = [...prev.notices];
      if (!s.closed) {
        for (const n of departed) {
          notices.push({ id: ++noticeSeq, text: `${n} left the room` });
        }
        // Returned to the lobby mid-game (host abandoned, or dropped below the
        // minimum). Suppressed when a "left" toast already explains the bounce.
        if (
          departed.length === 0 &&
          inGamePhase(prev.phase) &&
          s.phase === "lobby"
        ) {
          notices.push({ id: ++noticeSeq, text: "Back in the lobby" });
        }
      }
      return {
        code: s.code,
        phase: s.phase,
        host: s.host,
        hostPlays: s.hostPlays ?? false,
        mode: s.mode ?? "classic",
        players: s.players ?? [],
        round: s.round ?? 0,
        totalRounds: s.totalRounds ?? initial.totalRounds,
        featureIndex: s.featureIndex ?? 0,
        featureCount: s.featureCount ?? 0,
        language: s.language ?? "en",
        drawMs: s.drawMs ?? initial.drawMs,
        guessMs: s.guessMs ?? initial.guessMs,
        phaseEndsAt: s.phaseEndsAt ?? 0,
        yourPrompt: s.yourPrompt ?? "",
        currentDrawing: s.currentDrawing ?? [],
        gallery: s.gallery ?? {},
        // Wipe the player's own gallery when a new game starts (back in lobby).
        myDrawings: s.phase === "lobby" ? {} : prev.myDrawings,
        // Host-only: fold each reveal's gallery into the per-round history;
        // wiped back in the lobby like the rest of a game's drawing data.
        galleryHistory:
          s.phase === "lobby"
            ? {}
            : s.gallery && Object.keys(s.gallery).length > 0 && s.round
              ? { ...prev.galleryHistory, [s.round]: s.gallery }
              : prev.galleryHistory,
        youAreArtist: s.youAreArtist ?? false,
        yourGuess: s.yourGuess ?? "",
        reveal: s.reveal ?? null,
        target: s.target ?? "",
        youAreTarget: s.youAreTarget ?? false,
        pool: s.pool ?? [],
        revealed: s.revealed ?? [],
        roundFeatured: s.roundFeatured ?? [],
        closed: s.closed ?? false,
        notices,
      };
    }),
  dismissNotice: (id) =>
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
  setError: (msg) => set({ error: msg }),
  setConnected: (v) => set({ connected: v }),
  reset: () => set({ ...initial, notices: [] }),
}));
