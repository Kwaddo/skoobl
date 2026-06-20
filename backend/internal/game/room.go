package game

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"math/rand/v2"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// CmdKind enumerates the mutations a Room accepts.
type CmdKind int

const (
	CmdJoin CmdKind = iota
	CmdDisconnect
	CmdLeave         // player: leave the room now (immediate removal, no grace)
	CmdConfigure     // host: set rounds/categories/language/timers (lobby only)
	CmdStart         // host: lobby → drawing (requires minPlayers)
	CmdSubmitDrawing // player: submit strokes during the drawing phase
	CmdSubmitGuess   // player: guess the artist during the guessing phase
	CmdNextPhase     // host: reveal → next round / ended
	CmdReturnToLobby // host: ended → lobby (play again, keep players)
	CmdAdvance       // internal, timer-driven phase advance
	CmdPrune
	CmdReapIfEmpty
	CmdHostPrune // internal: host display gone past grace → reap
)

// Tunables.
const (
	// DefaultGrace is how long a disconnected player (or a never-populated room)
	// is kept before being pruned/reaped. Survives refreshes and brief drops.
	DefaultGrace = 60 * time.Second
	// minPlayers is the smallest room that can start a game — you need an artist
	// plus enough guessers for "who drew this?" to be a real question.
	minPlayers = 4
	// maxPlayers caps a single room.
	maxPlayers = 12

	// Round configuration bounds and defaults.
	DefaultRounds  = 3
	minRounds      = 1
	maxRounds      = 8
	DefaultDrawMs  = 80_000
	DefaultGuessMs = 25_000
	minDrawMs      = 15_000
	maxDrawMs      = 180_000
	minGuessMs     = 10_000
	maxGuessMs     = 60_000

	// Custom category / name limits.
	maxCustomCategories = 40
	maxCategoryLen      = 60
	maxNameLen          = 24

	// Drawing payload caps — bound memory and broadcast size against abusive
	// clients (a stroke flood would otherwise grow GameState without limit).
	maxStrokes         = 800
	maxPointsPerStroke = 3_000
	maxPointsTotal     = 40_000
	minStrokeWidth     = 1
	maxStrokeWidth     = 48

	// Fixed logical canvas space; must match the frontend's canvas resolution so
	// strokes render identically for everyone. Coordinates are clamped to it.
	canvasW = 1000
	canvasH = 750

	// pointsMax caps both per-round earnings: a guesser's fastest correct guess and
	// the artist's pot when nobody identifies them. Equal maxes keep a featured
	// round worth about the same as a round spent guessing.
	pointsMax = 100
	// speedSpread is how much of a correct guess rides on speed: it scores from
	// pointsMax (instant) down to pointsMax-speedSpread (at the buzzer).
	speedSpread = 50
)

// hexColor matches #rgb, #rrggbb, and #rrggbbaa. Stroke colors that don't match
// are replaced with a safe default so nothing arbitrary reaches the DOM.
var hexColor = regexp.MustCompile(`^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`)

const defaultStrokeColor = "#f5f4ec"

// presence is per-player liveness, kept out of the serialized GameState.
type presence struct {
	connected bool
	gen       int // bumped each disconnect; stale prune timers self-cancel
}

// subscriber pairs a per-client broadcast channel with the player name it
// belongs to, so broadcast can hand each client its own redacted view.
type subscriber struct {
	name string
	ch   chan GameState
}

// Command is a single mutation request delivered to a Room's goroutine.
type Command struct {
	Kind      CmdKind
	Player    string
	Subscribe chan GameState // join: per-client broadcast channel
	Spectator bool           // join: true for the host display (non-playing)
	Unsub     chan GameState // disconnect: channel to drop from the sub set
	Ack       chan string    // join: "" on accept, else a rejection message
	Gen       int            // prune/advance: generation captured when the timer was armed

	// Game payloads.
	Strokes []Stroke // submitDrawing
	Guess   string   // submitGuess: the guessed artist's name
	Config  *Config  // configure
}

// Snapshotter persists a room's serialized state. Implemented by
// store.RedisStore. A nil Snapshotter disables persistence (in-memory mode).
type Snapshotter interface {
	SaveSnapshot(ctx context.Context, code string, data []byte) error
}

