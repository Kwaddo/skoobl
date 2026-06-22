package game

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"
)

// drain consumes any currently-buffered states without blocking.
func drain(ch <-chan GameState) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

// nextState returns the next broadcast GameState within a timeout.
func nextState(t *testing.T, ch <-chan GameState) GameState {
	t.Helper()
	select {
	case s := <-ch:
		return s
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for state broadcast")
		return GameState{}
	}
}

// awaitPhase reads forward on a player's channel until it sees a broadcast in
// the wanted phase, returning that view.
func awaitPhase(t *testing.T, ch chan GameState, want Phase) GameState {
	t.Helper()
	deadline := time.After(2 * time.Second)
	var last Phase
	for {
		select {
		case s := <-ch:
			last = s.Phase
			if s.Phase == want {
				return s
			}
		case <-deadline:
			t.Fatalf("never reached phase %q (last seen %q)", want, last)
			return GameState{}
		}
	}
}

func TestRoomJoinAndStart(t *testing.T) {
	r := NewRoom("abc123")
	go r.Run()
	defer r.Stop()

	hostSub := make(chan GameState, 32)
	joinSpec(t, r, "tv", hostSub)
	if s := nextState(t, hostSub); s.Host != "tv" {
		t.Fatalf("host = %q, want tv (spectator)", s.Host)
	}

	sub := make(chan GameState, 32)
	joinOK(t, r, "alice", sub)
	joinOK(t, r, "bob", make(chan GameState, 8))
	joinOK(t, r, "carol", make(chan GameState, 8))

	// Three players is below minPlayers; the host can't start, and the host is
	// not itself counted as a player.
	r.Submit(Command{Kind: CmdStart, Player: "tv"})
	s := poke(t, r, sub)
	if s.Phase != PhaseLobby {
		t.Fatalf("phase = %q, want lobby (start needs %d players)", s.Phase, minPlayers)
	}
	if len(s.Players) != 3 {
		t.Fatalf("players = %d, want 3 (host excluded)", len(s.Players))
	}

	// A fourth player lets the host start into the drawing phase.
	joinOK(t, r, "dave", make(chan GameState, 8))
	r.Submit(Command{Kind: CmdStart, Player: "alice"}) // non-host: ignored
	r.Submit(Command{Kind: CmdStart, Player: "tv"})    // host: starts
	got := awaitPhase(t, sub, PhaseDrawing)
	if got.YourPrompt == "" {
		t.Fatal("alice received no prompt to draw in the drawing phase")
	}
}

func TestSpectatorHostNotAPlayer(t *testing.T) {
	r := NewRoom("spec1")
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 16)
	joinSpec(t, r, "tv", sub)
	s := nextState(t, sub)
	if s.Host != "tv" {
		t.Fatalf("host = %q, want tv", s.Host)
	}
	if len(s.Players) != 0 {
		t.Fatalf("players = %d, want 0 (host is not a player)", len(s.Players))
	}
}

func TestSecondHostRejected(t *testing.T) {
	r := NewRoom("spec2")
	go r.Run()
	defer r.Stop()

	joinSpec(t, r, "tv", make(chan GameState, 16))
	// A second host with a different name is rejected.
	ack := make(chan string, 1)
	r.Submit(Command{Kind: CmdJoin, Player: "tv2", Spectator: true, Subscribe: make(chan GameState, 16), Ack: ack})
	if msg := <-ack; msg == "" {
		t.Fatal("a second host with a different name was accepted")
	}
}

func TestPlayerCannotTakeHostName(t *testing.T) {
	r := NewRoom("spec3")
	go r.Run()
	defer r.Stop()

	joinSpec(t, r, "tv", make(chan GameState, 16))
	if msg := joinErr(t, r, "tv", make(chan GameState, 16)); msg == "" {
		t.Fatal("a player took the host's reserved name")
	}
}

func TestSpectatorCannotTakePlayerName(t *testing.T) {
	r := NewRoom("spec4")
	go r.Run()
	defer r.Stop()

	joinOK(t, r, "alice", make(chan GameState, 16))
	ack := make(chan string, 1)
	r.Submit(Command{Kind: CmdJoin, Player: "alice", Spectator: true, Subscribe: make(chan GameState, 16), Ack: ack})
	if msg := <-ack; msg == "" {
		t.Fatal("a spectator took an existing player's name")
	}
}

func TestFullRoundFlowAndScoring(t *testing.T) {
	r := NewRoom("flow1")
	go r.Run()
	defer r.Stop()

	joinSpec(t, r, "tv", make(chan GameState, 64))
	names := []string{"alice", "bob", "carol", "dave"}
	chans := map[string]chan GameState{}
	for _, n := range names {
		ch := make(chan GameState, 64)
		chans[n] = ch
		joinOK(t, r, n, ch)
	}

	r.Submit(Command{Kind: CmdStart, Player: "tv"})
	awaitPhase(t, chans["alice"], PhaseDrawing)

	// Everyone submits a drawing → the round auto-advances to guessing.
	for _, n := range names {
		r.Submit(Command{Kind: CmdSubmitDrawing, Player: n, Strokes: []Stroke{
			{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}, {X: 2, Y: 2}}},
		}})
	}

	// The featured artist is hidden in the shared view but flagged in their own.
	artist := ""
	for _, n := range names {
		if v := awaitPhase(t, chans[n], PhaseGuessing); v.YouAreArtist {
			artist = n
		}
	}
	if artist == "" {
		t.Fatal("no featured artist surfaced in the guessing phase")
	}

	// Every non-artist guesses correctly → the round auto-advances to reveal.
	for _, n := range names {
		if n != artist {
			r.Submit(Command{Kind: CmdSubmitGuess, Player: n, Guess: artist})
		}
	}

	rev := awaitPhase(t, chans["alice"], PhaseReveal)
	if rev.Reveal == nil || rev.Reveal.Artist != artist {
		t.Fatalf("reveal = %+v, want artist %q", rev.Reveal, artist)
	}
	for _, p := range rev.Players {
		if p.Name == artist {
			if p.Score != 0 {
				t.Fatalf("artist %s scored %d, want 0 (everyone identified them)", p.Name, p.Score)
			}
			continue
		}
		if p.Score < pointsMax-speedSpread || p.Score > pointsMax {
			t.Fatalf("guesser %s scored %d, want within [%d,%d]", p.Name, p.Score, pointsMax-speedSpread, pointsMax)
		}
	}
}

func TestReturnToLobbyResetsAndAllowsRestart(t *testing.T) {
	r := NewRoom("relobby")
	go r.Run()
	defer r.Stop()

	joinSpec(t, r, "tv", make(chan GameState, 64))
	names := []string{"alice", "bob", "carol", "dave"}
	chans := map[string]chan GameState{}
	for _, n := range names {
		ch := make(chan GameState, 64)
		chans[n] = ch
		joinOK(t, r, n, ch)
	}

	// Run a one-round game through to the ended phase.
	r.Submit(Command{Kind: CmdConfigure, Player: "tv", Config: &Config{
		Rounds: 1, DrawMs: 30_000, GuessMs: 15_000,
	}})
	r.Submit(Command{Kind: CmdStart, Player: "tv"})
	awaitPhase(t, chans["alice"], PhaseDrawing)
	for _, n := range names {
		r.Submit(Command{Kind: CmdSubmitDrawing, Player: n, Strokes: []Stroke{
			{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}}},
		}})
	}
	// 4 players → the round guesses through guessesForPlayers(4)=2 drawings, each
	// with its own guessing + reveal; the host clicks through both before the
	// (single, last) round ends.
	for f := 0; f < guessesForPlayers(len(names)); f++ {
		guessFeatureToReveal(t, r, chans, names)
		r.Submit(Command{Kind: CmdNextPhase, Player: "tv"})
	}
	awaitPhase(t, chans["alice"], PhaseEnded)

	// A non-host cannot send everyone back to the lobby.
	r.Submit(Command{Kind: CmdReturnToLobby, Player: "alice"})
	if s := poke(t, r, chans["bob"]); s.Phase != PhaseEnded {
		t.Fatalf("non-host returned the room to lobby: phase=%q", s.Phase)
	}

	// The host returns everyone to the lobby with a clean slate.
	r.Submit(Command{Kind: CmdReturnToLobby, Player: "tv"})
	s := awaitPhase(t, chans["alice"], PhaseLobby)
	if s.Round != 0 {
		t.Fatalf("round = %d, want 0 after return to lobby", s.Round)
	}
	if len(s.Players) != 4 {
		t.Fatalf("players = %d, want 4 kept", len(s.Players))
	}
	for _, p := range s.Players {
		if p.Score != 0 {
			t.Fatalf("%s score = %d, want 0 after return to lobby", p.Name, p.Score)
		}
	}

	// And the host can immediately start a fresh game.
	r.Submit(Command{Kind: CmdStart, Player: "tv"})
	awaitPhase(t, chans["alice"], PhaseDrawing)
}

