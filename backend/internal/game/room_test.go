package game

import (
	"context"
	"encoding/json"
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

func TestRoomJoinAndStart(t *testing.T) {
	r := NewRoom("abc123")
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 8)
	r.Submit(Command{Kind: CmdJoin, Player: "alice", Subscribe: sub})
	s := nextState(t, sub)
	if s.Host != "alice" {
		t.Fatalf("host = %q, want alice (first joiner)", s.Host)
	}
	if len(s.Players) != 1 {
		t.Fatalf("players = %d, want 1", len(s.Players))
	}

	r.Submit(Command{Kind: CmdJoin, Player: "bob", Subscribe: make(chan GameState, 8)})
	s = nextState(t, sub)
	if len(s.Players) != 2 {
		t.Fatalf("players = %d, want 2", len(s.Players))
	}

	// Non-host cannot start.
	r.Submit(Command{Kind: CmdStart, Player: "bob"})
	r.Submit(Command{Kind: CmdStart, Player: "alice"})
	var phase Phase
	for i := 0; i < 4; i++ {
		s = nextState(t, sub)
		phase = s.Phase
		if phase == PhaseInRound {
			break
		}
	}
	if phase != PhaseInRound {
		t.Fatalf("phase = %q, want inRound after host start", phase)
	}
}

func TestRoomUnsubscribeStopsBroadcasts(t *testing.T) {
	r := NewRoom("unsub01")
	go r.Run()
	defer r.Stop()

	stay := make(chan GameState, 8)
	gone := make(chan GameState, 8)
	r.Submit(Command{Kind: CmdJoin, Player: "alice", Subscribe: stay})
	nextState(t, stay)

	// Subscribe gone and block-read its broadcast: because the room is a single
	// goroutine processing commands in order, once gone has received the
	// bob-join broadcast, that broadcast has also already been delivered to
	// stay. Drain stay afterward so its next read reflects only future state.
	r.Submit(Command{Kind: CmdJoin, Player: "bob", Subscribe: gone})
	nextState(t, gone)
	drain(stay)
	drain(gone)

	// Unsubscribe the second channel.
	r.Submit(Command{Kind: CmdUnsubscribe, Unsub: gone})

	// Trigger a state change. Only the remaining channel should receive it.
	// The unsubscribe itself also broadcasts the (still 2-player) state to the
	// remaining channel, so read until we observe carol's join.
	r.Submit(Command{Kind: CmdJoin, Player: "carol", Subscribe: nil})
	var s GameState
	for i := 0; i < 4; i++ {
		s = nextState(t, stay)
		if len(s.Players) == 3 {
			break
		}
	}
	if len(s.Players) != 3 {
		t.Fatalf("players = %d, want 3 on remaining channel", len(s.Players))
	}

	select {
	case s := <-gone:
		t.Fatalf("unsubscribed channel still received broadcast: %+v", s)
	case <-time.After(200 * time.Millisecond):
		// expected: nothing arrives on the unsubscribed channel
	}
}

func TestRoomSubmitAnswerOnlyInRound(t *testing.T) {
	r := NewRoom("xyz789")
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 16)
	r.Submit(Command{Kind: CmdJoin, Player: "alice", Subscribe: sub})
	nextState(t, sub)

	r.Submit(Command{Kind: CmdSubmitAnswer, Player: "alice", Answer: "early"})
	r.Submit(Command{Kind: CmdStart, Player: "alice"})

	var got GameState
	for i := 0; i < 4; i++ {
		got = nextState(t, sub)
		if got.Phase == PhaseInRound {
			break
		}
	}
	r.Submit(Command{Kind: CmdSubmitAnswer, Player: "alice", Answer: "banana"})
	got = nextState(t, sub)
	if idx := got.playerIndex("alice"); idx < 0 || got.Players[idx].Answer != "banana" {
		t.Fatalf("answer not recorded in round: %+v", got.Players)
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
	r := NewRoomWithStore("persist1", snap)
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 8)
	r.Submit(Command{Kind: CmdJoin, Player: "alice", Subscribe: sub})
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
	original := GameState{Code: "restore1", Phase: PhaseInRound, Host: "bob",
		Players: []Player{{Name: "bob"}, {Name: "carol"}}}
	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	r, err := NewRoomFromSnapshot("restore1", data, nil)
	if err != nil {
		t.Fatalf("NewRoomFromSnapshot: %v", err)
	}
	go r.Run()
	defer r.Stop()

	sub := make(chan GameState, 8)
	// Joining a brand-new player triggers a broadcast carrying restored state.
	r.Submit(Command{Kind: CmdJoin, Player: "dave", Subscribe: sub})
	s := nextState(t, sub)
	if s.Host != "bob" || s.Phase != PhaseInRound {
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
