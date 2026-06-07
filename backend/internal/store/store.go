// Package store persists room snapshots to Redis and provides per-room
// pub/sub so multiple server instances can share state.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisStore implements snapshot persistence and pub/sub over Redis.
type RedisStore struct {
	client *redis.Client
	ttl    time.Duration
}

func NewRedisStore(client *redis.Client, ttl time.Duration) *RedisStore {
	return &RedisStore{client: client, ttl: ttl}
}

func snapshotKey(code string) string { return "room:" + code }
func roomChannel(code string) string { return "room-events:" + code }

// SaveSnapshot stores serialized room state with the configured TTL.
func (s *RedisStore) SaveSnapshot(ctx context.Context, code string, data []byte) error {
	return s.client.Set(ctx, snapshotKey(code), data, s.ttl).Err()
}

// LoadSnapshot returns stored state. ok is false when no snapshot exists.
func (s *RedisStore) LoadSnapshot(ctx context.Context, code string) (data []byte, ok bool, err error) {
	b, err := s.client.Get(ctx, snapshotKey(code)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}

// DeleteSnapshot removes a room's stored state (used when a room is reaped so it
// won't be rehydrated on a later Lookup).
func (s *RedisStore) DeleteSnapshot(ctx context.Context, code string) error {
	return s.client.Del(ctx, snapshotKey(code)).Err()
}

// Publish broadcasts an event to other instances watching this room.
func (s *RedisStore) Publish(ctx context.Context, code string, data []byte) error {
	return s.client.Publish(ctx, roomChannel(code), data).Err()
}

// Subscribe returns a go-redis subscription for a room's channel.
func (s *RedisStore) Subscribe(ctx context.Context, code string) *redis.PubSub {
	return s.client.Subscribe(ctx, roomChannel(code))
}