func TestBelowMinReturnsToLobby(t *testing.T) {
	r := NewRoom("belowmin", WithGrace(time.Hour))
	go r.Run()
	defer r.Stop()

	joinSpec(t, r, "tv", make(chan GameState, 64))
	names := []string{"alice", "bob", "carol", "dave"}
	chans := map[string]chan GameState{}
	for _, n := range names {
		ch := make(chan GameState, 64)
		chans[n] = ch
		joinOK(t, r, n, ch)
	}

	r.Submit(Command{Kind: CmdStart, Player: "tv"})
	awaitPhase(t, chans["alice"], PhaseDrawing)

	// dave leaves → only three players remain, below minPlayers, so the whole
	// room bounces back to the lobby instead of limping along under-strength.
	r.Submit(Command{Kind: CmdLeave, Player: "dave", Unsub: chans["dave"]})

	s := awaitPhase(t, chans["alice"], PhaseLobby)
	if len(s.Players) != 3 {
		t.Fatalf("players = %d, want 3 after one left", len(s.Players))
	}
	if s.Round != 0 {
		t.Fatalf("round = %d, want 0 back in the lobby", s.Round)
	}
	for _, p := range s.Players {
		if p.Score != 0 {
			t.Fatalf("%s score = %d, want 0 after the bounce", p.Name, p.Score)
		}
	}
}

func TestBriefDisconnectDoesNotBounce(t *testing.T) {
	r := NewRoom("nobounce", WithGrace(time.Hour)) // long grace: no prune mid-test
	go r.Run()
	defer r.Stop()

	joinSpec(t, r, "tv", make(chan GameState, 64))
	names := []string{"alice", "bob", "carol", "dave"}
	chans := map[string]chan GameState{}
	for _, n := range names {
		ch := make(chan GameState, 64)
		chans[n] = ch
		joinOK(t, r, n, ch)
	}

	r.Submit(Command{Kind: CmdStart, Player: "tv"})
	awaitPhase(t, chans["alice"], PhaseDrawing)

	// dave's socket drops (a refresh) but he stays in the roster during grace, so
	// the game must keep running — a transient blip is not a real departure.
	r.Submit(Command{Kind: CmdDisconnect, Player: "dave", Unsub: chans["dave"]})

	s := poke(t, r, chans["alice"])
	if s.Phase != PhaseDrawing {
		t.Fatalf("phase = %q, want drawing (a brief disconnect must not bounce)", s.Phase)
	}
	if len(s.Players) != 4 {
		t.Fatalf("players = %d, want 4 (dave still in the roster during grace)", len(s.Players))
	}
}

func TestHostLeaveHandsOffToPlayer(t *testing.T) {
	r := NewRoom("handoff", WithGrace(time.Hour))
	go r.Run()
	defer r.Stop()

	hostSub := make(chan GameState, 16)
	joinSpec(t, r, "tv", hostSub)
	playerSub := make(chan GameState, 16)
	joinOK(t, r, "alice", playerSub)
	drain(playerSub)

	// The display host leaving hands the room to the remaining player rather than
	// closing it: alice becomes the (playing) host and the room stays open.
	r.Submit(Command{Kind: CmdLeave, Player: "tv", Unsub: hostSub})

	s := awaitHostIs(t, playerSub, "alice")
	if !s.HostPlays {
		t.Fatal("HostPlays = false after hand-off, want true (new host is a player)")
	}
	if s.Closed {
		t.Fatal("room closed after hand-off, want it to stay open")
	}
}

// awaitHostIs reads forward until it sees a broadcast whose Host is `want`.
func awaitHostIs(t *testing.T, ch chan GameState, want string) GameState {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case s := <-ch:
			if s.Host == want {
				return s
			}
		case <-deadline:
			t.Fatalf("host never became %q", want)
			return GameState{}
		}
	}
}

func TestHostLeaveClosesWhenAlone(t *testing.T) {
	reaped := make(chan struct{}, 1)
	r := NewRoom("alone", WithGrace(time.Hour),
		WithReaper(func() { reaped <- struct{}{} }))
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 16)
	joinSpec(t, r, "tv", sub) // host only, nobody to hand off to
	r.Submit(Command{Kind: CmdLeave, Player: "tv", Unsub: sub})
	select {
	case <-reaped:
	case <-time.After(time.Second):
		t.Fatal("room not reaped when the lone host left (nobody to take over)")
	}
}

func TestHostReturnsToLobbyMidGame(t *testing.T) {
	r := NewRoom("midlobby", WithGrace(time.Hour))
	go r.Run()
	defer r.Stop()

	joinSpec(t, r, "tv", make(chan GameState, 64))
	names := []string{"alice", "bob", "carol", "dave"}
	chans := map[string]chan GameState{}
	for _, n := range names {
		ch := make(chan GameState, 64)
		chans[n] = ch
		joinOK(t, r, n, ch)
	}

	r.Submit(Command{Kind: CmdStart, Player: "tv"})
	awaitPhase(t, chans["alice"], PhaseDrawing)

	// A non-host cannot abandon a running game.
	r.Submit(Command{Kind: CmdReturnToLobby, Player: "alice"})
	if s := poke(t, r, chans["bob"]); s.Phase != PhaseDrawing {
		t.Fatalf("non-host returned a running game to the lobby: phase=%q", s.Phase)
	}

	// The host can return everyone to the lobby before the game ends.
	r.Submit(Command{Kind: CmdReturnToLobby, Player: "tv"})
	s := awaitPhase(t, chans["alice"], PhaseLobby)
	if s.Round != 0 || len(s.Players) != 4 {
		t.Fatalf("after a mid-game return: round=%d players=%d, want 0 and 4", s.Round, len(s.Players))
	}
}

func TestConfigureAppliesAndClamps(t *testing.T) {
	r := NewRoom("cfg1")
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 16)
	joinSpec(t, r, "tv", sub)
	joinOK(t, r, "alice", make(chan GameState, 16))

	r.Submit(Command{Kind: CmdConfigure, Player: "tv", Config: &Config{
		Rounds:     99, // clamped to maxRounds
		Language:   LangAR,
		DrawMs:     30_000,
		GuessMs:    15_000,
		Categories: []string{" apple ", "apple", "", "banana"}, // trim + dedupe + drop empty
	}})
	s := poke(t, r, sub)
	if s.TotalRounds != maxRounds {
		t.Fatalf("rounds = %d, want clamp to %d", s.TotalRounds, maxRounds)
	}
	if s.Language != LangAR {
		t.Fatalf("language = %q, want ar", s.Language)
	}
	// Non-host (a player) configure is ignored.
	r.Submit(Command{Kind: CmdConfigure, Player: "alice", Config: &Config{Rounds: 1}})
	if s := poke(t, r, sub); s.TotalRounds != maxRounds {
		t.Fatalf("non-host configure changed rounds to %d", s.TotalRounds)
	}
}

// fakeSnap records every SaveSnapshot call. Safe for single-room tests because
// the room goroutine is the only caller.
type fakeSnap struct {
	mu    sync.Mutex
	saves map[string][]byte
}

func newFakeSnap() *fakeSnap { return &fakeSnap{saves: map[string][]byte{}} }

func (f *fakeSnap) SaveSnapshot(_ context.Context, code string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.saves[code] = data
	return nil
}

func (f *fakeSnap) last(code string) ([]byte, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.saves[code]
	return b, ok
}

func TestRoomPersistsAfterStateChange(t *testing.T) {
	snap := newFakeSnap()
	r := NewRoom("persist1", WithSnapshotter(snap))
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 8)
	r.Submit(Command{Kind: CmdJoin, Player: "alice", Spectator: true, Subscribe: sub})
	nextState(t, sub)

	// Poll briefly: persist happens inside the room goroutine after broadcast.
	var data []byte
	for i := 0; i < 20; i++ {
		if b, ok := snap.last("persist1"); ok {
			data = b
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if data == nil {
		t.Fatal("no snapshot saved after join")
	}
	var gs GameState
	if err := json.Unmarshal(data, &gs); err != nil {
		t.Fatalf("snapshot not valid GameState json: %v", err)
	}
	if gs.Host != "alice" {
		t.Fatalf("snapshot host = %q, want alice", gs.Host)
	}
}

func TestNewRoomFromSnapshotRestoresState(t *testing.T) {
	// PhaseEndsAt far in the future so the resumed drawing timer doesn't fire
	// during the test (we're asserting the restored phase, not the transition).
	original := GameState{Code: "restore1", Phase: PhaseDrawing, Host: "bob",
		PhaseEndsAt: 9_999_999_999_999,
		Players:     []Player{{Name: "bob"}, {Name: "carol"}}}
	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	r, err := NewRoomFromSnapshot("restore1", data)
	if err != nil {
		t.Fatalf("NewRoomFromSnapshot: %v", err)
	}
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 8)
	// Joining a brand-new player triggers a broadcast carrying restored state.
	r.Submit(Command{Kind: CmdJoin, Player: "dave", Subscribe: sub})
	s := nextState(t, sub)
	if s.Host != "bob" || s.Phase != PhaseDrawing {
		t.Fatalf("restored state lost: host=%q phase=%q", s.Host, s.Phase)
	}
	if len(s.Players) != 3 {
		t.Fatalf("players = %d, want 3 (2 restored + dave)", len(s.Players))
	}
}

