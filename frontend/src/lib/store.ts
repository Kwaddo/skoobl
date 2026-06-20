import { create } from "zustand";
import { syncClock } from "./clock";
import type {
  GameState,
  Language,
  Phase,
  Player,
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
  players: Player[];
  round: number;
  totalRounds: number;
  language: Language;
  drawMs: number;
  guessMs: number;
  phaseEndsAt: number;
  yourPrompt: string;
  currentDrawing: Stroke[];
  youAreArtist: boolean;
  yourGuess: string;
  reveal: Reveal | null;
  closed: boolean;
  notices: Notice[];
  self: string;
  error: string | null;
  setSelf: (name: string) => void;
  applyState: (s: GameState) => void;
  dismissNotice: (id: number) => void;
  setError: (msg: string | null) => void;
  reset: () => void;
}

const initial = {
  code: "",
  phase: "lobby" as Phase,
  host: "",
  players: [] as Player[],
  round: 0,
  totalRounds: 3,
  language: "en" as Language,
  drawMs: 80_000,
  guessMs: 25_000,
  phaseEndsAt: 0,
  yourPrompt: "",
  currentDrawing: [] as Stroke[],
  youAreArtist: false,
  yourGuess: "",
  reveal: null as Reveal | null,
  closed: false,
  notices: [] as Notice[],
  self: "",
  error: null as string | null,
};

export const useGameStore = create<GameStore>((set) => ({
  ...initial,
  setSelf: (name) => set({ self: name }),
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
        players: s.players ?? [],
        round: s.round ?? 0,
        totalRounds: s.totalRounds ?? initial.totalRounds,
        language: s.language ?? "en",
        drawMs: s.drawMs ?? initial.drawMs,
        guessMs: s.guessMs ?? initial.guessMs,
        phaseEndsAt: s.phaseEndsAt ?? 0,
        yourPrompt: s.yourPrompt ?? "",
        currentDrawing: s.currentDrawing ?? [],
        youAreArtist: s.youAreArtist ?? false,
        yourGuess: s.yourGuess ?? "",
        reveal: s.reveal ?? null,
        closed: s.closed ?? false,
        notices,
      };
    }),
  dismissNotice: (id) =>
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
  setError: (msg) => set({ error: msg }),
  reset: () => set({ ...initial, notices: [] }),
}));
