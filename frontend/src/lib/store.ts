import { create } from "zustand";
import type {
  GameState,
  Language,
  Phase,
  Player,
  Reveal,
  Stroke,
} from "./protocol";

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
  self: string;
  error: string | null;
  setSelf: (name: string) => void;
  applyState: (s: GameState) => void;
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
  self: "",
  error: null as string | null,
};

export const useGameStore = create<GameStore>((set) => ({
  ...initial,
  setSelf: (name) => set({ self: name }),
  applyState: (s) =>
    set({
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
    }),
  setError: (msg) => set({ error: msg }),
  reset: () => set({ ...initial }),
}));