func TestRestoreExtendsExpiredPhaseDeadline(t *testing.T) {
	// A deploy that overlaps the drawing deadline restores a phase whose
	// PhaseEndsAt is already in the past. Resuming must NOT instantly advance
	// (that flips the host to "everyone done" and trips client auto-submit); it
	// re-stamps the deadline a fixed grace ahead so the round visibly resumes.
	original := GameState{Code: "resume1", Phase: PhaseDrawing, Host: "bob",
		PhaseEndsAt: time.Now().Add(-time.Minute).UnixMilli(),
		Players:     []Player{{Name: "bob"}, {Name: "carol"}}}
	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	r, err := NewRoomFromSnapshot("resume1", data)
	if err != nil {
		t.Fatalf("NewRoomFromSnapshot: %v", err)
	}
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 8)
	r.Submit(Command{Kind: CmdJoin, Player: "dave", Subscribe: sub})
	s := nextState(t, sub)
	if s.Phase != PhaseDrawing {
		t.Fatalf("phase = %q, want drawing (must not advance on resume)", s.Phase)
	}
	if left := time.Until(time.UnixMilli(s.PhaseEndsAt)); left < resumeGrace/2 {
		t.Fatalf("resumed deadline only %s out, want ~%s (not extended)", left, resumeGrace)
	}
}

func TestNilSnapshotterDoesNotPanic(t *testing.T) {
	r := NewRoom("nilsnap") // snap is nil
	go r.Run()
	defer r.Stop()
	sub := make(chan GameState, 8)
	r.Submit(Command{Kind: CmdJoin, Player: "alice", Subscribe: sub})
	nextState(t, sub) // would panic on persist if nil not guarded
}

// joinPlaying submits a playing-host join (the host is also a player) and asserts
// the room accepts it (empty ack).
func joinPlaying(t *testing.T, r *Room, name string, sub chan GameState) {
	t.Helper()
	ack := make(chan string, 1)
	r.Submit(Command{Kind: CmdJoin, Player: name, AsHost: true, Subscribe: sub, Ack: ack})
	select {
	case msg := <-ack:
		if msg != "" {
			t.Fatalf("playing-host join %q rejected: %q", name, msg)
		}
	case <-time.After(time.Second):
		t.Fatalf("playing-host join %q: no ack", name)
	}
}

func TestPlayingHostIsAPlayer(t *testing.T) {
	r := NewRoom("ph1")
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 32)
	joinPlaying(t, r, "boss", sub)
	s := nextState(t, sub)
	if s.Host != "boss" {
		t.Fatalf("host = %q, want boss", s.Host)
	}
	if !s.HostPlays {
		t.Fatal("HostPlays = false, want true for a playing host")
	}
	if s.playerIndex("boss") < 0 {
		t.Fatalf("playing host not in the roster: %+v", s.Players)
	}
}

func TestPlayingHostStartsAndPlays(t *testing.T) {
	r := NewRoom("ph2")
	go r.Run()
	defer r.Stop()

	bossCh := make(chan GameState, 64)
	joinPlaying(t, r, "boss", bossCh)
	for _, n := range []string{"alice", "bob", "carol"} {
		joinOK(t, r, n, make(chan GameState, 16))
	}

	// The playing host counts toward the minimum (boss + 3 = 4) and can start.
	r.Submit(Command{Kind: CmdStart, Player: "boss"})
	got := awaitPhase(t, bossCh, PhaseDrawing)
	if got.YourPrompt == "" {
		t.Fatal("playing host got no prompt — they should draw like any player")
	}
}

func TestPlayingHostCountsTowardMinPlayers(t *testing.T) {
	r := NewRoom("ph3")
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 64)
	joinPlaying(t, r, "boss", sub)
	joinOK(t, r, "alice", make(chan GameState, 16))
	joinOK(t, r, "bob", make(chan GameState, 16))

	// boss + 2 = 3 connected, below minPlayers (4): start is ignored.
	r.Submit(Command{Kind: CmdStart, Player: "boss"})
	if s := poke(t, r, sub); s.Phase != PhaseLobby {
		t.Fatalf("phase = %q, want lobby (3 < %d)", s.Phase, minPlayers)
	}

	// A fourth participant lets the playing host start.
	joinOK(t, r, "carol", make(chan GameState, 16))
	r.Submit(Command{Kind: CmdStart, Player: "boss"})
	awaitPhase(t, sub, PhaseDrawing)
}

func TestPlayingHostLeaveHandsOff(t *testing.T) {
	r := NewRoom("ph4", WithGrace(time.Hour))
	go r.Run()
	defer r.Stop()

	bossCh := make(chan GameState, 16)
	joinPlaying(t, r, "boss", bossCh)
	playerCh := make(chan GameState, 16)
	joinOK(t, r, "alice", playerCh)
	drain(playerCh)

	// The playing host leaving hands the room to alice; it stays open and boss is
	// dropped from the roster.
	r.Submit(Command{Kind: CmdLeave, Player: "boss", Unsub: bossCh})
	s := awaitHostIs(t, playerCh, "alice")
	if s.Closed {
		t.Fatal("room closed after the playing host handed off, want open")
	}
	if s.playerIndex("boss") >= 0 {
		t.Fatalf("boss still in roster after leaving: %+v", s.Players)
	}
}

func TestPlayingHostReconnectKeepsRoom(t *testing.T) {
	reaped := make(chan struct{}, 1)
	r := NewRoom("ph5", WithGrace(40*time.Millisecond),
		WithReaper(func() { reaped <- struct{}{} }))
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 16)
	joinPlaying(t, r, "boss", sub)
	r.Submit(Command{Kind: CmdDisconnect, Player: "boss", Unsub: sub})
	sub2 := make(chan GameState, 16)
	joinPlaying(t, r, "boss", sub2) // reconnect before grace
	select {
	case <-reaped:
		t.Fatal("room reaped despite the playing host reconnecting before grace")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestPlayingHostDisconnectClosesAfterGrace(t *testing.T) {
	reaped := make(chan struct{}, 1)
	r := NewRoom("ph6", WithGrace(20*time.Millisecond),
		WithReaper(func() { reaped <- struct{}{} }))
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 16)
	joinPlaying(t, r, "boss", sub)
	r.Submit(Command{Kind: CmdDisconnect, Player: "boss", Unsub: sub})
	select {
	case <-reaped:
	case <-time.After(time.Second):
		t.Fatal("room not reaped after the playing host stayed gone past grace")
	}
}

// joinOK submits a join and asserts the room accepts it (empty ack).
func joinOK(t *testing.T, r *Room, name string, sub chan GameState) {
	t.Helper()
	ack := make(chan string, 1)
	r.Submit(Command{Kind: CmdJoin, Player: name, Subscribe: sub, Ack: ack})
	select {
	case msg := <-ack:
		if msg != "" {
			t.Fatalf("join %q rejected: %q", name, msg)
		}
	case <-time.After(time.Second):
		t.Fatalf("join %q: no ack", name)
	}
}

// joinSpec submits a spectator (host display) join and asserts acceptance.
func joinSpec(t *testing.T, r *Room, name string, sub chan GameState) {
	t.Helper()
	ack := make(chan string, 1)
	r.Submit(Command{Kind: CmdJoin, Player: name, Spectator: true, Subscribe: sub, Ack: ack})
	select {
	case msg := <-ack:
		if msg != "" {
			t.Fatalf("spectator join %q rejected: %q", name, msg)
		}
	case <-time.After(time.Second):
		t.Fatalf("spectator join %q: no ack", name)
	}
}

// joinErr submits a join and returns the rejection message ("" means accepted).
func joinErr(t *testing.T, r *Room, name string, sub chan GameState) string {
	t.Helper()
	ack := make(chan string, 1)
	r.Submit(Command{Kind: CmdJoin, Player: name, Subscribe: sub, Ack: ack})
	select {
	case msg := <-ack:
		return msg
	case <-time.After(time.Second):
		t.Fatal("join: no ack")
		return ""
	}
}

// poke forces a broadcast (a no-op command still broadcasts) and returns state.
func poke(t *testing.T, r *Room, sub chan GameState) GameState {
	t.Helper()
	drain(sub)
	r.Submit(Command{Kind: CmdStart, Player: "\x00nobody"}) // not host → no change
	return nextState(t, sub)
}

