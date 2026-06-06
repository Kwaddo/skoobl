package store

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newTestStore(t *testing.T) *RedisStore {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	return NewRedisStore(client, time.Hour)
}

func TestSnapshotRoundTrip(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	if err := s.SaveSnapshot(ctx, "abc123", []byte(`{"phase":"lobby"}`)); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, ok, err := s.LoadSnapshot(ctx, "abc123")
	if err != nil || !ok {
		t.Fatalf("load: ok=%v err=%v", ok, err)
	}
	if string(got) != `{"phase":"lobby"}` {
		t.Fatalf("snapshot = %s", got)
	}
}

func TestLoadMissingSnapshot(t *testing.T) {
	s := newTestStore(t)
	if _, ok, err := s.LoadSnapshot(context.Background(), "missing"); ok || err != nil {
		t.Fatalf("expected (false,nil) for missing, got ok=%v err=%v", ok, err)
	}
}