// Room owns its GameState and is the only goroutine that touches it.
type Room struct {
	state    GameState
	cmds     chan Command
	done     chan struct{}
	subs     []subscriber
	snap     Snapshotter
	present  map[string]*presence
	host     *presence // the single host-display (spectator); nil until one joins
	phaseGen int       // bumped on every phase change; stale advance timers self-cancel

	grace      time.Duration
	onReap     func()
	emptyTimer *time.Timer
	stopOnce   sync.Once
}

// RoomOption configures a Room at construction.
type RoomOption func(*Room)

// WithSnapshotter enables persistence.
func WithSnapshotter(s Snapshotter) RoomOption { return func(r *Room) { r.snap = s } }

// WithReaper sets the callback invoked when the room shuts itself down (empty).
// It runs on the room goroutine, so it must not block or Submit to this room.
func WithReaper(fn func()) RoomOption { return func(r *Room) { r.onReap = fn } }

// WithGrace overrides the disconnect/empty grace period (tests use a tiny value).
func WithGrace(d time.Duration) RoomOption { return func(r *Room) { r.grace = d } }

func newRoom(state GameState, opts ...RoomOption) *Room {
	r := &Room{
		state:   state,
		cmds:    make(chan Command, 32),
		done:    make(chan struct{}),
		present: map[string]*presence{},
		grace:   DefaultGrace,
	}
	for _, opt := range opts {
		opt(r)
	}
	return r
}

// NewRoom creates an unstarted in-memory room. Call Run in a goroutine.
func NewRoom(code string, opts ...RoomOption) *Room {
	return newRoom(newGameState(code), opts...)
}

// NewRoomFromSnapshot rebuilds a room from previously persisted state.
func NewRoomFromSnapshot(code string, data []byte, opts ...RoomOption) (*Room, error) {
	var gs GameState
	if err := json.Unmarshal(data, &gs); err != nil {
		return nil, err
	}
	gs.Code = code
	if gs.Players == nil {
		gs.Players = []Player{}
	}
	return newRoom(gs, opts...), nil
}

// Submit enqueues a command. Safe from any goroutine.
func (r *Room) Submit(c Command) {
	select {
	case r.cmds <- c:
	case <-r.done:
	}
}

// Stop tears the room down. Idempotent.
func (r *Room) Stop() { r.stopOnce.Do(func() { close(r.done) }) }

// Run is the actor loop. Single-threaded over r.state — no locks needed.
func (r *Room) Run() {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("room %s panic recovered: %v", r.state.Code, rec)
		}
	}()
	r.onStart()
	for {
		select {
		case <-r.done:
			return
		case c := <-r.cmds:
			r.handle(c)
			if r.isDone() {
				return // reaped inside handle; skip broadcast/persist
			}
			r.broadcast()
			r.persist()
		}
	}
}

// onStart arms the initial grace timers. A never-populated room gets an empty
// timer; a snapshot-restored room starts everyone disconnected (in grace), so
// abandoned restored rooms reap while reconnecting clients save themselves. A
// restored mid-round resumes its phase timer so the game doesn't stall.
func (r *Room) onStart() {
	if r.state.Host != "" {
		r.host = &presence{connected: false, gen: 1}
		r.armHostPrune(r.host.gen)
	}
	if len(r.state.Players) == 0 && r.state.Host == "" {
		r.armEmptyTimer()
		return
	}
	for _, p := range r.state.Players {
		pr := &presence{connected: false, gen: 1}
		r.present[p.Name] = pr
		r.armPrune(p.Name, pr.gen)
	}
	if r.state.Phase == PhaseDrawing || r.state.Phase == PhaseGuessing {
		r.phaseGen++
		d := time.Until(time.UnixMilli(r.state.PhaseEndsAt))
		if d < 0 {
			d = 0
		}
		r.armAdvance(r.phaseGen, d)
	}
}

func (r *Room) armEmptyTimer() {
	r.emptyTimer = time.AfterFunc(r.grace, func() {
		r.Submit(Command{Kind: CmdReapIfEmpty})
	})
}

func (r *Room) cancelEmptyTimer() {
	if r.emptyTimer != nil {
		r.emptyTimer.Stop()
		r.emptyTimer = nil
	}
}

func (r *Room) armPrune(name string, gen int) {
	time.AfterFunc(r.grace, func() {
		r.Submit(Command{Kind: CmdPrune, Player: name, Gen: gen})
	})
}