func TestReconnectKeepsPlayer(t *testing.T) {
	r := NewRoom("recon1", WithGrace(20*time.Millisecond))
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 16)
	joinOK(t, r, "alice", sub)
	joinOK(t, r, "bob", make(chan GameState, 16)) // keep room non-empty

	r.Submit(Command{Kind: CmdDisconnect, Player: "alice", Unsub: sub})
	sub2 := make(chan GameState, 16)
	joinOK(t, r, "alice", sub2) // reconnect before grace
	time.Sleep(50 * time.Millisecond)

	s := poke(t, r, sub2)
	if s.playerIndex("alice") < 0 {
		t.Fatalf("alice pruned despite reconnect: %+v", s.Players)
	}
}

func TestPruneAfterGrace(t *testing.T) {
	r := NewRoom("prune1", WithGrace(20*time.Millisecond))
	go r.Run()
	defer r.Stop()

	subA := make(chan GameState, 16)
	joinOK(t, r, "alice", subA)
	subB := make(chan GameState, 16)
	joinOK(t, r, "bob", subB)

	r.Submit(Command{Kind: CmdDisconnect, Player: "bob", Unsub: subB})
	time.Sleep(60 * time.Millisecond)

	s := poke(t, r, subA)
	if s.playerIndex("bob") >= 0 {
		t.Fatalf("bob not pruned after grace: %+v", s.Players)
	}
	if s.playerIndex("alice") < 0 {
		t.Fatal("alice wrongly removed")
	}
}

func TestRoomNotReapedWhileHostConnected(t *testing.T) {
	reaped := make(chan struct{}, 1)
	r := NewRoom("hostlive", WithGrace(20*time.Millisecond),
		WithReaper(func() { reaped <- struct{}{} }))
	go r.Run()
	defer r.Stop()

	joinSpec(t, r, "tv", make(chan GameState, 16)) // cancels the creation timer
	select {
	case <-reaped:
		t.Fatal("room reaped while the host was still connected")
	case <-time.After(80 * time.Millisecond):
	}
}

func TestRoomReapedWhenHostDisconnects(t *testing.T) {
	reaped := make(chan struct{}, 1)
	r := NewRoom("hostgone", WithGrace(20*time.Millisecond),
		WithReaper(func() { reaped <- struct{}{} }))
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 16)
	joinSpec(t, r, "tv", sub)
	r.Submit(Command{Kind: CmdDisconnect, Player: "tv", Unsub: sub})
	select {
	case <-reaped:
	case <-time.After(time.Second):
		t.Fatal("room not reaped after the host disconnected past grace")
	}
}

func TestRoomReapedWhenHostLeaves(t *testing.T) {
	reaped := make(chan struct{}, 1)
	r := NewRoom("hostleave", WithGrace(time.Hour),
		WithReaper(func() { reaped <- struct{}{} }))
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 16)
	joinSpec(t, r, "tv", sub)
	r.Submit(Command{Kind: CmdLeave, Player: "tv", Unsub: sub})
	select {
	case <-reaped:
	case <-time.After(time.Second):
		t.Fatal("room not reaped after the host left explicitly")
	}
}

func TestHostGonePastGraceHandsOffToPlayer(t *testing.T) {
	reaped := make(chan struct{}, 1)
	r := NewRoom("hostreq", WithGrace(20*time.Millisecond),
		WithReaper(func() { reaped <- struct{}{} }))
	go r.Run()
	defer r.Stop()

	hostSub := make(chan GameState, 16)
	joinSpec(t, r, "tv", hostSub)
	aliceSub := make(chan GameState, 16)
	joinOK(t, r, "alice", aliceSub) // a player stays

	// The host's socket drops and doesn't return within grace: rather than reaping,
	// the room hands off to alice, who stays to keep playing.
	r.Submit(Command{Kind: CmdDisconnect, Player: "tv", Unsub: hostSub})
	s := awaitHostIs(t, aliceSub, "alice")
	if !s.HostPlays {
		t.Fatal("HostPlays = false after hand-off past grace, want true")
	}
	select {
	case <-reaped:
		t.Fatal("room reaped despite a player being available to take over")
	case <-time.After(60 * time.Millisecond):
	}
}

func TestHostReconnectKeepsRoom(t *testing.T) {
	reaped := make(chan struct{}, 1)
	r := NewRoom("hostrecon", WithGrace(40*time.Millisecond),
		WithReaper(func() { reaped <- struct{}{} }))
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 16)
	joinSpec(t, r, "tv", sub)
	r.Submit(Command{Kind: CmdDisconnect, Player: "tv", Unsub: sub})
	sub2 := make(chan GameState, 16)
	joinSpec(t, r, "tv", sub2) // reconnect before grace expires
	select {
	case <-reaped:
		t.Fatal("room reaped despite the host reconnecting before grace")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestLeaveReapsWhenEmpty(t *testing.T) {
	reaped := make(chan struct{}, 1)
	r := NewRoom("leave2", WithGrace(time.Hour),
		WithReaper(func() { reaped <- struct{}{} }))
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 16)
	joinOK(t, r, "alice", sub)
	r.Submit(Command{Kind: CmdLeave, Player: "alice", Unsub: sub})

	select {
	case <-reaped:
	case <-time.After(time.Second):
		t.Fatal("room not reaped after the last player left explicitly")
	}
}

func TestDuplicateNameRejected(t *testing.T) {
	r := NewRoom("dup1", WithGrace(time.Second))
	go r.Run()
	defer r.Stop()

	joinOK(t, r, "alice", make(chan GameState, 16))
	if msg := joinErr(t, r, "alice", make(chan GameState, 16)); msg == "" {
		t.Fatal("duplicate connected name was accepted")
	}
}

func TestRoomCap(t *testing.T) {
	r := NewRoom("cap1", WithGrace(time.Second))
	go r.Run()
	defer r.Stop()

	for i := 0; i < maxPlayers; i++ {
		joinOK(t, r, fmt.Sprintf("p%d", i), make(chan GameState, 16))
	}
	if msg := joinErr(t, r, "overflow", make(chan GameState, 16)); msg == "" {
		t.Fatalf("join past cap of %d was accepted", maxPlayers)
	}
}

func TestJoinRejectedWhenEnded(t *testing.T) {
	data, _ := json.Marshal(GameState{Code: "end1", Phase: PhaseEnded,
		Host: "alice", Players: []Player{{Name: "alice"}}})
	r, err := NewRoomFromSnapshot("end1", data, WithGrace(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	go r.Run()
	defer r.Stop()

	if msg := joinErr(t, r, "bob", make(chan GameState, 16)); msg == "" {
		t.Fatal("join into an ended game was accepted")
	}
}

func TestEmptyRoomReapedOnCreationGrace(t *testing.T) {
	reaped := make(chan struct{}, 1)
	r := NewRoom("empty1", WithGrace(20*time.Millisecond),
		WithReaper(func() { reaped <- struct{}{} }))
	go r.Run()
	defer r.Stop()

	select {
	case <-reaped:
	case <-time.After(time.Second):
		t.Fatal("never-populated room was not reaped")
	}
}

func TestRoomReapedAfterLastPlayerLeaves(t *testing.T) {
	reaped := make(chan struct{}, 1)
	r := NewRoom("empty2", WithGrace(20*time.Millisecond),
		WithReaper(func() { reaped <- struct{}{} }))
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 16)
	joinOK(t, r, "alice", sub) // cancels the creation timer
	r.Submit(Command{Kind: CmdDisconnect, Player: "alice", Unsub: sub})

	select {
	case <-reaped:
	case <-time.After(time.Second):
		t.Fatal("room not reaped after last player left + grace")
	}
}

func TestDisconnectStopsBroadcasts(t *testing.T) {
	r := NewRoom("unsub01", WithGrace(time.Second))
	go r.Run()
	defer r.Stop()

	stay := make(chan GameState, 16)
	joinOK(t, r, "alice", stay)
	gone := make(chan GameState, 16)
	joinOK(t, r, "bob", gone)
	drain(stay)
	drain(gone)

	// bob drops: gone is unsubscribed (bob stays present during the 1s grace).
	r.Submit(Command{Kind: CmdDisconnect, Player: "bob", Unsub: gone})
	joinOK(t, r, "carol", nil)

	var s GameState
	for i := 0; i < 5; i++ {
		s = nextState(t, stay)
		if s.playerIndex("carol") >= 0 {
			break
		}
	}
	if s.playerIndex("carol") < 0 {
		t.Fatal("remaining channel did not receive carol join")
	}
	select {
	case x := <-gone:
		t.Fatalf("unsubscribed channel still received: %+v", x)
	case <-time.After(150 * time.Millisecond):
	}
}

func TestSpeedScoreCurve(t *testing.T) {
	// Window is [90_000, 100_000] (GuessMs before PhaseEndsAt).
	r := &Room{state: GameState{GuessMs: 10_000, PhaseEndsAt: 100_000}}
	cases := []struct {
		name      string
		guessedAt int64
		want      int
	}{
		{"instant", 90_000, pointsMax},
		{"midpoint", 95_000, pointsMax - speedSpread/2},
		{"buzzer", 100_000, pointsMax - speedSpread},
		{"before window clamps to max", 80_000, pointsMax},
		{"after window clamps to floor", 120_000, pointsMax - speedSpread},
	}
	for _, c := range cases {
		if got := r.speedScore(c.guessedAt); got != c.want {
			t.Fatalf("%s: speedScore(%d) = %d, want %d", c.name, c.guessedAt, got, c.want)
		}
	}
}

func TestArtistPot(t *testing.T) {
	cases := []struct{ correct, eligible, want int }{
		{0, 3, 100}, // nobody identifies → full pot
		{3, 3, 0},   // everyone identifies → nothing
		{1, 3, 67},  // one of three ≈ two-thirds
		{2, 4, 50},  // half
		{0, 0, 100}, // edge: no eligible guessers at all
	}
	for _, c := range cases {
		if got := artistPot(c.correct, c.eligible); got != c.want {
			t.Fatalf("artistPot(%d, %d) = %d, want %d", c.correct, c.eligible, got, c.want)
		}
	}
}

func TestArtistPotWhenNoneIdentify(t *testing.T) {
	r := NewRoom("pot0", WithGrace(time.Hour))
	go r.Run()
	defer r.Stop()

	joinSpec(t, r, "tv", make(chan GameState, 64))
	names := []string{"alice", "bob", "carol", "dave"}
	chans := map[string]chan GameState{}
	for _, n := range names {
		ch := make(chan GameState, 64)
		chans[n] = ch
		joinOK(t, r, n, ch)
	}

	r.Submit(Command{Kind: CmdStart, Player: "tv"})
	awaitPhase(t, chans["alice"], PhaseDrawing)
	for _, n := range names {
		r.Submit(Command{Kind: CmdSubmitDrawing, Player: n, Strokes: []Stroke{
			{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}}},
		}})
	}

	artist := ""
	for _, n := range names {
		if v := awaitPhase(t, chans[n], PhaseGuessing); v.YouAreArtist {
			artist = n
		}
	}
	if artist == "" {
		t.Fatal("no featured artist surfaced")
	}

	// Every guesser names a wrong player (anyone who is not the artist), so nobody
	// identifies the artist. allGuessed then advances to reveal.
	wrong := ""
	for _, n := range names {
		if n != artist {
			wrong = n
			break
		}
	}
	for _, n := range names {
		if n != artist {
			r.Submit(Command{Kind: CmdSubmitGuess, Player: n, Guess: wrong})
		}
	}

	rev := awaitPhase(t, chans["alice"], PhaseReveal)
	for _, p := range rev.Players {
		want := 0
		if p.Name == artist {
			want = pointsMax // nobody identified them → full pot
		}
		if p.Score != want {
			t.Fatalf("%s scored %d, want %d", p.Name, p.Score, want)
		}
	}
}

