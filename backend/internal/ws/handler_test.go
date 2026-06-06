package ws

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"skoobl/internal/hub"
	"skoobl/internal/protocol"
)

func TestWebSocketJoinBroadcastsState(t *testing.T) {
	h := hub.New()
	code, _ := h.Create()

	srv := httptest.NewServer(Handler(h, nil))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?code=" + code

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	join, _ := protocol.EncodeEvent(protocol.CmdJoin, protocol.JoinPayload{Player: "alice"})
	if err := conn.Write(ctx, websocket.MessageText, join); err != nil {
		t.Fatalf("write join: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		env, err := protocol.DecodeEnvelope(data)
		if err != nil || env.Type != protocol.EvtState {
			continue
		}
		if strings.Contains(string(env.Payload), `"host":"alice"`) {
			return // success
		}
	}
	t.Fatal("did not receive state with host=alice")
}

func TestWebSocketRejectsDisallowedOriginWhenRestricted(t *testing.T) {
	h := hub.New()
	code, _ := h.Create()

	// Only example.com is allowed; the dial sets a different Origin.
	srv := httptest.NewServer(Handler(h, []string{"example.com"}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?code=" + code

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: map[string][]string{"Origin": {"http://evil.test"}},
	})
	if err == nil {
		t.Fatal("dial with disallowed origin succeeded, want rejection")
	}
}
