package game

import (
	"context"
	"encoding/json"
	"log"
	"math/rand/v2"
	"sync"
	"time"
)

// CmdKind enumerates the mutations a Room accepts.
type CmdKind int

const (
	CmdJoin CmdKind = iota
	CmdDisconnect
	CmdLeave           // player: leave the room now (immediate removal, no grace)
	CmdConfigure       // host: set rounds/categories/language/timers (lobby only)
	CmdStart           // host: lobby → drawing (requires minPlayers)
	CmdSubmitDrawing   // player: lock in strokes during the drawing phase
	CmdDraftAppend     // player: append in-progress strokes (silent: no broadcast/persist)
	CmdDraftReplace    // player: replace in-progress strokes (undo/clear; silent)
	cmdTestReadDrawing // test-only: synchronously read a player's stored draft via probe
	CmdSubmitGuess     // player: guess the artist during the guessing phase
	CmdNextPhase       // host: reveal → next round / ended
	CmdReturnToLobby   // host: ended → lobby (play again, keep players)
	CmdAdvance         // internal, timer-driven phase advance
	CmdPrune
	CmdReapIfEmpty
	CmdHostPrune  // internal: host display gone past grace → reap
	CmdEffectWave // internal: periodic frenzy wave; rolls an effect per player
)

// Tunables.
const (
	// DefaultGrace is how long a disconnected player (or a never-populated room)
	// is kept before being pruned/reaped. Survives refreshes and brief drops.
	DefaultGrace = 60 * time.Second
	// resumeGrace is the minimum time a timed phase resumes with after a restart
	// (deploy). The phase deadline is an absolute timestamp that keeps elapsing
	// while the process is down, so a deploy overlapping the phase end would
	// restore with ~0 left — instantly advancing the round and tripping every
	// client's auto-submit, which flips the host TV to "everyone done" the moment
	// the new build comes up. Flooring the resumed deadline gives the round time
	// to visibly continue instead.
	resumeGrace = 20 * time.Second
	// minPlayers is the smallest room that can start a game — you need an artist
	// plus enough guessers for "who drew this?" to be a real question.
	minPlayers = 4
	// maxPlayers caps a single room.
	maxPlayers = 12
	// maxFeatures caps how many drawings a single round guesses through, no matter
	// the headcount — keeps even a full room's round from dragging (see
	// guessesForPlayers). At maxPlayers this is the value the scale already lands on.
	maxFeatures = 5

	// Frenzy escalating cadence. The gap is a fraction of the phase that tightens
	// from gapStartFrac toward gapEndFrac as the buzzer nears, then jittered
	// ±waveJitterFrac so waves never fall on a predictable metronome. Crucially the
	// first wave and the gaps are clamped to ABSOLUTE bounds (maxFirstWave /
	// maxWaveGap), so a long drawing phase stays as lively as a short one instead
	// of scaling up into long dead stretches — the fractions only stretch the gaps
	// on short phases, never past the caps on long ones. Per-player effect
	// lifetimes are rolled in applyEffectWave (see effectLifetime), not from the gap.
	firstWaveFrac  = 0.06
	gapStartFrac   = 0.17
	gapEndFrac     = 0.06
	waveJitterFrac = 0.45
	minWaveGap     = 2500 * time.Millisecond
	maxFirstWave   = 5 * time.Second // chaos always starts within this, even on a long phase
	maxWaveGap     = 8 * time.Second // no gap ever exceeds this, even on a long phase

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
	// soloPot is the lone artist's award when they are the only one who drew this
	// round. With a single drawing, "who drew it?" has one trivially correct
	// answer, so guessing is skipped and the artist takes half the pot for the
	// unchallenged drawing (see beginSoloReveal).
	soloPot = pointsMax / 2
)

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
	Spectator bool           // join: true for the host display (non-playing TV)
	AsHost    bool           // join: true for a playing host (a player who owns the room)
	Unsub     chan GameState // disconnect: channel to drop from the sub set
	Ack       chan string    // join: "" on accept, else a rejection message
	Gen       int            // prune/advance: generation captured when the timer was armed

	// Game payloads.
	Strokes []Stroke // submitDrawing
	Guess   string   // submitGuess: the guessed artist's name
	GuessID string   // submitGuess (flipped): the chosen drawing id, resolved server-side to its owner
	Config  *Config  // configure

	// probe is a test-only channel used by cmdTestReadDrawing to synchronously
	// return a copy of a player's stored draft strokes. Always nil in production.
	probe chan []Stroke
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

	// promptDeck is the current game's prompt pool, shuffled, drawn from the end
	// one word per round so no word repeats until the deck is exhausted (then it
	// reshuffles). In-memory only — not persisted, so a mid-game resume just
	// reshuffles, which is harmless.
	promptDeck []string

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
			dirty := r.handle(c)
			if r.isDone() {
				return // reaped inside handle; skip broadcast/persist
			}
			if dirty {
				r.broadcast()
				r.persist()
			}
		}
	}
}