func TestRevealViewCarriesRoundScore(t *testing.T) {
	r := NewRoom("delta1", WithGrace(time.Hour))
	go r.Run()
	defer r.Stop()

	joinSpec(t, r, "tv", make(chan GameState, 64))
	names := []string{"alice", "bob", "carol", "dave"}
	chans := map[string]chan GameState{}
	for _, n := range names {
		ch := make(chan GameState, 64)
		chans[n] = ch
		joinOK(t, r, n, ch)
	}

	r.Submit(Command{Kind: CmdStart, Player: "tv"})
	awaitPhase(t, chans["alice"], PhaseDrawing)
	for _, n := range names {
		r.Submit(Command{Kind: CmdSubmitDrawing, Player: n, Strokes: []Stroke{
			{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}}},
		}})
	}
	artist := ""
	for _, n := range names {
		if v := awaitPhase(t, chans[n], PhaseGuessing); v.YouAreArtist {
			artist = n
		}
	}
	for _, n := range names {
		if n != artist {
			r.Submit(Command{Kind: CmdSubmitGuess, Player: n, Guess: artist})
		}
	}

	rev := awaitPhase(t, chans["alice"], PhaseReveal)
	for _, p := range rev.Players {
		if p.Name == artist {
			continue // pot is 0 here; omitempty drops it, which is fine
		}
		if p.RoundScore == 0 {
			t.Fatalf("guesser %s has RoundScore 0 in the reveal view, want their earned points", p.Name)
		}
		if p.RoundScore != p.Score {
			t.Fatalf("%s RoundScore %d != Score %d (single round, should match)", p.Name, p.RoundScore, p.Score)
		}
	}
}

func TestCorrectGuessCountsAfterDisconnect(t *testing.T) {
	r := NewRoom("dcpot", WithGrace(time.Hour)) // long grace: guesser isn't pruned
	go r.Run()
	defer r.Stop()

	hostCh := make(chan GameState, 64)
	joinSpec(t, r, "tv", hostCh)
	names := []string{"alice", "bob", "carol", "dave"}
	chans := map[string]chan GameState{}
	for _, n := range names {
		ch := make(chan GameState, 64)
		chans[n] = ch
		joinOK(t, r, n, ch)
	}

	r.Submit(Command{Kind: CmdStart, Player: "tv"})
	awaitPhase(t, chans["alice"], PhaseDrawing)
	for _, n := range names {
		r.Submit(Command{Kind: CmdSubmitDrawing, Player: n, Strokes: []Stroke{
			{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}}},
		}})
	}
	artist := ""
	for _, n := range names {
		if v := awaitPhase(t, chans[n], PhaseGuessing); v.YouAreArtist {
			artist = n
		}
	}

	// Pick a correct guesser who is not the artist; they guess right, then drop.
	first := ""
	for _, n := range names {
		if n != artist {
			first = n
			break
		}
	}
	r.Submit(Command{Kind: CmdSubmitGuess, Player: first, Guess: artist})
	r.Submit(Command{Kind: CmdDisconnect, Player: first, Unsub: chans[first]})

	// The remaining two connected guessers name a wrong player, advancing to reveal.
	for _, n := range names {
		if n == artist || n == first {
			continue
		}
		r.Submit(Command{Kind: CmdSubmitGuess, Player: n, Guess: n}) // self ≠ artist → wrong
	}

	rev := awaitPhase(t, hostCh, PhaseReveal)
	// eligible = 2 connected guessers + the disconnected-but-correct one = 3; 1 correct.
	wantPot := artistPot(1, 3) // 67
	scores := map[string]int{}
	for _, p := range rev.Players {
		scores[p.Name] = p.Score
	}
	if scores[artist] != wantPot {
		t.Fatalf("artist pot = %d, want %d (correct guess must survive the disconnect)", scores[artist], wantPot)
	}
	if scores[first] < pointsMax-speedSpread || scores[first] > pointsMax {
		t.Fatalf("disconnected correct guesser scored %d, want within [%d,%d]", scores[first], pointsMax-speedSpread, pointsMax)
	}
}

func TestSanitizePreservesFill(t *testing.T) {
	in := []Stroke{{Color: "#ff0000", Width: 4, Points: []Point{{X: 5, Y: 5}}, Fill: true}}
	out := sanitizeStrokes(in)
	if len(out) != 1 {
		t.Fatalf("got %d strokes, want 1", len(out))
	}
	if !out[0].Fill {
		t.Fatal("fill flag dropped by sanitizeStrokes")
	}
	if out[0].Color != "#ff0000" {
		t.Fatalf("color = %q, want #ff0000", out[0].Color)
	}
}

func TestSanitizeRejectsBadFillColor(t *testing.T) {
	in := []Stroke{{Color: "javascript:alert(1)", Width: 4, Points: []Point{{X: 5, Y: 5}}, Fill: true}}
	out := sanitizeStrokes(in)
	if len(out) != 1 || out[0].Color != defaultStrokeColor {
		t.Fatalf("color = %q, want sanitized default", out[0].Color)
	}
	if !out[0].Fill {
		t.Fatal("fill flag dropped while sanitizing a bad color")
	}
}

// syncLobby joins a host display ("tv") plus players and stops in the lobby
// (unlike syncRoom, which also starts the game). The tv is the host, so it may
// configure.
func syncLobby(t *testing.T, players ...string) *Room {
	t.Helper()
	r := NewRoom("lobby1")
	r.handle(Command{Kind: CmdJoin, Player: "tv", Spectator: true,
		Subscribe: make(chan GameState, 64), Ack: make(chan string, 1)})
	for _, n := range players {
		r.handle(Command{Kind: CmdJoin, Player: n,
			Subscribe: make(chan GameState, 64), Ack: make(chan string, 1)})
	}
	if r.state.Phase != PhaseLobby {
		t.Fatalf("phase = %q, want lobby", r.state.Phase)
	}
	return r
}