// armAdvance schedules a timer-driven phase advance. The captured phaseGen makes
// the timer a no-op if the phase was already advanced (e.g. everyone submitted
// early), so manual and timed advances never double-fire.
func (r *Room) armAdvance(gen int, d time.Duration) {
	time.AfterFunc(d, func() {
		r.Submit(Command{Kind: CmdAdvance, Gen: gen})
	})
}

func (r *Room) isDone() bool {
	select {
	case <-r.done:
		return true
	default:
		return false
	}
}

func (r *Room) handle(c Command) {
	switch c.Kind {
	case CmdJoin:
		r.join(c)
	case CmdDisconnect:
		r.disconnect(c)
	case CmdLeave:
		r.leave(c)
	case CmdPrune:
		r.prune(c)
	case CmdReapIfEmpty:
		if len(r.state.Players) == 0 && !r.hostConnected() {
			r.reap()
		}
	case CmdHostPrune:
		if r.host != nil && !r.host.connected && r.host.gen == c.Gen {
			r.closeRoom()
		}
	case CmdConfigure:
		if c.Player == r.state.Host && r.state.Phase == PhaseLobby && c.Config != nil {
			r.applyConfig(*c.Config)
		}
	case CmdStart:
		if c.Player == r.state.Host && r.state.Phase == PhaseLobby && r.connectedCount() >= minPlayers {
			r.startGame()
		}
	case CmdSubmitDrawing:
		r.submitDrawing(c)
	case CmdSubmitGuess:
		r.submitGuess(c)
	case CmdNextPhase:
		if c.Player == r.state.Host && r.state.Phase == PhaseReveal {
			if r.state.Round < r.state.TotalRounds {
				r.beginRound(r.state.Round + 1)
			} else {
				r.endGame()
			}
		}
	case CmdReturnToLobby:
		// The host can send everyone back to the lobby from the final scoreboard
		// (play again) or mid-game (abandon the current game before it ends).
		if c.Player == r.state.Host && r.state.Phase != PhaseLobby {
			r.returnToLobby()
		}
	case CmdAdvance:
		if c.Gen == r.phaseGen {
			r.advance()
		}
	}
}

func (r *Room) join(c Command) {
	if c.Spectator {
		r.joinSpectator(c)
		return
	}
	name := c.Player
	if r.state.Phase == PhaseEnded {
		ack(c, "This game has already ended.")
		return
	}
	if utf8.RuneCountInString(name) > maxNameLen {
		ack(c, "That name is too long.")
		return
	}
	if name == r.state.Host {
		ack(c, "That name's already taken in this room.")
		return
	}
	if p, ok := r.present[name]; ok {
		if p.connected {
			ack(c, "That name's already taken in this room.")
			return
		}
		// Reconnect: same name returning while marked disconnected.
		p.connected = true
		p.gen++ // invalidate the pending prune
		r.addSub(name, c.Subscribe)
		ack(c, "")
		return
	}
	if len(r.state.Players) >= maxPlayers {
		ack(c, "This room is full.")
		return
	}
	r.state.Players = append(r.state.Players, Player{Name: name})
	r.present[name] = &presence{connected: true}
	r.addSub(name, c.Subscribe)
	r.cancelEmptyTimer()
	ack(c, "")
}

// joinSpectator wires up the single host display: it claims the room's Host role
// and subscribes for broadcasts, but is never added to Players — so it never
// draws, guesses, scores, or counts toward minPlayers. A connected host with a
// different name is rejected; the same name returning while disconnected
// reconnects.
func (r *Room) joinSpectator(c Command) {
	name := c.Player
	if r.state.Phase == PhaseEnded {
		ack(c, "This game has already ended.")
		return
	}
	if utf8.RuneCountInString(name) > maxNameLen {
		ack(c, "That name is too long.")
		return
	}
	if r.state.playerIndex(name) >= 0 {
		ack(c, "That name's already taken in this room.")
		return
	}
	if r.state.Host != "" && r.state.Host != name {
		ack(c, "This room already has a host.")
		return
	}
	if r.hostConnected() { // same name, but a host is already live (duplicate tab)
		ack(c, "This room already has a host.")
		return
	}
	if r.host == nil {
		r.host = &presence{}
	}
	r.state.Host = name
	r.host.connected = true
	r.host.gen++ // invalidate any pending host prune
	r.addSub(name, c.Subscribe)
	r.cancelEmptyTimer()
	ack(c, "")
}

