package game

// Phase is the room's lifecycle stage.
//
// Flow: lobby → drawing → guessing → reveal → (next round) drawing … → ended.
// Each round, every player draws their assigned prompt (drawing), then one
// random drawing is shown and everyone guesses who drew it (guessing), then the
// artist and scores are revealed (reveal). The host advances from reveal to the
// next round, or the game ends after the configured number of rounds.
type Phase string

const (
	PhaseLobby    Phase = "lobby"
	PhaseDrawing  Phase = "drawing"
	PhaseGuessing Phase = "guessing"
	PhaseReveal   Phase = "reveal"
	PhaseEnded    Phase = "ended"
)

// Language selects which built-in prompt pool to use and is echoed to clients so
// the UI can render prompts right-to-left when needed. It only ever affects the
// category/prompt words — never the rest of the (English) game UI.
type Language string

const (
	LangEN Language = "en"
	LangAR Language = "ar"
)

// Point is a single coordinate in the fixed logical canvas space (see Canvas*
// constants). Stored as float so sub-pixel pen movement survives scaling.
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// Stroke is one continuous pen stroke: a color, a width, and the path points.
type Stroke struct {
	Color  string  `json:"color"`
	Width  float64 `json:"width"`
	Points []Point `json:"points"`
}

// Player is one participant. Name and Score are authoritative; the remaining
// fields are derived per-recipient in viewFor and are never set on the
// authoritative GameState.
type Player struct {
	Name  string `json:"name"`
	Score int    `json:"score"`

	// View-only, derived fields (omitted from the authoritative snapshot).
	Connected  bool `json:"connected,omitempty"`
	HasDrawn   bool `json:"hasDrawn,omitempty"`   // submitted a drawing this round
	HasGuessed bool `json:"hasGuessed,omitempty"` // submitted a guess this round
	Correct    bool `json:"correct,omitempty"`    // reveal: guessed the artist right
}

// Reveal carries the answer shown to everyone at the end of a round.
type Reveal struct {
	Artist string `json:"artist"` // who drew the featured drawing
	Prompt string `json:"prompt"` // the word they were asked to draw
}

// Config is the host-tunable game setup, applied in the lobby.
type Config struct {
	Rounds     int      `json:"rounds"`
	Language   Language `json:"language"`
	Categories []string `json:"categories"` // custom prompt words; empty ⇒ random pool
	DrawMs     int      `json:"drawMs"`     // drawing time per round (ms)
	GuessMs    int      `json:"guessMs"`    // guessing time per round (ms)
}

// GameState is the authoritative room state. It is the only struct persisted to
// Redis (server-side only). Clients never receive it directly — broadcast sends
// each subscriber a redacted projection built by viewFor, so secret round data
// (prompts, the featured artist, other players' drawings mid-round) never leaks.
type GameState struct {
	Code        string   `json:"code"`
	Phase       Phase    `json:"phase"`
	Host        string   `json:"host"`
	Players     []Player `json:"players"`
	Round       int      `json:"round"`       // 1-based; 0 in the lobby
	TotalRounds int      `json:"totalRounds"`
	Language    Language `json:"language"`
	DrawMs      int      `json:"drawMs"`
	GuessMs     int      `json:"guessMs"`
	PhaseEndsAt int64    `json:"phaseEndsAt"` // unix ms a timed phase ends; 0 if untimed

	// Authoritative round data — persisted (server-side) but redacted from views.
	Categories   []string            `json:"categories,omitempty"`   // active prompt pool
	Prompt       string              `json:"prompt,omitempty"`       // the universal word everyone draws this round
	Drawings     map[string][]Stroke `json:"drawings,omitempty"`     // player → strokes this round
	Featured     string              `json:"featured,omitempty"`     // artist shown this round
	FeaturedPast []string            `json:"featuredPast,omitempty"` // artists already featured
	Guesses      map[string]string   `json:"guesses,omitempty"`      // guesser → guessed artist

	// View-only fields, populated by viewFor. Never set on the authoritative
	// state, so they marshal away (omitempty) in the persisted snapshot.
	You            string   `json:"you,omitempty"`
	YourPrompt     string   `json:"yourPrompt,omitempty"`
	CurrentDrawing []Stroke `json:"currentDrawing,omitempty"`
	YouAreArtist   bool     `json:"youAreArtist,omitempty"`
	YourGuess      string   `json:"yourGuess,omitempty"`
	Reveal         *Reveal  `json:"reveal,omitempty"`
}

func newGameState(code string) GameState {
	return GameState{
		Code:        code,
		Phase:       PhaseLobby,
		Players:     []Player{},
		TotalRounds: DefaultRounds,
		Language:    LangEN,
		DrawMs:      DefaultDrawMs,
		GuessMs:     DefaultGuessMs,
	}
}

func (g *GameState) playerIndex(name string) int {
	for i, p := range g.Players {
		if p.Name == name {
			return i
		}
	}
	return -1
}

// viewFor builds the redacted projection sent to a single recipient. It is an
// explicit allowlist: only public state, plus the recipient's own private data
// for the current phase, is copied. Everyone else's prompts/drawings and the
// featured artist's identity stay hidden until reveal.
func (g *GameState) viewFor(name string, present map[string]*presence) GameState {
	v := GameState{
		Code:        g.Code,
		Phase:       g.Phase,
		Host:        g.Host,
		Round:       g.Round,
		TotalRounds: g.TotalRounds,
		Language:    g.Language,
		DrawMs:      g.DrawMs,
		GuessMs:     g.GuessMs,
		PhaseEndsAt: g.PhaseEndsAt,
		You:         name,
	}

	v.Players = make([]Player, len(g.Players))
	for i, p := range g.Players {
		pub := Player{Name: p.Name, Score: p.Score}
		if pr, ok := present[p.Name]; ok {
			pub.Connected = pr.connected
		}
		if _, ok := g.Drawings[p.Name]; ok {
			pub.HasDrawn = true
		}
		if _, ok := g.Guesses[p.Name]; ok {
			pub.HasGuessed = true
		}
		if g.Phase == PhaseReveal && g.Featured != "" {
			if guess, ok := g.Guesses[p.Name]; ok && guess == g.Featured {
				pub.Correct = true
			}
		}
		v.Players[i] = pub
	}

	switch g.Phase {
	case PhaseDrawing:
		v.YourPrompt = g.Prompt // everyone draws the same universal word
	case PhaseGuessing:
		v.CurrentDrawing = g.Drawings[g.Featured] // artist identity stays hidden
		v.YouAreArtist = name == g.Featured
		v.YourGuess = g.Guesses[name]
	case PhaseReveal:
		v.CurrentDrawing = g.Drawings[g.Featured]
		v.YourGuess = g.Guesses[name]
		v.Reveal = &Reveal{Artist: g.Featured, Prompt: g.Prompt}
	}
	return v
}