func TestModeConfiguredAndEchoed(t *testing.T) {
	r := syncLobby(t, "alice", "bob", "carol", "dave")

	r.handle(Command{Kind: CmdConfigure, Player: "tv", Config: &Config{
		Rounds: 3, Mode: ModeFlipped, DrawMs: 60000, GuessMs: 25000,
	}})
	if r.state.Mode != ModeFlipped {
		t.Fatalf("mode = %q, want flipped", r.state.Mode)
	}
	if v := r.state.viewFor("alice", r.present); v.Mode != ModeFlipped {
		t.Fatalf("view mode = %q, want flipped (must be public)", v.Mode)
	}

	// Unknown mode falls back to classic.
	r.handle(Command{Kind: CmdConfigure, Player: "tv", Config: &Config{
		Rounds: 3, Mode: "wat", DrawMs: 60000, GuessMs: 25000,
	}})
	if r.state.Mode != ModeClassic {
		t.Fatalf("mode = %q, want classic fallback", r.state.Mode)
	}
}

// syncRoom builds a room and joins a host + the given players by calling handle
// directly (no Run goroutine), then starts the game. Returns the room in the
// drawing phase.
func syncRoom(t *testing.T, players ...string) *Room {
	t.Helper()
	r := NewRoom("sync1")
	r.handle(Command{Kind: CmdJoin, Player: "tv", Spectator: true,
		Subscribe: make(chan GameState, 64), Ack: make(chan string, 1)})
	for _, n := range players {
		r.handle(Command{Kind: CmdJoin, Player: n,
			Subscribe: make(chan GameState, 64), Ack: make(chan string, 1)})
	}
	r.handle(Command{Kind: CmdStart, Player: "tv"})
	if r.state.Phase != PhaseDrawing {
		t.Fatalf("phase = %q, want drawing after start", r.state.Phase)
	}
	return r
}

func draft(r *Room, name string) {
	r.handle(Command{Kind: CmdDraftAppend, Player: name, Strokes: []Stroke{
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}, {X: 2, Y: 2}}},
	}})
}

func TestDraftStoresWithoutAdvancing(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	for _, n := range []string{"alice", "bob", "carol", "dave"} {
		draft(r, n)
	}
	if r.state.Phase != PhaseDrawing {
		t.Fatalf("phase = %q, want drawing (drafts must not early-advance)", r.state.Phase)
	}
	if len(r.state.Drawings["alice"]) == 0 {
		t.Fatal("alice's draft was not stored server-side")
	}
	if r.state.Locked["alice"] {
		t.Fatal("a draft must not set the lock")
	}
}

func TestAllLockedAdvancesToGuessing(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	for _, n := range []string{"alice", "bob", "carol", "dave"} {
		r.handle(Command{Kind: CmdSubmitDrawing, Player: n, Strokes: []Stroke{
			{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}, {X: 2, Y: 2}}},
		}})
	}
	if r.state.Phase != PhaseGuessing {
		t.Fatalf("phase = %q, want guessing once everyone locked", r.state.Phase)
	}
}

func TestTimerExpiryKeepsUnlockedDrafts(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	// Only drafts — nobody locks in. Then the drawing timer fires.
	for _, n := range []string{"alice", "bob", "carol", "dave"} {
		draft(r, n)
	}
	r.advance() // simulates the drawing-phase timer expiring
	if r.state.Phase != PhaseGuessing {
		t.Fatalf("phase = %q, want guessing after expiry", r.state.Phase)
	}
	if r.state.Featured == "" {
		t.Fatal("no artist featured — an unlocked draft was discarded")
	}
	if len(r.state.Drawings[r.state.Featured]) == 0 {
		t.Fatal("featured artist's draft strokes were lost")
	}
}

func TestEmptyDraftNotFeatured(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	draft(r, "alice") // only alice draws anything
	r.advance()
	if r.state.Featured != "alice" {
		t.Fatalf("featured = %q, want alice (the only non-empty draft)", r.state.Featured)
	}
}

func TestHostRevealCarriesGallery(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	for _, n := range []string{"alice", "bob", "carol", "dave"} {
		draft(r, n)
	}
	r.advance()     // → guessing, picks a featured artist
	r.beginReveal() // → reveal
	if r.state.Phase != PhaseReveal {
		t.Fatalf("phase = %q, want reveal", r.state.Phase)
	}
	host := r.state.viewFor("tv", r.present)
	if len(host.Gallery) != 4 {
		t.Fatalf("host gallery has %d drawings, want 4", len(host.Gallery))
	}
	if len(host.Gallery["alice"]) == 0 {
		t.Fatal("host gallery has no strokes for alice")
	}
	player := r.state.viewFor("alice", r.present)
	if player.Gallery != nil {
		t.Fatalf("player view leaked a gallery: %+v", player.Gallery)
	}
}

func TestLockedFlagInView(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	r.handle(Command{Kind: CmdSubmitDrawing, Player: "alice", Strokes: []Stroke{
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}}},
	}})
	v := r.state.viewFor("tv", r.present)
	var aliceLocked, bobLocked bool
	for _, p := range v.Players {
		if p.Name == "alice" {
			aliceLocked = p.Locked
		}
		if p.Name == "bob" {
			bobLocked = p.Locked
		}
	}
	if !aliceLocked {
		t.Fatal("alice locked in but view shows Locked=false")
	}
	if bobLocked {
		t.Fatal("bob never locked but view shows Locked=true")
	}
}

func TestSoloDrawingSkipsGuessing(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	draft(r, "alice") // only alice draws anything
	r.advance()       // drawing timer fires → beginGuessing

	if r.state.Phase != PhaseReveal {
		t.Fatalf("phase = %q, want reveal (one drawing skips guessing)", r.state.Phase)
	}
	if r.state.Featured != "alice" {
		t.Fatalf("featured = %q, want alice", r.state.Featured)
	}
	if got := r.state.LastDeltas["alice"]; got != soloPot {
		t.Fatalf("alice delta = %d, want %d (solo half-pot)", got, soloPot)
	}
	if i := r.state.playerIndex("alice"); r.state.Players[i].Score != soloPot {
		t.Fatalf("alice score = %d, want %d", r.state.Players[i].Score, soloPot)
	}
	for _, n := range []string{"bob", "carol", "dave"} {
		if got := r.state.LastDeltas[n]; got != 0 {
			t.Fatalf("%s delta = %d, want 0 (no guessing happened)", n, got)
		}
	}
	if len(r.state.FeaturedPast) != 1 || r.state.FeaturedPast[0] != "alice" {
		t.Fatalf("featuredPast = %v, want [alice]", r.state.FeaturedPast)
	}
}

func TestTwoDrawingsStillGuess(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	draft(r, "alice")
	draft(r, "bob")
	r.advance()
	if r.state.Phase != PhaseGuessing {
		t.Fatalf("phase = %q, want guessing (two drawings is a real round)", r.state.Phase)
	}
}

// guessFeatureToReveal finds the featured artist in the current guessing phase
// and has every other player correctly identify them, advancing to that feature's
// reveal. Used to click through a round that guesses several drawings in a row.
func guessFeatureToReveal(t *testing.T, r *Room, chans map[string]chan GameState, names []string) {
	t.Helper()
	// Drain stale broadcasts, then force one fresh frame: a single feature emits
	// several guessing broadcasts as guesses land, so without this a later feature
	// could read a leftover earlier-feature view and misidentify the artist.
	for _, n := range names {
		drain(chans[n])
	}
	r.Submit(Command{Kind: CmdStart, Player: "\x00nobody"}) // not host → no-op rebroadcast
	artist := ""
	for _, n := range names {
		if v := awaitPhase(t, chans[n], PhaseGuessing); v.YouAreArtist {
			artist = n
		}
	}
	if artist == "" {
		t.Fatal("no featured artist surfaced in the guessing phase")
	}
	for _, n := range names {
		if n != artist {
			r.Submit(Command{Kind: CmdSubmitGuess, Player: n, Guess: artist})
		}
	}
	awaitPhase(t, chans[names[0]], PhaseReveal)
}

func TestGuessesForPlayersScales(t *testing.T) {
	cases := []struct{ players, want int }{
		{4, 2}, {5, 2}, // small rooms guess two drawings
		{6, 3}, {8, 3}, // +1 per ~3 extra players
		{9, 4}, {11, 4},
		{12, 5}, // capped at maxFeatures (the room cap lands here naturally)
	}
	for _, c := range cases {
		if got := guessesForPlayers(c.players); got != c.want {
			t.Fatalf("guessesForPlayers(%d) = %d, want %d", c.players, got, c.want)
		}
		if got := guessesForPlayers(c.players); got > maxFeatures {
			t.Fatalf("guessesForPlayers(%d) = %d, exceeds maxFeatures %d", c.players, got, maxFeatures)
		}
	}
}