func (r *Room) disconnect(c Command) {
	r.unsubscribe(c.Unsub)
	if r.host != nil && c.Player == r.state.Host {
		if !r.host.connected {
			return
		}
		r.host.connected = false
		r.host.gen++
		r.armHostPrune(r.host.gen)
		return
	}
	p, ok := r.present[c.Player]
	if !ok || !p.connected {
		return
	}
	p.connected = false
	p.gen++
	r.armPrune(c.Player, p.gen)
}

// armHostPrune schedules a reap if the host display doesn't return within grace.
// The host is required (it is the shared screen and holds all manual-advance
// authority), so losing it ends the game. A captured gen makes a returned host
// cancel the timer.
func (r *Room) armHostPrune(gen int) {
	time.AfterFunc(r.grace, func() {
		r.Submit(Command{Kind: CmdHostPrune, Gen: gen})
	})
}

func (r *Room) prune(c Command) {
	p, ok := r.present[c.Player]
	if !ok || p.connected || p.gen != c.Gen {
		return // reconnected, already gone, or a stale timer
	}
	r.removePlayer(c.Player)
}

// leave removes a participant immediately at their own request (the Leave
// button), skipping the disconnect grace. A host leaving closes the shared
// screen and ends the game; a player leaving reaps an emptied room.
func (r *Room) leave(c Command) {
	r.unsubscribe(c.Unsub)
	if r.host != nil && c.Player == r.state.Host {
		r.closeRoom()
		return
	}
	if _, ok := r.present[c.Player]; !ok {
		return // never present, or already gone
	}
	r.removePlayer(c.Player)
}

// closeRoom tears the room down when the host departs. It sends a final frame
// flagged Closed to the remaining players first — the room is the shared screen
// and holds all advance authority, so without it nothing can continue — then
// reaps. Run skips its post-handle broadcast once reaped, so this is the players'
// last frame and the cue for their clients to return to the main menu.
func (r *Room) closeRoom() {
	r.state.Closed = true
	r.broadcast()
	r.reap()
}

// removePlayer drops a player from presence and the roster, reaps a room that
// has no players and no connected host, bounces a now-undersized game back to
// the lobby, and otherwise lets a departure complete the current phase for those
// who remain. The host is a spectator (never in Players), so there is no host
// promotion here. Called only from leave and prune — i.e. on a real departure,
// never on a transient disconnect — so a refresh can't trigger the bounce.
func (r *Room) removePlayer(name string) {
	delete(r.present, name)
	if i := r.state.playerIndex(name); i >= 0 {
		r.state.Players = append(r.state.Players[:i], r.state.Players[i+1:]...)
	}
	if len(r.state.Players) == 0 && !r.hostConnected() {
		r.reap()
		return
	}
	// A real departure that drops a running game below the minimum abandons the
	// round: there aren't enough players for "who drew this?" to work, so send
	// everyone back to the lobby (scores reset) rather than limp on under-strength.
	if r.state.Phase.inGame() && len(r.state.Players) < minPlayers {
		r.returnToLobby()
		return
	}
	switch r.state.Phase {
	case PhaseDrawing:
		if r.allDrawn() {
			r.beginGuessing()
		}
	case PhaseGuessing:
		if r.allGuessed() {
			r.beginReveal()
		}
	}
}

// reap shuts the room down: tell the hub to drop it, then stop the loop.
func (r *Room) reap() {
	if r.onReap != nil {
		r.onReap()
	}
	r.Stop()
}

// --- game flow ------------------------------------------------------------

func (r *Room) applyConfig(cfg Config) {
	r.state.TotalRounds = clamp(cfg.Rounds, minRounds, maxRounds)
	if cfg.Language == LangAR {
		r.state.Language = LangAR
	} else {
		r.state.Language = LangEN
	}
	r.state.DrawMs = clamp(cfg.DrawMs, minDrawMs, maxDrawMs)
	r.state.GuessMs = clamp(cfg.GuessMs, minGuessMs, maxGuessMs)
	r.state.Categories = sanitizeCategories(cfg.Categories)
}

func (r *Room) startGame() {
	for i := range r.state.Players {
		r.state.Players[i].Score = 0
	}
	r.state.FeaturedPast = nil
	r.beginRound(1)
}

