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

// Round variant. Classic is the current game; flipped is "Whose Doodle".
export type GameMode = "classic" | "flipped" | "frenzy";

export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  color: string;
  width: number;
  points: Point[];
  // A flood-fill op: points[0] is the seed, color is the fill color.
  fill?: boolean;
}

// A Frenzy sabotage item.
export type Powerup =
  | "fog"
  | "lights"
  | "flip"
  | "cramp"
  | "squint"
  | "curtain"
  | "shuffle"
  | "hidenames";

// An active effect inflicted on this client by a Frenzy effect wave. startsAt is
// when it begins striking (unix ms): the server staggers it into the near future
// so the hit lands at an unpredictable moment, and the client only renders the
// effect once startsAt has passed. Absent/0 means strike immediately.
export interface ActiveEffect {
  kind: Powerup;
  startsAt?: number;
  endsAt: number;
}

// One anonymized candidate doodle in flipped guessing.
export interface PoolDrawing {
  id: string;
  strokes: Stroke[];
}

export interface Player {
  name: string;
  score?: number;
  connected?: boolean;
  hasDrawn?: boolean;
  hasGuessed?: boolean;
  correct?: boolean;
  roundScore?: number;
  locked?: boolean;
}

export interface Reveal {
  artist: string;
  prompt: string;
}

export interface GameState {
  code: string;
  phase: Phase;
  host: string;
  mode?: GameMode;
  // true ⇒ the host is also a player (no separate display screen); false ⇒ the
  // host is the non-playing big screen.
  hostPlays?: boolean;
  players: Player[];
  round?: number;
  totalRounds?: number;
  // A round guesses through several drawings, one at a time. featureIndex is the
  // 1-based drawing on show; featureCount is how many this round has. Lets the UI
  // render "Drawing 2 of 3".
  featureIndex?: number;
  featureCount?: number;
  language?: Language;
  drawMs?: number;
  guessMs?: number;
  phaseEndsAt?: number;
  // Frozen at game end so the results banner names the real champion regardless of
  // who leaves the results screen afterwards.
  winner?: string;
  winnerScore?: number;
  // Server clock at the moment this state was sent (unix ms). Used to correct the
  // countdown for device clock skew so every client agrees on the time left.
  serverNow?: number;
  // Recipient-specific fields.
  you?: string;
  yourPrompt?: string;
  currentDrawing?: Stroke[];
  // Reveal phase, host only: every player's drawing keyed by name.
  gallery?: Record<string, Stroke[]>;
  youAreArtist?: boolean;
  yourGuess?: string;
  reveal?: Reveal | null;
  // Flipped guessing only.
  target?: string;
  youAreTarget?: boolean;
  pool?: PoolDrawing[];
  // Guessing phase: artists already revealed earlier this round. Each player draws
  // once, so these can't be the current drawing's artist — dropped from the options.
  revealed?: string[];
  // Reveal phase, host only: artists already revealed this round, so the gallery
  // shows their names and keeps the not-yet-guessed drawings' names hidden.
  roundFeatured?: string[];
  // Final frame sent when the host leaves: the room is gone, kick to the menu.
  closed?: boolean;
  // Final frame sent to a player the host removed: kick to the menu, but the
  // room itself lives on for everyone else.
  kicked?: boolean;
  // Frenzy-mode recipient-specific field: effects currently inflicted on this
  // client by the room-wide effect waves.
  yourEffects?: ActiveEffect[];
}

// GameConfig is the host's lobby setup sent via the "configure" event.
export interface GameConfig {
  rounds: number;
  language: Language;
  categories: string[];
  drawMs: number;
  guessMs: number;
  mode: GameMode;
}

export interface ServerError {
  message: string;
}