func TestRoundGuessesMultipleDistinctDrawings(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	for _, n := range []string{"alice", "bob", "carol", "dave"} {
		draft(r, n)
	}
	r.advance() // drawing timer → first feature's guessing

	if r.state.Phase != PhaseGuessing {
		t.Fatalf("phase = %q, want guessing", r.state.Phase)
	}
	if r.state.FeatureCount != 2 {
		t.Fatalf("featureCount = %d, want 2 (four players)", r.state.FeatureCount)
	}
	if r.state.FeatureIndex != 1 {
		t.Fatalf("featureIndex = %d, want 1 (first drawing)", r.state.FeatureIndex)
	}
	first := r.state.Featured

	// Reveal the first drawing, then the host advances to the second one.
	r.beginReveal()
	r.handle(Command{Kind: CmdNextPhase, Player: "tv"})
	if r.state.Phase != PhaseGuessing {
		t.Fatalf("phase = %q, want guessing for the second drawing", r.state.Phase)
	}
	if r.state.FeatureIndex != 2 {
		t.Fatalf("featureIndex = %d, want 2 (second drawing)", r.state.FeatureIndex)
	}
	if second := r.state.Featured; second == first {
		t.Fatalf("featured the same artist twice in one round: %q", second)
	}

	// Reveal the second drawing, then advancing rolls into the next round.
	r.beginReveal()
	r.handle(Command{Kind: CmdNextPhase, Player: "tv"})
	if r.state.Phase != PhaseDrawing {
		t.Fatalf("phase = %q, want drawing (round 2)", r.state.Phase)
	}
	if r.state.Round != 2 {
		t.Fatalf("round = %d, want 2", r.state.Round)
	}
	if r.state.FeatureIndex != 0 || r.state.FeatureCount != 0 || r.state.RoundFeatured != nil {
		t.Fatalf("feature state not reset on the new round: idx=%d count=%d featured=%v",
			r.state.FeatureIndex, r.state.FeatureCount, r.state.RoundFeatured)
	}
}

func TestFeatureCountCappedByDrawers(t *testing.T) {
	// Six players would target three drawings, but only two actually draw. With a
	// two-drawer margin (so a revealed artist never forces the next guess), a
	// two-drawer round guesses just one drawing.
	r := syncRoom(t, "p1", "p2", "p3", "p4", "p5", "p6")
	if got := guessesForPlayers(len(r.state.Players)); got != 3 {
		t.Fatalf("guessesForPlayers(6) = %d, want 3 (precondition)", got)
	}
	draft(r, "p1")
	draft(r, "p2")
	r.advance()
	if r.state.FeatureCount != 1 {
		t.Fatalf("featureCount = %d, want 1 (two drawers, two kept off-screen)", r.state.FeatureCount)
	}
}

func TestFeatureCountLeavesTwoDrawerMargin(t *testing.T) {
	// Eight players target three drawings, but only four draw. The two-drawer
	// margin caps the round at two so the second (final) drawing still has real
	// options once the first artist is struck from the choices.
	r := syncRoom(t, "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8")
	if got := guessesForPlayers(len(r.state.Players)); got != 3 {
		t.Fatalf("guessesForPlayers(8) = %d, want 3 (precondition)", got)
	}
	for _, n := range []string{"p1", "p2", "p3", "p4"} {
		draft(r, n)
	}
	r.advance()
	if r.state.FeatureCount != 2 {
		t.Fatalf("featureCount = %d, want 2 (four drawers, two kept off-screen)", r.state.FeatureCount)
	}
}

func TestRevealedArtistsHiddenFromGuessOptions(t *testing.T) {
	// A 4-player round guesses two drawings. While the second is up for guessing,
	// the first artist must be in `Revealed` (struck from the options) and the
	// second — still secret — must not be.
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	for _, n := range []string{"alice", "bob", "carol", "dave"} {
		draft(r, n)
	}
	r.advance() // → guessing the first drawing
	first := r.state.Featured

	r.beginReveal()
	r.handle(Command{Kind: CmdNextPhase, Player: "tv"}) // → guessing the second drawing
	second := r.state.Featured

	// Pick a guesser who is neither artist so the view is a real guesser's.
	guesser := ""
	for _, n := range []string{"alice", "bob", "carol", "dave"} {
		if n != first && n != second {
			guesser = n
			break
		}
	}
	v := r.state.viewFor(guesser, r.present)
	if len(v.Revealed) != 1 || v.Revealed[0] != first {
		t.Fatalf("revealed = %v, want exactly [%q]", v.Revealed, first)
	}
	for _, n := range v.Revealed {
		if n == second {
			t.Fatalf("revealed leaked the current (secret) artist %q", second)
		}
	}
}

func flippedRoomInGuessing(t *testing.T, names ...string) *Room {
	t.Helper()
	r := syncRoom(t, names...)
	r.state.Mode = ModeFlipped // configured in the lobby; set directly for the unit test
	for _, n := range names {
		draft(r, n)
	}
	r.advance() // drawing timer → flipped guessing
	if r.state.Phase != PhaseGuessing {
		t.Fatalf("phase = %q, want guessing", r.state.Phase)
	}
	return r
}

func TestFlippedGuessingView(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := flippedRoomInGuessing(t, names...)
	target := r.state.Featured

	guesser := "alice"
	if target == "alice" {
		guesser = "bob"
	}
	v := r.state.viewFor(guesser, r.present)
	if v.Mode != ModeFlipped {
		t.Fatalf("view mode = %q, want flipped", v.Mode)
	}
	if v.Target != target {
		t.Fatalf("target = %q, want %q", v.Target, target)
	}
	if v.YouAreTarget {
		t.Fatal("a non-target guesser must not see YouAreTarget")
	}
	if len(v.Pool) != 4 {
		t.Fatalf("pool size = %d, want 4 (all drew, none revealed)", len(v.Pool))
	}
	if v.CurrentDrawing != nil {
		t.Fatal("flipped guessing must not send a single currentDrawing")
	}
	for _, d := range v.Pool {
		if d.ID == "" {
			t.Fatal("pool drawing has no id")
		}
		for _, n := range names { // an id must never be a player name
			if d.ID == n {
				t.Fatalf("pool id %q leaks a player name", d.ID)
			}
		}
	}

	tv := r.state.viewFor(target, r.present)
	if !tv.YouAreTarget {
		t.Fatal("the target should see YouAreTarget")
	}
}

func TestFlippedPoolDropsRevealedTarget(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := flippedRoomInGuessing(t, names...)
	first := r.state.Featured
	firstID := r.state.DrawIDs[first]

	idsBefore := map[string]string{}
	for k, v := range r.state.DrawIDs {
		idsBefore[k] = v
	}

	r.beginReveal()
	r.handle(Command{Kind: CmdNextPhase, Player: "tv"}) // → second feature

	for k, v := range r.state.DrawIDs {
		if idsBefore[k] != v {
			t.Fatalf("draw id for %q changed across features (%q→%q)", k, idsBefore[k], v)
		}
	}

	second := r.state.Featured
	guesser := ""
	for _, n := range names {
		if n != first && n != second {
			guesser = n
			break
		}
	}
	v := r.state.viewFor(guesser, r.present)
	if len(v.Pool) != 3 {
		t.Fatalf("pool size = %d, want 3 (first target removed)", len(v.Pool))
	}
	for _, d := range v.Pool {
		if d.ID == firstID {
			t.Fatal("a revealed target's doodle is still in the pool")
		}
	}
}

func TestFlippedPoolOrderedById(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := flippedRoomInGuessing(t, names...)
	guesser := "alice"
	if r.state.Featured == "alice" {
		guesser = "bob"
	}

	v := r.state.viewFor(guesser, r.present)
	if len(v.Pool) < 2 {
		t.Fatalf("pool size = %d, want the full candidate set", len(v.Pool))
	}
	// The grid is shuffled by sorting on the opaque per-round id, decoupling a
	// doodle's slot from roster order. Verify ascending-id order.
	for i := 1; i < len(v.Pool); i++ {
		if v.Pool[i-1].ID >= v.Pool[i].ID {
			t.Fatalf("pool not ordered by id: %q is not before %q", v.Pool[i-1].ID, v.Pool[i].ID)
		}
	}
	// Ids are fixed for the round, so the order is stable across broadcasts —
	// tiles never jump mid-round. A second view yields the identical sequence.
	v2 := r.state.viewFor(guesser, r.present)
	for i := range v.Pool {
		if v.Pool[i].ID != v2.Pool[i].ID {
			t.Fatalf("pool order changed between views at %d: %q vs %q", i, v.Pool[i].ID, v2.Pool[i].ID)
		}
	}
}

func TestEmptyLockInIsNotADrawing(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	draft(r, "alice") // one real drawing
	// bob locks in an empty canvas — must not count as a second drawing.
	r.handle(Command{Kind: CmdSubmitDrawing, Player: "bob", Strokes: nil})
	r.advance()
	if r.state.Phase != PhaseReveal {
		t.Fatalf("phase = %q, want reveal (empty lock-in is not a drawing)", r.state.Phase)
	}
	if r.state.Featured != "alice" {
		t.Fatalf("featured = %q, want alice", r.state.Featured)
	}
	if got := r.state.LastDeltas["bob"]; got != 0 {
		t.Fatalf("bob delta = %d, want 0 (an empty lock-in must not score)", got)
	}
}