// beginRound resets per-round data, picks the universal prompt everyone draws,
// and opens the drawing phase.
func (r *Room) beginRound(n int) {
	r.state.Round = n
	r.state.Drawings = map[string][]Stroke{}
	r.state.Guesses = map[string]string{}
	r.state.GuessTimes = map[string]int64{}
	r.state.LastDeltas = nil
	r.state.Featured = ""
	r.state.Prompt = r.pickPrompt()
	r.startPhase(PhaseDrawing, r.state.DrawMs)
}

// pickPrompt chooses the single word everyone draws this round, from the custom
// pool if configured, else the built-in pool for the chosen language. It avoids
// immediately repeating the previous round's word when the pool allows.
func (r *Room) pickPrompt() string {
	pool := r.state.Categories
	if len(pool) == 0 {
		pool = builtinPool(r.state.Language)
	}
	switch len(pool) {
	case 0:
		return "anything"
	case 1:
		return pool[0]
	}
	prev := r.state.Prompt
	for i := 0; i < 5; i++ {
		if w := pool[rand.IntN(len(pool))]; w != prev {
			return w
		}
	}
	return pool[rand.IntN(len(pool))]
}

// advance is the timer-driven transition: drawing → guessing → reveal. Reveal is
// host-driven (no timer), so it isn't handled here.
func (r *Room) advance() {
	switch r.state.Phase {
	case PhaseDrawing:
		r.beginGuessing()
	case PhaseGuessing:
		r.beginReveal()
	}
}

func (r *Room) beginGuessing() {
	r.state.Featured = r.pickFeatured()
	if r.state.Featured == "" {
		// Nobody drew anything this round — there's nothing to guess, so skip
		// straight to the reveal (which shows a "nobody drew" message).
		r.beginReveal()
		return
	}
	r.startPhase(PhaseGuessing, r.state.GuessMs)
}

// pickFeatured chooses the single artist whose drawing is shown this round. It
// only ever features a player who actually drew something (a blank canvas can't
// be guessed), preferring a not-yet-featured drawer so coverage spreads across
// rounds. Returns "" when nobody drew anything.
func (r *Room) pickFeatured() string {
	past := make(map[string]bool, len(r.state.FeaturedPast))
	for _, n := range r.state.FeaturedPast {
		past[n] = true
	}

	var freshDrew, anyDrew []string
	for _, p := range r.state.Players {
		if len(r.state.Drawings[p.Name]) == 0 {
			continue // never feature an empty canvas
		}
		anyDrew = append(anyDrew, p.Name)
		if !past[p.Name] {
			freshDrew = append(freshDrew, p.Name)
		}
	}
	for _, pick := range [][]string{freshDrew, anyDrew} {
		if len(pick) > 0 {
			return pick[rand.IntN(len(pick))]
		}
	}
	return ""
}

// speedScore converts a correct guess's timestamp into points on a linear curve
// across the guess window: pointsMax for an instant guess down to
// pointsMax-speedSpread at the buzzer. Call it during beginReveal, before
// startPhase resets the phase clock. Timestamps outside the window are clamped.
func (r *Room) speedScore(guessedAt int64) int {
	if r.state.GuessMs <= 0 {
		return pointsMax
	}
	start := r.state.PhaseEndsAt - int64(r.state.GuessMs)
	f := float64(guessedAt-start) / float64(r.state.GuessMs)
	f = clampF(f, 0, 1)
	return int(math.Round(float64(pointsMax) - float64(speedSpread)*f))
}

// artistPot is the featured artist's round score: the full pot when nobody
// identifies them, zero when everyone does, linear between. eligible is the count
// of players who could have identified them.
func artistPot(correct, eligible int) int {
	if eligible <= 0 {
		return pointsMax
	}
	return int(math.Round(float64(pointsMax) * (1 - float64(correct)/float64(eligible))))
}