// onStart arms the initial grace timers. A never-populated room gets an empty
// timer; a snapshot-restored room starts everyone disconnected (in grace), so
// abandoned restored rooms reap while reconnecting clients save themselves. A
// restored mid-round resumes its phase timer so the game doesn't stall.
func (r *Room) onStart() {
	// A display host has its own (non-player) presence; a playing host is restored
	// as one of the players below, so it doesn't get a separate r.host.
	if r.state.Host != "" && !r.state.HostPlays {
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
		// Losing the playing host ends the room (same as losing a display host),
		// so it gets a host-prune; every other player gets the usual prune.
		if r.state.HostPlays && p.Name == r.state.Host {
			r.armHostPrune(pr.gen)
		} else {
			r.armPrune(p.Name, pr.gen)
		}
	}
	if r.state.Phase == PhaseDrawing || r.state.Phase == PhaseGuessing {
		r.phaseGen++
		d := time.Until(time.UnixMilli(r.state.PhaseEndsAt))
		// A restart that ate the phase down to (or past) its end must not resume
		// with d≈0 — that would advance immediately. Hand back a fixed window and
		// re-stamp the deadline; the next broadcast re-syncs every client's
		// countdown to it. See resumeGrace.
		if d < resumeGrace {
			d = resumeGrace
			r.state.PhaseEndsAt = time.Now().Add(d).UnixMilli()
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

// armWave schedules the next Frenzy effect wave. The captured generation makes
// the timer a no-op once the phase changes (mirrors armAdvance), so waves
// naturally stop when the round leaves drawing/guessing.
func (r *Room) armWave(gen int, d time.Duration) {
	time.AfterFunc(d, func() {
		r.Submit(Command{Kind: CmdEffectWave, Gen: gen})
	})
}

// phaseDurationMs is the configured length of the current timed play phase, or 0
// outside drawing/guessing.
func (r *Room) phaseDurationMs() int {
	switch r.state.Phase {
	case PhaseDrawing:
		return r.state.DrawMs
	case PhaseGuessing:
		return r.state.GuessMs
	default:
		return 0
	}
}

// phaseProgress is how far (0..1) the current timed play phase has elapsed, from
// PhaseEndsAt and the phase's configured duration. 0 outside drawing/guessing.
func (r *Room) phaseProgress() float64 {
	dur := r.phaseDurationMs()
	if dur <= 0 {
		return 0
	}
	remaining := r.state.PhaseEndsAt - time.Now().UnixMilli()
	return clampF(1-float64(remaining)/float64(dur), 0, 1)
}

// firstWaveDelay is when a phase's first wave lands: firstWaveFrac of the phase,
// floored at minWaveGap and capped at maxFirstWave so even a long phase opens
// with chaos quickly (no long effect-free intro).
func firstWaveDelay(durMs int) time.Duration {
	d := time.Duration(firstWaveFrac*float64(durMs)) * time.Millisecond
	if d < minWaveGap {
		d = minWaveGap
	}
	if d > maxFirstWave {
		d = maxFirstWave
	}
	return d
}

// waveGap is the smooth (un-jittered) baseline delay to the next wave at phase
// progress p: it tightens from gapStartFrac to gapEndFrac of the phase as p→1,
// floored at minWaveGap and capped at maxWaveGap so long phases don't drift into
// slow, sparse waves. nextWaveGap jitters this for the live schedule.
func waveGap(progress float64, durMs int) time.Duration {
	frac := gapStartFrac + (gapEndFrac-gapStartFrac)*clampF(progress, 0, 1)
	gap := time.Duration(frac*float64(durMs)) * time.Millisecond
	if gap < minWaveGap {
		gap = minWaveGap
	}
	if gap > maxWaveGap {
		gap = maxWaveGap
	}
	return gap
}

// nextWaveGap is the live delay to the next wave: the waveGap baseline scattered
// by ±waveJitterFrac so waves never land on a metronome — you can't count the
// beat and brace for the next hit. Floored at minWaveGap.
func nextWaveGap(progress float64, durMs int) time.Duration {
	base := waveGap(progress, durMs)
	span := float64(base) * waveJitterFrac
	gap := time.Duration(float64(base) + (rand.Float64()*2-1)*span)
	if gap < minWaveGap {
		gap = minWaveGap
	}
	return gap
}

func (r *Room) isDone() bool {
	select {
	case <-r.done:
		return true
	default:
		return false
	}
}

func (r *Room) handle(c Command) bool {
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
		// The host (display TV or playing host) stayed gone past grace → hand the
		// room to another player instead of ending it. The captured gen makes a
		// reconnected host cancel this.
		if !r.hostConnected() && r.hostGen() == c.Gen {
			r.hostDeparted()
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
	case CmdDraftAppend:
		r.draftAppend(c)
		return false
	case CmdDraftReplace:
		r.draftReplace(c)
		return false
	case CmdSubmitGuess:
		r.submitGuess(c)
	case CmdNextPhase:
		if c.Player == r.state.Host && r.state.Phase == PhaseReveal {
			// Reveal → the next drawing to guess in this round, else the next round
			// (or the end). The host clicks through each featured drawing.
			r.advanceAfterReveal()
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
	case CmdEffectWave:
		if c.Gen == r.phaseGen {
			progress := r.phaseProgress()
			// Each victim's effect kind, severity, strike time and lifetime are
			// rolled per-player inside applyEffectWave.
			r.applyEffectWave(r.state.Phase, progress)
			r.armWave(r.phaseGen, nextWaveGap(progress, r.phaseDurationMs()))
		}
	case cmdTestReadDrawing:
		if c.probe != nil {
			c.probe <- append([]Stroke(nil), r.state.Drawings[c.Player]...)
		}
		return false
	}
	return true
}
