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
		want := pointsPerCorrect
		if p.Name == artist {
			want = 0 // the artist doesn't guess and scores nothing this round
		}
		if p.Score != want {
			t.Fatalf("%s scored %d, want %d", p.Name, p.Score, want)
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
	awaitPhase(t, chans["alice"], PhaseReveal)
	r.Submit(Command{Kind: CmdNextPhase, Player: "tv"}) // last round → ended
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

func TestNilSnapshotterDoesNotPanic(t *testing.T) {
	r := NewRoom("nilsnap") // snap is nil
	go r.Run()
	defer r.Stop()
	sub := make(chan GameState, 8)
	r.Submit(Command{Kind: CmdJoin, Player: "alice", Subscribe: sub})
	nextState(t, sub) // would panic on persist if nil not guarded
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

func TestPlayersRemainButHostGoneReaps(t *testing.T) {
	reaped := make(chan struct{}, 1)
	r := NewRoom("hostreq", WithGrace(20*time.Millisecond),
		WithReaper(func() { reaped <- struct{}{} }))
	go r.Run()
	defer r.Stop()

	hostSub := make(chan GameState, 16)
	joinSpec(t, r, "tv", hostSub)
	joinOK(t, r, "alice", make(chan GameState, 16)) // a player stays

	r.Submit(Command{Kind: CmdDisconnect, Player: "tv", Unsub: hostSub})
	select {
	case <-reaped:
	case <-time.After(time.Second):
		t.Fatal("room not reaped after the required host disconnected, players present")
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