// beginReveal scores the round and opens the host-advanced reveal phase. Correct
// guessers earn speed points (faster = more); the featured artist earns a pot that
// shrinks with each player who identifies them. Scores are computed before
// startPhase resets the clock, so speedScore reads the live guess window.
func (r *Room) beginReveal() {
	var deltas map[string]int
	if r.state.Featured != "" {
		deltas = map[string]int{}
		// eligible = everyone who could have identified the artist: connected
		// non-artists, unioned with any correct guesser who dropped after guessing
		// (so a correct guess can't be erased by disconnecting).
		eligible := map[string]bool{}
		for _, p := range r.state.Players {
			if p.Name == r.state.Featured {
				continue
			}
			if pr, ok := r.present[p.Name]; ok && pr.connected {
				eligible[p.Name] = true
			}
		}
		correct := 0
		for guesser, guess := range r.state.Guesses {
			if guesser == r.state.Featured || guess != r.state.Featured {
				continue
			}
			correct++
			eligible[guesser] = true
			ts, ok := r.state.GuessTimes[guesser]
			if !ok {
				ts = r.state.PhaseEndsAt // no recorded time (e.g. restored mid-round) → score as the buzzer
			}
			if i := r.state.playerIndex(guesser); i >= 0 {
				pts := r.speedScore(ts)
				r.state.Players[i].Score += pts
				deltas[guesser] += pts
			}
		}
		pot := artistPot(correct, len(eligible))
		if i := r.state.playerIndex(r.state.Featured); i >= 0 {
			r.state.Players[i].Score += pot
			deltas[r.state.Featured] += pot
		}
		r.state.FeaturedPast = append(r.state.FeaturedPast, r.state.Featured)
	}
	r.state.LastDeltas = deltas
	r.startPhase(PhaseReveal, 0)
}

func (r *Room) endGame() {
	r.phaseGen++
	r.state.Phase = PhaseEnded
	r.state.PhaseEndsAt = 0
	// Drop transient round data so the final scoreboard view carries no leftovers.
	r.state.Prompt = ""
	r.state.Drawings = nil
	r.state.Guesses = nil
	r.state.GuessTimes = nil
	r.state.LastDeltas = nil
	r.state.Featured = ""
}

// returnToLobby sends a finished game back to the lobby for a fresh round,
// keeping the players, host, and configured settings but zeroing scores and
// clearing all round data. Lets a group play again without re-joining.
func (r *Room) returnToLobby() {
	r.phaseGen++
	r.state.Phase = PhaseLobby
	r.state.Round = 0
	r.state.PhaseEndsAt = 0
	r.state.Prompt = ""
	r.state.Drawings = nil
	r.state.Guesses = nil
	r.state.GuessTimes = nil
	r.state.LastDeltas = nil
	r.state.Featured = ""
	r.state.FeaturedPast = nil
	for i := range r.state.Players {
		r.state.Players[i].Score = 0
	}
}

// startPhase sets the phase, bumps the generation, and arms the advance timer for
// timed phases (durMs > 0). PhaseEndsAt lets clients render a countdown.
func (r *Room) startPhase(p Phase, durMs int) {
	r.state.Phase = p
	r.phaseGen++
	if durMs > 0 {
		d := time.Duration(durMs) * time.Millisecond
		r.state.PhaseEndsAt = time.Now().Add(d).UnixMilli()
		r.armAdvance(r.phaseGen, d)
	} else {
		r.state.PhaseEndsAt = 0
	}
}

func (r *Room) submitDrawing(c Command) {
	if r.state.Phase != PhaseDrawing || r.state.playerIndex(c.Player) < 0 {
		return
	}
	if r.state.Drawings == nil {
		r.state.Drawings = map[string][]Stroke{}
	}
	r.state.Drawings[c.Player] = sanitizeStrokes(c.Strokes)
	if r.allDrawn() {
		r.beginGuessing() // everyone's in — don't wait out the timer
	}
}

func (r *Room) submitGuess(c Command) {
	if r.state.Phase != PhaseGuessing {
		return
	}
	if c.Player == r.state.Featured { // the artist doesn't guess their own drawing
		return
	}
	if r.state.playerIndex(c.Player) < 0 || r.state.playerIndex(c.Guess) < 0 {
		return // unknown guesser, or a guess that isn't a real player
	}
	if r.state.Guesses == nil {
		r.state.Guesses = map[string]string{}
	}
	if r.state.GuessTimes == nil {
		r.state.GuessTimes = map[string]int64{}
	}
	r.state.Guesses[c.Player] = c.Guess
	r.state.GuessTimes[c.Player] = time.Now().UnixMilli()
	if r.allGuessed() {
		r.beginReveal()
	}
}

