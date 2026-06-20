// Mirrors backend/internal/game state types. With Socket.IO the client emits
// named events (join, configure, start, submitDrawing, submitGuess, nextPhase)
// and receives "state" (a per-recipient view) / "error", so no envelope wrapper
// is needed.
//
// The server sends each client a *redacted* view: secret round data (other
// players' prompts, the featured artist, drawings before the guessing phase) is
// never present. Recipient-specific fields (yourPrompt, youAreArtist, …) are set
// only for the client they belong to.

export type Phase = "lobby" | "drawing" | "guessing" | "reveal" | "ended";

// Language only selects which prompt words appear (and their text direction);
// all other UI text stays English.
export type Language = "en" | "ar";

export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  color: string;
  width: number;
  points: Point[];
}

export interface Player {
  name: string;
  score?: number;
  connected?: boolean;
  hasDrawn?: boolean;
  hasGuessed?: boolean;
  correct?: boolean;
  roundScore?: number;
}

export interface Reveal {
  artist: string;
  prompt: string;
}

export interface GameState {
  code: string;
  phase: Phase;
  host: string;
  players: Player[];
  round?: number;
  totalRounds?: number;
  language?: Language;
  drawMs?: number;
  guessMs?: number;
  phaseEndsAt?: number;
  // Server clock at the moment this state was sent (unix ms). Used to correct the
  // countdown for device clock skew so every client agrees on the time left.
  serverNow?: number;
  // Recipient-specific fields.
  you?: string;
  yourPrompt?: string;
  currentDrawing?: Stroke[];
  youAreArtist?: boolean;
  yourGuess?: string;
  reveal?: Reveal | null;
  // Final frame sent when the host leaves: the room is gone, kick to the menu.
  closed?: boolean;
}

// GameConfig is the host's lobby setup sent via the "configure" event.
export interface GameConfig {
  rounds: number;
  language: Language;
  categories: string[];
  drawMs: number;
  guessMs: number;
}

export interface ServerError {
  message: string;
}
