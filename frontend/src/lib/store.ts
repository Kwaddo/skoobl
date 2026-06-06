import { create } from "zustand";
import type { GameState, Phase, Player } from "./protocol";

interface GameStore {
  code: string;
  phase: Phase;
  host: string;
  players: Player[];
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
  self: "",
  error: null as string | null,
};

export const useGameStore = create<GameStore>((set) => ({
  ...initial,
  setSelf: (name) => set({ self: name }),
  applyState: (s) =>
    set({ code: s.code, phase: s.phase, host: s.host, players: s.players }),
  setError: (msg) => set({ error: msg }),
  reset: () => set({ ...initial }),
}));
