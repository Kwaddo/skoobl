package hub

import (
	"context"
	"sync"
	"testing"
	"time"

	"skoobl/internal/game"
)

func TestCreateLookupDelete(t *testing.T) {
	h := New()
	code, room := h.Create()
	if len(code) == 0 || room == nil {
		t.Fatal("Create returned empty code or nil room")
	}
	got, ok := h.Lookup(code)
	if !ok || got != room {
		t.Fatal("Lookup did not return the created room")
	}
	h.Delete(code)
	if _, ok := h.Lookup(code); ok {
		t.Fatal("room still present after Delete")
	}
}

func TestConcurrentCreate(t *testing.T) {
	h := New()
	var wg sync.WaitGroup
	codes := make(chan string, 100)
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, _ := h.Create()
			codes <- c
		}()
	}
	wg.Wait()
	close(codes)
	seen := map[string]bool{}
	for c := range codes {
		if seen[c] {
			t.Fatalf("duplicate code generated: %s", c)
		}
		seen[c] = true
	}
}

// fakeStore is an in-memory hub.Store for tests.
type fakeStore struct {
	mu      sync.Mutex
	data    map[string][]byte
	deletes map[string]bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{data: map[string][]byte{}, deletes: map[string]bool{}}
}

func (f *fakeStore) SaveSnapshot(_ context.Context, code string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.data[code] = data
	return nil
}

func (f *fakeStore) LoadSnapshot(_ context.Context, code string) ([]byte, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.data[code]
	return b, ok, nil
}

func (f *fakeStore) DeleteSnapshot(_ context.Context, code string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.data, code)
	f.deletes[code] = true
	return nil
}

func (f *fakeStore) deleted(code string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.deletes[code]
}

func TestLookupRestoresFromStoreOnMiss(t *testing.T) {
	store := newFakeStore()
	// Seed a snapshot for a code the registry has never seen.
	snap := []byte(`{"code":"seed01","phase":"inRound","host":"alice","players":[{"name":"alice"}]}`)
	_ = store.SaveSnapshot(context.Background(), "seed01", snap)

	h := New(WithStore(store))
	room, ok := h.Lookup("seed01")
	if !ok || room == nil {
		t.Fatal("Lookup did not restore room from store snapshot")
	}
	// Restored room is running and serves the restored state.
	sub := make(chan game.GameState, 8)
	room.Submit(game.Command{Kind: game.CmdJoin, Player: "bob", Subscribe: sub})
	select {
	case s := <-sub:
		if s.Host != "alice" {
			t.Fatalf("restored host = %q, want alice", s.Host)
		}
	case <-time.After(time.Second):
		t.Fatal("restored room did not broadcast")
	}
}

func TestLookupMissWithoutSnapshotReturnsFalse(t *testing.T) {
	h := New(WithStore(newFakeStore()))
	if _, ok := h.Lookup("nope99"); ok {
		t.Fatal("Lookup returned a room for an unknown code")
	}
}

func TestCreatedRoomsPersist(t *testing.T) {
	store := newFakeStore()
	h := New(WithStore(store))
	code, room := h.Create()
	room.Submit(game.Command{Kind: game.CmdJoin, Player: "alice", Subscribe: make(chan game.GameState, 8)})
	for i := 0; i < 20; i++ {
		store.mu.Lock()
		_, ok := store.data[code]
		store.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("created room never persisted a snapshot")
}

func TestEmptyRoomReaped(t *testing.T) {
	store := newFakeStore()
	h := New(WithStore(store), WithGrace(20*time.Millisecond))
	code, _ := h.Create() // nobody ever joins

	// After the creation grace, the room reaps itself: gone from the map and its
	// snapshot deleted so Lookup can't rehydrate it.
	deadline := time.After(time.Second)
	for {
		if _, ok := h.Lookup(code); !ok && store.deleted(code) {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("room %s not reaped (lookup or delete missing)", code)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestRestoredRoomReapedIfAbandoned(t *testing.T) {
	store := newFakeStore()
	// Seed a snapshot with a player who never reconnects.
	snap := []byte(`{"code":"aband1","phase":"lobby","host":"alice","players":[{"name":"alice"}]}`)
	_ = store.SaveSnapshot(context.Background(), "aband1", snap)

	h := New(WithStore(store), WithGrace(20*time.Millisecond))
	if _, ok := h.Lookup("aband1"); !ok { // restores a running room
		t.Fatal("Lookup did not restore the seeded room")
	}
	// Nobody reconnects → the restored player prunes → room reaps + snapshot deleted.
	deadline := time.After(time.Second)
	for {
		if !store.deleted("aband1") {
			select {
			case <-deadline:
				t.Fatal("abandoned restored room was not reaped/deleted")
			case <-time.After(10 * time.Millisecond):
			}
			continue
		}
		return
	}
}

func TestStopAllStopsRooms(t *testing.T) {
	h := New(WithGrace(time.Second))
	c1, _ := h.Create()
	c2, _ := h.Create()
	h.StopAll()
	if _, ok := h.Lookup(c1); ok {
		t.Fatal("room 1 still present after StopAll")
	}
	if _, ok := h.Lookup(c2); ok {
		t.Fatal("room 2 still present after StopAll")
	}
}
