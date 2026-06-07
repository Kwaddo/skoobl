package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"skoobl/internal/hub"
	"skoobl/internal/realtime"
	"skoobl/internal/router"
	"skoobl/internal/store"
)

func main() {
	// Container healthcheck: exec the same binary with -healthcheck. Works in a
	// distroless image with no shell or curl.
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		resp, err := http.Get("http://127.0.0.1:8080/healthz")
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}

	var (
		h           *hub.Hub
		redisClient *redis.Client
	)
	if addr := os.Getenv("REDIS_ADDR"); addr != "" {
		redisClient = redis.NewClient(&redis.Options{Addr: addr})
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := redisClient.Ping(ctx).Err(); err != nil {
			cancel()
			log.Fatalf("redis ping %s: %v", addr, err)
		}
		cancel()
		ttl := snapshotTTL()
		h = hub.New(hub.WithStore(store.NewRedisStore(redisClient, ttl)))
		log.Printf("redis persistence enabled at %s (ttl %s)", addr, ttl)
	} else {
		h = hub.New()
		log.Print("redis not configured; running in-memory")
	}

	io := realtime.NewServer(h)

	srv := &http.Server{
		Addr:    ":8080",
		Handler: router.New(h, io),
	}

	go func() {
		log.Printf("listening on %s", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
	h.StopAll()
	io.Close(nil)
	if redisClient != nil {
		if err := redisClient.Close(); err != nil {
			log.Printf("redis close failed: %v", err)
		}
	}
	log.Println("server stopped")
}

// snapshotTTL reads SNAPSHOT_TTL (Go duration), defaulting to 1h.
func snapshotTTL() time.Duration {
	if v := os.Getenv("SNAPSHOT_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		log.Printf("invalid SNAPSHOT_TTL %q; using 1h", v)
	}
	return time.Hour
}
