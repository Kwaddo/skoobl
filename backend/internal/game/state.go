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

// inGame reports whether a round is actively underway (someone is drawing,
// guessing, or looking at a reveal) — as opposed to the lobby or the final
// scoreboard. Used to gate mid-game abandons and the below-minimum bounce.
func (p Phase) inGame() bool {
	return p == PhaseDrawing || p == PhaseGuessing || p == PhaseReveal
}

// Language selects which built-in prompt pool to use and is echoed to clients so
// the UI can render prompts right-to-left when needed. It only ever affects the
// category/prompt words — never the rest of the (English) game UI.
type Language string

const (
	LangEN Language = "en"
	LangAR Language = "ar"
)

// Mode selects the round variant. Classic is the default and is unchanged by the
// addition of other modes — mode only ever adds branches, never alters classic.
type Mode string

const (
	ModeClassic Mode = "classic" // current behavior; the default
	ModeFlipped Mode = "flipped" // Whose Doodle: pick which drawing is the target's
)

// sanitizeMode coerces an untrusted mode to a known value, defaulting to classic.
func sanitizeMode(m Mode) Mode {
	if m == ModeFlipped {
		return ModeFlipped
	}
	return ModeClassic
}

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
	// Fill marks a flood-fill op: Points[0] is the seed, Color is the fill
	// color, Width is ignored. Replayed deterministically at render time.
	Fill bool `json:"fill,omitempty"`
}

// Player is one participant. Name and Score are authoritative; the remaining
// fields are derived per-recipient in viewFor and are never set on the
// authoritative GameState.
type Player struct {
	Name  string `json:"name"`
	Score int    `json:"score"`

	// View-only, derived fields (omitted from the authoritative snapshot).
	Connected  bool `json:"connected,omitempty"`
	HasDrawn   bool `json:"hasDrawn,omitempty"`   // drew something non-empty this round
	HasGuessed bool `json:"hasGuessed,omitempty"` // submitted a guess this round
	Correct    bool `json:"correct,omitempty"`    // reveal: guessed the artist right
	RoundScore int  `json:"roundScore,omitempty"` // reveal: points earned this round
	Locked     bool `json:"locked,omitempty"`     // drawing: locked in (TV "finished ✓")
}

// Reveal carries the answer shown to everyone at the end of a round.
type Reveal struct {
	Artist string `json:"artist"` // who drew the featured drawing
	Prompt string `json:"prompt"` // the word they were asked to draw
}

// PoolDrawing is one anonymized candidate in flipped guessing: a stable per-round
// opaque id and the strokes, with no owner name attached.
type PoolDrawing struct {
	ID      string   `json:"id"`
	Strokes []Stroke `json:"strokes"`
}

// Config is the host-tunable game setup, applied in the lobby.
type Config struct {
	Rounds     int      `json:"rounds"`
	Language   Language `json:"language"`
	Mode       Mode     `json:"mode"`       // round variant; empty/unknown ⇒ classic
	Categories []string `json:"categories"` // custom prompt words; empty ⇒ random pool
	DrawMs     int      `json:"drawMs"`     // drawing time per round (ms)
	GuessMs    int      `json:"guessMs"`    // guessing time per round (ms)
}

