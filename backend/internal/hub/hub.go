// Package hub maintains the registry of active game rooms.
package hub

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log"
	"sync"
	"time"

	"skoobl/internal/game"
)

// Store is the persistence the hub needs to restore rooms after a restart.
// Satisfied by store.RedisStore.
type Store interface {
	SaveSnapshot(ctx context.Context, code string, data []byte) error
	LoadSnapshot(ctx context.Context, code string) (data []byte, ok bool, err error)
	DeleteSnapshot(ctx context.Context, code string) error
}

// Option configures a Hub.
type Option func(*Hub)

// WithStore enables Redis-backed persistence and restore-on-miss.
func WithStore(s Store) Option { return func(h *Hub) { h.store = s } }

// WithGrace overrides the room grace period (tests use a tiny value).
func WithGrace(d time.Duration) Option { return func(h *Hub) { h.grace = d } }

// Hub owns the code→Room map. Lookups are read-mostly; the only
// read-modify-write paths (create/delete) are guarded by a mutex.
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]*game.Room
	store Store
	grace time.Duration
}

func New(opts ...Option) *Hub {
	h := &Hub{rooms: make(map[string]*game.Room), grace: game.DefaultGrace}
	for _, opt := range opts {
		opt(h)
	}
	return h
}

func generateCode() string {
	b := make([]byte, 3)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b) // 6 hex chars
}

// roomOpts builds the common game.RoomOption slice, injecting the reaper,
// grace period, and snapshotter (when a store is configured).
func (h *Hub) roomOpts(code string) []game.RoomOption {
	opts := []game.RoomOption{
		game.WithReaper(func() { h.reap(code) }),
		game.WithGrace(h.grace),
	}
	if h.store != nil {
		opts = append(opts, game.WithSnapshotter(h.store))
	}
	return opts
}

// Create makes a new started room and registers it under a unique code.
func (h *Hub) Create() (string, *game.Room) {
	h.mu.Lock()
	defer h.mu.Unlock()
	var code string
	for {
		code = generateCode()
		if _, exists := h.rooms[code]; !exists {
			break
		}
	}
	r := game.NewRoom(code, h.roomOpts(code)...)
	go r.Run()
	h.rooms[code] = r
	return code, r
}

// Lookup returns the room for a code, rehydrating it from the store if the
// registry has no live room but a snapshot exists.
func (h *Hub) Lookup(code string) (*game.Room, bool) {
	h.mu.RLock()
	r, ok := h.rooms[code]
	h.mu.RUnlock()
	if ok {
		return r, true
	}
	if h.store == nil {
		return nil, false
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	data, found, err := h.store.LoadSnapshot(ctx, code)
	if err != nil || !found {
		return nil, false
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	if existing, ok := h.rooms[code]; ok { // another goroutine restored it first
		return existing, true
	}
	restored, err := game.NewRoomFromSnapshot(code, data, h.roomOpts(code)...)
	if err != nil {
		return nil, false
	}
	go restored.Run()
	h.rooms[code] = restored
	return restored, true
}

// Delete stops and unregisters a room.
func (h *Hub) Delete(code string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r, ok := h.rooms[code]; ok {
		r.Stop()
		delete(h.rooms, code)
	}
}

// reap drops a self-terminated (empty) room and deletes its snapshot so Lookup
// won't rehydrate it. Called from the room goroutine via the injected reaper.
func (h *Hub) reap(code string) {
	h.mu.Lock()
	delete(h.rooms, code)
	h.mu.Unlock()
	if h.store == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := h.store.DeleteSnapshot(ctx, code); err != nil {
		log.Printf("hub reap %s: delete snapshot: %v", code, err)
	}
}

// StopAll stops every room. Used on graceful server shutdown.
func (h *Hub) StopAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for code, r := range h.rooms {
		r.Stop()
		delete(h.rooms, code)
	}
}
