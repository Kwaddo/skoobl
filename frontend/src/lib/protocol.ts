// Mirrors backend/internal/protocol and internal/game state types.
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

export type CommandType =
  | "join"
  | "leave"
  | "start"
  | "submitAnswer"
  | "nextPhase";

export type EventType = "state" | "error" | "gameEnded";

export interface Envelope<T = unknown> {
  type: CommandType | EventType;
  payload?: T;
}

export const cmd = {
  join: (player: string): Envelope => ({ type: "join", payload: { player } }),
  start: (): Envelope => ({ type: "start" }),
  nextPhase: (): Envelope => ({ type: "nextPhase" }),
  submitAnswer: (answer: string): Envelope => ({
    type: "submitAnswer",
    payload: { answer },
  }),
};