// GameState is the authoritative room state. It is the only struct persisted to
// Redis (server-side only). Clients never receive it directly — broadcast sends
// each subscriber a redacted projection built by viewFor, so secret round data
// (prompts, the featured artist, other players' drawings mid-round) never leaks.
type GameState struct {
	Code  string `json:"code"`
	Phase Phase  `json:"phase"`
	Mode  Mode   `json:"mode"`
	Host  string `json:"host"`
	// HostPlays is the room mode chosen when the host creates it: false ⇒ the host
	// is a non-playing shared screen (the "TV"); true ⇒ the host is also a player
	// (draws, guesses, scores) and there is no separate display, so each player
	// sees the drawing on their own device.
	HostPlays   bool     `json:"hostPlays"`
	Players     []Player `json:"players"`
	Round       int      `json:"round"` // 1-based; 0 in the lobby
	TotalRounds int      `json:"totalRounds"`
	// A round guesses several drawings in a row (see guessesForPlayers): one
	// drawing is featured, guessed, and revealed at a time. FeatureIndex is the
	// 1-based position of the drawing on show; FeatureCount is how many this round
	// has. Both are public so the UI can render "Drawing 2 of 3".
	FeatureIndex int      `json:"featureIndex,omitempty"`
	FeatureCount int      `json:"featureCount,omitempty"`
	Language     Language `json:"language"`
	DrawMs       int      `json:"drawMs"`
	GuessMs      int      `json:"guessMs"`
	PhaseEndsAt  int64    `json:"phaseEndsAt"` // unix ms a timed phase ends; 0 if untimed

	// Authoritative round data — persisted (server-side) but redacted from views.
	Categories    []string            `json:"categories,omitempty"`    // active prompt pool
	Prompt        string              `json:"prompt,omitempty"`        // the universal word everyone draws this round
	Drawings      map[string][]Stroke `json:"drawings,omitempty"`      // player → latest strokes this round (draft or locked)
	Locked        map[string]bool     `json:"locked,omitempty"`        // player → locked in (gates early-advance)
	Featured      string              `json:"featured,omitempty"`      // artist shown right now
	RoundFeatured []string            `json:"roundFeatured,omitempty"` // artists already featured THIS round (never repeat a drawing)
	FeaturedPast  []string            `json:"featuredPast,omitempty"`  // artists already featured across the game (spreads coverage)
	Guesses       map[string]string   `json:"guesses,omitempty"`       // guesser → guessed artist
	GuessTimes    map[string]int64    `json:"guessTimes,omitempty"`    // guesser → unix-ms of their latest guess
	LastDeltas    map[string]int      `json:"lastDeltas,omitempty"`    // player → points earned in the round just scored
	DrawIDs       map[string]string   `json:"drawIds,omitempty"`       // flipped: per-round opaque id per drawer (name→id); server-only, redacted by viewFor

	// View-only fields, populated by viewFor. Never set on the authoritative
	// state, so they marshal away (omitempty) in the persisted snapshot.
	You            string              `json:"you,omitempty"`
	YourPrompt     string              `json:"yourPrompt,omitempty"`
	CurrentDrawing []Stroke            `json:"currentDrawing,omitempty"`
	Gallery        map[string][]Stroke `json:"gallery,omitempty"` // reveal, host only: every player's drawing
	YouAreArtist   bool                `json:"youAreArtist,omitempty"`
	YourGuess      string              `json:"yourGuess,omitempty"`
	Reveal         *Reveal             `json:"reveal,omitempty"`
	Target         string              `json:"target,omitempty"`       // flipped guessing: whose doodle to find
	YouAreTarget   bool                `json:"youAreTarget,omitempty"` // flipped guessing: you're the target, sit out
	Pool           []PoolDrawing       `json:"pool,omitempty"`         // flipped guessing: anonymized candidate doodles
	// Revealed lists this round's already-revealed artists (excluding the drawing
	// on show, still secret). Sent to guessers so the UI drops them from the "who
	// drew it?" options — each player draws once, so a revealed artist can't be
	// the answer to a later drawing in the same round.
	Revealed []string `json:"revealed,omitempty"`
	// Closed is the final frame the room sends when the host leaves: the room is
	// gone and clients should kick everyone back to the main menu.
	Closed bool `json:"closed,omitempty"`
}

func newGameState(code string) GameState {
	return GameState{
		Code:        code,
		Phase:       PhaseLobby,
		Mode:        ModeClassic,
		Players:     []Player{},
		TotalRounds: DefaultRounds,
		Language:    LangEN,
		DrawMs:      DefaultDrawMs,
		GuessMs:     DefaultGuessMs,
	}
}

// revealedExcept returns the artists featured so far this round minus `current`,
// i.e. the ones whose drawing has already been revealed. Names are unique, so
// filtering by value drops exactly the in-flight (still-secret) artist.
func (g *GameState) revealedExcept(current string) []string {
	var out []string
	for _, n := range g.RoundFeatured {
		if n != current {
			out = append(out, n)
		}
	}
	return out
}