func TestFlippedCorrectGuessScores(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := flippedRoomInGuessing(t, names...)
	target := r.state.Featured
	targetID := r.state.DrawIDs[target]

	for _, n := range names {
		if n == target {
			continue
		}
		r.handle(Command{Kind: CmdSubmitGuess, Player: n, GuessID: targetID})
	}
	if r.state.Phase != PhaseReveal {
		t.Fatalf("phase = %q, want reveal once all non-targets matched", r.state.Phase)
	}
	for _, p := range r.state.Players {
		if p.Name == target {
			continue
		}
		if p.Score <= 0 {
			t.Fatalf("%s scored %d, want > 0 for a correct flipped match", p.Name, p.Score)
		}
	}
}

func TestFlippedWrongAndUnknownId(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := flippedRoomInGuessing(t, names...)
	target := r.state.Featured

	// A wrong (but valid) id: some non-target drawer's doodle.
	wrongOwner := ""
	for _, n := range names {
		if n != target {
			wrongOwner = n
			break
		}
	}
	wrongID := r.state.DrawIDs[wrongOwner]

	// An unknown id is ignored entirely (no guess recorded).
	r.handle(Command{Kind: CmdSubmitGuess, Player: pickGuesser(names, target), GuessID: "dffffffff"})
	if _, ok := r.state.Guesses[pickGuesser(names, target)]; ok {
		t.Fatal("an unknown id must not record a guess")
	}

	guesser := pickGuesser(names, target)
	r.handle(Command{Kind: CmdSubmitGuess, Player: guesser, GuessID: wrongID})
	if _, ok := r.state.Guesses[guesser]; !ok {
		t.Fatal("a valid wrong id should record a (wrong) guess")
	}
	if r.state.Guesses[guesser] == target {
		t.Fatal("a wrong id must not resolve to the target")
	}
}

// pickGuesser returns the first name that is not the target.
func pickGuesser(names []string, target string) string {
	for _, n := range names {
		if n != target {
			return n
		}
	}
	return ""
}

func TestFlippedRoundRunsTwoFeaturesAndAdvances(t *testing.T) {
	names := []string{"alice", "bob", "carol", "dave"}
	r := flippedRoomInGuessing(t, names...)

	// 4 drawers, two-drawer margin ⇒ two features this round (same as classic).
	if r.state.FeatureCount != 2 {
		t.Fatalf("featureCount = %d, want 2", r.state.FeatureCount)
	}
	first := r.state.Featured

	// Everyone matches the first target's doodle, then the host reveals + advances.
	guessAllCorrect(r, names, first)
	if r.state.Phase != PhaseReveal {
		t.Fatalf("phase = %q, want reveal after first feature", r.state.Phase)
	}
	r.handle(Command{Kind: CmdNextPhase, Player: "tv"})
	if r.state.Phase != PhaseGuessing {
		t.Fatalf("phase = %q, want guessing for the second feature", r.state.Phase)
	}
	second := r.state.Featured
	if second == first {
		t.Fatalf("featured the same target twice in one round: %q", second)
	}

	// Every non-target guesser must see the second target's drawing present but
	// unlabeled — among at least two candidates, so it can't be identified by
	// elimination. (The pool carries opaque ids only; no name→id map is sent.)
	for _, n := range names {
		if n == second {
			continue
		}
		v := r.state.viewFor(n, r.present)
		if len(v.Pool) < 2 {
			t.Fatalf("non-target %s sees a pool of %d — too few to hide the target", n, len(v.Pool))
		}
		found := false
		for _, d := range v.Pool {
			if d.ID == r.state.DrawIDs[second] {
				found = true
			}
		}
		if !found {
			t.Fatalf("non-target %s's pool is missing the (unlabeled) target drawing", n)
		}
	}

	guessAllCorrect(r, names, second)
	r.handle(Command{Kind: CmdNextPhase, Player: "tv"})
	if r.state.Phase != PhaseDrawing || r.state.Round != 2 {
		t.Fatalf("after the round: phase=%q round=%d, want drawing/2", r.state.Phase, r.state.Round)
	}
	if r.state.DrawIDs != nil {
		t.Fatal("DrawIDs should be cleared at the start of a new round")
	}
}

// guessAllCorrect has every non-target match the target's doodle id, driving the
// feature to its reveal.
func guessAllCorrect(r *Room, names []string, target string) {
	id := r.state.DrawIDs[target]
	for _, n := range names {
		if n == target {
			continue
		}
		r.handle(Command{Kind: CmdSubmitGuess, Player: n, GuessID: id})
	}
}

// ---------------------------------------------------------------------------
// Draft append/replace tests
// ---------------------------------------------------------------------------

// makePoints builds a slice of n points all at (1,1).
func makePoints(n int) []Point {
	pts := make([]Point, n)
	for i := range pts {
		pts[i] = Point{X: 1, Y: 1}
	}
	return pts
}

// newDrawingRoomWithSub starts a room with 4 players in the drawing phase and
// returns it plus p1's broadcast channel.
func newDrawingRoomWithSub(t *testing.T) (*Room, chan GameState) {
	t.Helper()
	r := NewRoom("draftsub1")
	go r.Run()
	t.Cleanup(r.Stop)

	sub := make(chan GameState, 32)
	joinSpec(t, r, "tv", make(chan GameState, 32))
	joinOK(t, r, "p1", sub)
	joinOK(t, r, "p2", make(chan GameState, 32))
	joinOK(t, r, "p3", make(chan GameState, 32))
	joinOK(t, r, "p4", make(chan GameState, 32))

	r.Submit(Command{Kind: CmdStart, Player: "tv"})
	awaitPhase(t, sub, PhaseDrawing)
	return r, sub
}

func drainOne(t *testing.T, ch chan GameState) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(time.Second):
		t.Fatal("expected a broadcast to drain")
	}
}

// drawingsFor synchronously reads a player's stored draft via the test-only
// cmdTestReadDrawing probe command.
func drawingsFor(t *testing.T, r *Room, name string) []Stroke {
	t.Helper()
	done := make(chan []Stroke, 1)
	r.Submit(Command{Kind: cmdTestReadDrawing, Player: name, probe: done})
	select {
	case got := <-done:
		return got
	case <-time.After(time.Second):
		t.Fatal("probe timed out")
		return nil
	}
}

func TestDraftAppendIsSilent(t *testing.T) {
	r, sub := newDrawingRoomWithSub(t)
	drain(sub) // drain any remaining broadcasts from entering the drawing phase

	r.Submit(Command{Kind: CmdDraftAppend, Player: "p1", Strokes: []Stroke{
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}, {X: 2, Y: 2}}},
	}})
	// Use the test probe as a flush barrier: it is processed silently (no
	// broadcast) after the draft, confirming the room goroutine has processed
	// both commands before we assert silence.
	_ = drawingsFor(t, r, "p1")

	select {
	case <-sub:
		t.Fatal("draft append must not broadcast")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestDraftAppendAccumulates(t *testing.T) {
	r, _ := newDrawingRoomWithSub(t)
	r.Submit(Command{Kind: CmdDraftAppend, Player: "p1", Strokes: []Stroke{
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}}},
	}})
	r.Submit(Command{Kind: CmdDraftAppend, Player: "p1", Strokes: []Stroke{
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 5, Y: 5}}},
	}})
	got := drawingsFor(t, r, "p1")
	if len(got) != 2 {
		t.Fatalf("want 2 accumulated strokes, got %d", len(got))
	}
}

func TestDraftReplaceOverwrites(t *testing.T) {
	r, _ := newDrawingRoomWithSub(t)
	r.Submit(Command{Kind: CmdDraftAppend, Player: "p1", Strokes: []Stroke{
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 1, Y: 1}}},
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 2, Y: 2}}},
	}})
	r.Submit(Command{Kind: CmdDraftReplace, Player: "p1", Strokes: []Stroke{
		{Color: "#ffffff", Width: 4, Points: []Point{{X: 9, Y: 9}}},
	}})
	got := drawingsFor(t, r, "p1")
	if len(got) != 1 || got[0].Points[0].X != 9 {
		t.Fatalf("replace should overwrite to a single stroke, got %#v", got)
	}
}

func TestAppendBoundedStrokesCapsTotalPoints(t *testing.T) {
	cur := []Stroke{{Color: "#ffffff", Width: 4, Points: makePoints(maxPointsTotal - 1)}}
	add := []Stroke{{Color: "#ffffff", Width: 4, Points: makePoints(10)}}
	out := appendBoundedStrokes(cur, add)
	total := 0
	for _, s := range out {
		total += len(s.Points)
	}
	if total > maxPointsTotal {
		t.Fatalf("combined points %d exceeds cap %d", total, maxPointsTotal)
	}
}