// allDrawn reports whether every connected player has submitted a drawing.
// Disconnected players (in their grace window) don't block the round.
func (r *Room) allDrawn() bool {
	for _, p := range r.state.Players {
		if pr, ok := r.present[p.Name]; ok && pr.connected {
			if _, drawn := r.state.Drawings[p.Name]; !drawn {
				return false
			}
		}
	}
	return true
}

// allGuessed reports whether every connected non-artist player has guessed.
func (r *Room) allGuessed() bool {
	for _, p := range r.state.Players {
		if p.Name == r.state.Featured {
			continue
		}
		if pr, ok := r.present[p.Name]; ok && pr.connected {
			if _, guessed := r.state.Guesses[p.Name]; !guessed {
				return false
			}
		}
	}
	return true
}

func (r *Room) connectedCount() int {
	n := 0
	for _, p := range r.present {
		if p.connected {
			n++
		}
	}
	return n
}

// hostConnected reports whether the host display is currently attached.
func (r *Room) hostConnected() bool { return r.host != nil && r.host.connected }

// --- subscription / broadcast / persistence -------------------------------

func (r *Room) addSub(name string, ch chan GameState) {
	if ch != nil {
		r.subs = append(r.subs, subscriber{name: name, ch: ch})
	}
}

// ack sends the join outcome on c.Ack if present (buffered, never blocks).
func ack(c Command, msg string) {
	if c.Ack != nil {
		c.Ack <- msg
	}
}

// unsubscribe removes ch from the subscriber set by channel identity. Runs in
// the room goroutine, so r.subs is touched by nothing else and stays race-free.
func (r *Room) unsubscribe(ch chan GameState) {
	if ch == nil {
		return
	}
	for i, s := range r.subs {
		if s.ch == ch {
			r.subs = append(r.subs[:i], r.subs[i+1:]...)
			return
		}
	}
}

// broadcast hands each subscriber its own redacted view of the state.
func (r *Room) broadcast() {
	for _, s := range r.subs {
		view := r.state.viewFor(s.name, r.present)
		select {
		case s.ch <- view:
		default: // drop for a slow/closed subscriber rather than block the room
		}
	}
}

// persist writes the current state to the Snapshotter. Nil-safe; save errors
// are logged but never take the room down.
func (r *Room) persist() {
	if r.snap == nil {
		return
	}
	data, err := json.Marshal(r.state)
	if err != nil {
		log.Printf("room %s marshal snapshot: %v", r.state.Code, err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := r.snap.SaveSnapshot(ctx, r.state.Code, data); err != nil {
		log.Printf("room %s save snapshot: %v", r.state.Code, err)
	}
}

// --- validation / sanitization --------------------------------------------

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func clampF(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// sanitizeCategories trims, de-dupes, length-caps, and count-caps host-supplied
// prompt words. Rendering is React-escaped, so this is about bounding size and
// keeping the pool sane rather than XSS.
func sanitizeCategories(in []string) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, c := range in {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if utf8.RuneCountInString(c) > maxCategoryLen {
			c = string([]rune(c)[:maxCategoryLen])
		}
		if seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
		if len(out) >= maxCustomCategories {
			break
		}
	}
	return out
}

// sanitizeStrokes bounds an incoming drawing: caps strokes, points-per-stroke,
// and total points; clamps widths and coordinates; and validates colors.
func sanitizeStrokes(in []Stroke) []Stroke {
	if len(in) > maxStrokes {
		in = in[:maxStrokes]
	}
	out := make([]Stroke, 0, len(in))
	total := 0
	for _, s := range in {
		pts := s.Points
		if len(pts) == 0 {
			continue
		}
		if len(pts) > maxPointsPerStroke {
			pts = pts[:maxPointsPerStroke]
		}
		clean := make([]Point, 0, len(pts))
		for _, p := range pts {
			if total >= maxPointsTotal {
				break
			}
			clean = append(clean, Point{X: clampF(p.X, 0, canvasW), Y: clampF(p.Y, 0, canvasH)})
			total++
		}
		if len(clean) == 0 {
			continue
		}
		out = append(out, Stroke{
			Color:  sanitizeColor(s.Color),
			Width:  clampF(s.Width, minStrokeWidth, maxStrokeWidth),
			Points: clean,
		})
		if total >= maxPointsTotal {
			break
		}
	}
	return out
}

func sanitizeColor(c string) string {
	if hexColor.MatchString(c) {
		return c
	}
	return defaultStrokeColor
}