// flippedPool builds the anonymized candidate list for flipped guessing: every
// drawer whose doodle is still in play this round (not an already-revealed
// target), keyed by opaque id, in stable roster order. The current target's
// doodle is included but unlabeled — that's the one to find.
func (g *GameState) flippedPool() []PoolDrawing {
	revealed := map[string]bool{}
	for _, n := range g.revealedExcept(g.Featured) {
		revealed[n] = true
	}
	var pool []PoolDrawing
	for _, p := range g.Players {
		if len(g.Drawings[p.Name]) == 0 || revealed[p.Name] {
			continue
		}
		pool = append(pool, PoolDrawing{ID: g.DrawIDs[p.Name], Strokes: g.Drawings[p.Name]})
	}
	return pool
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
		Code:         g.Code,
		Phase:        g.Phase,
		Mode:         g.Mode,
		Host:         g.Host,
		HostPlays:    g.HostPlays,
		Round:        g.Round,
		TotalRounds:  g.TotalRounds,
		FeatureIndex: g.FeatureIndex,
		FeatureCount: g.FeatureCount,
		Language:     g.Language,
		DrawMs:       g.DrawMs,
		GuessMs:      g.GuessMs,
		PhaseEndsAt:  g.PhaseEndsAt,
		You:          name,
		Closed:       g.Closed,
	}

	v.Players = make([]Player, len(g.Players))
	for i, p := range g.Players {
		pub := Player{Name: p.Name, Score: p.Score}
		if pr, ok := present[p.Name]; ok {
			pub.Connected = pr.connected
		}
		// HasDrawn means they actually drew something (non-empty). An empty
		// lock-in doesn't count: such players are skipped for the featured
		// drawing and excluded from the "who drew this?" options.
		if len(g.Drawings[p.Name]) > 0 {
			pub.HasDrawn = true
		}
		if g.Locked[p.Name] {
			pub.Locked = true
		}
		if _, ok := g.Guesses[p.Name]; ok {
			pub.HasGuessed = true
		}
		if g.Phase == PhaseReveal && g.Featured != "" {
			if guess, ok := g.Guesses[p.Name]; ok && guess == g.Featured {
				pub.Correct = true
			}
		}
		if g.Phase == PhaseReveal {
			pub.RoundScore = g.LastDeltas[p.Name]
		}
		v.Players[i] = pub
	}

	switch g.Phase {
	case PhaseDrawing:
		v.YourPrompt = g.Prompt // everyone draws the same universal word
	case PhaseGuessing:
		if g.Mode == ModeFlipped {
			v.Target = g.Featured
			v.YouAreTarget = name == g.Featured
			v.Pool = g.flippedPool()
			// YourGuess is intentionally omitted in flipped: it holds the resolved
			// owner name, which would reveal the answer. The UI uses HasDrawn /
			// the player's HasGuessed flag instead.
		} else {
			v.CurrentDrawing = g.Drawings[g.Featured] // artist identity stays hidden
			v.YouAreArtist = name == g.Featured
			v.YourGuess = g.Guesses[name]
			// Drop earlier-revealed artists from the guess options. The drawing on
			// show (g.Featured) is excluded so it never leaks before its own reveal.
			v.Revealed = g.revealedExcept(g.Featured)
		}
	case PhaseReveal:
		v.CurrentDrawing = g.Drawings[g.Featured]
		v.YourGuess = g.Guesses[name]
		v.Reveal = &Reveal{Artist: g.Featured, Prompt: g.Prompt}
		if name == g.Host {
			v.Gallery = make(map[string][]Stroke, len(g.Drawings))
			for artist, strokes := range g.Drawings {
				v.Gallery[artist] = append([]Stroke(nil), strokes...)
			}
			// Tell the host which artists have been revealed so far THIS round, so
			// the gallery can show those names and keep the not-yet-guessed ones
			// hidden (scribbled out) — otherwise the first reveal would spoil every
			// remaining drawing in a multi-guess round.
			v.RoundFeatured = append([]string(nil), g.RoundFeatured...)
		}
	}
	return v
}
