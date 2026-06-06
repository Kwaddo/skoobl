// Package hub maintains the registry of active game rooms.
package hub

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"skoobl/internal/game"
)

// Store is the persistence the hub needs to restore rooms after a restart.
// Satisfied by store.RedisStore.
type Store interface {
	SaveSnapshot(ctx context.Context, code string, data []byte) error
	LoadSnapshot(ctx context.Context, code string) (data []byte, ok bool, err error)
}

// Option configures a Hub.
type Option func(*Hub)

// WithStore enables Redis-backed persistence and restore-on-miss.
func WithStore(s Store) Option { return func(h *Hub) { h.store = s } }

// Hub owns the code→Room map. Lookups are read-mostly; the only
// read-modify-write paths (create/delete) are guarded by a mutex.
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]*game.Room
	store Store
}

func New(opts ...Option) *Hub {
	h := &Hub{rooms: make(map[string]*game.Room)}
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
	var r *game.Room
	if h.store != nil {
		r = game.NewRoomWithStore(code, h.store)
	} else {
		r = game.NewRoom(code)
	}
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
	restored, err := game.NewRoomFromSnapshot(code, data, h.store)
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
