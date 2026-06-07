// Mirrors backend/internal/game state types. With Socket.IO the client emits
// named events (join, start, nextPhase, submitAnswer) and receives "state" /
// "error", so no envelope wrapper is needed.
export type Phase = "lobby" | "inRound" | "reveal" | "ended";

export interface Player {
  name: string;
  answer?: string;
}

export interface GameState {
  code: string;
  phase: Phase;
  host: string;
  players: Player[];
}

export interface ServerError {
  message: string;
}
