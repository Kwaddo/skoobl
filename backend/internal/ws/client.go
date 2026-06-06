// Package ws bridges coder/websocket connections to a game room: it parses
// incoming commands into room Commands and writes broadcast state back out.
package ws

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/coder/websocket"

	"skoobl/internal/game"
	"skoobl/internal/protocol"
)

// serve runs the read and write pumps for one connection until it closes.
func serve(ctx context.Context, conn *websocket.Conn, room *game.Room, code string) {
	updates := make(chan game.GameState, 16)
	done := make(chan struct{})
	var player string

	// Write pump: drain state updates to the socket. We never close updates —
	// the room owns the send side and keeps a reference to it as a subscriber
	// (its broadcast does a non-blocking send, so an undrained channel is
	// safe). The pump stops on done (read pump returned) or write failure.
	go func() {
		for {
			select {
			case <-done:
				return
			case s := <-updates:
				b, err := protocol.EncodeEvent(protocol.EvtState, s)
				if err != nil {
					continue
				}
				wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
				err = conn.Write(wctx, websocket.MessageText, b)
				cancel()
				if err != nil {
					return
				}
			}
		}
	}()

	// Read pump: parse commands; first join registers the subscriber channel.
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			break
		}
		env, err := protocol.DecodeEnvelope(data)
		if err != nil {
			writeError(ctx, conn, "malformed message")
			continue
		}
		cmd, name, ok := toCommand(env, updates, &player)
		if !ok {
			writeError(ctx, conn, "unknown or invalid command")
			continue
		}
		if name != "" {
			player = name
		}
		room.Submit(cmd)
	}

	// Disconnect: tell the room the player left, then unsubscribe this
	// connection's updates channel so the room stops referencing it, and only
	// then stop the write pump. After the unsubscribe is processed the room no
	// longer broadcasts to updates, so it's safe to abandon. updates is
	// deliberately not closed: the room would otherwise still send on it.
	if player != "" {
		room.Submit(game.Command{Kind: game.CmdLeave, Player: player})
	}
	room.Submit(game.Command{Kind: game.CmdUnsubscribe, Unsub: updates})
	close(done)
}

// toCommand maps a protocol envelope to a room Command. On a join it attaches
// the per-client subscribe channel. Returns ok=false for unknown commands.
func toCommand(env protocol.Envelope, sub chan game.GameState, player *string) (game.Command, string, bool) {
	switch env.Type {
	case protocol.CmdJoin:
		var p protocol.JoinPayload
		if json.Unmarshal(env.Payload, &p) != nil || p.Player == "" {
			return game.Command{}, "", false
		}
		return game.Command{Kind: game.CmdJoin, Player: p.Player, Subscribe: sub}, p.Player, true
	case protocol.CmdStart:
		return game.Command{Kind: game.CmdStart, Player: *player}, "", true
	case protocol.CmdNextPhase:
		return game.Command{Kind: game.CmdNextPhase, Player: *player}, "", true
	case protocol.CmdSubmitAnswer:
		var p protocol.SubmitAnswerPayload
		if json.Unmarshal(env.Payload, &p) != nil {
			return game.Command{}, "", false
		}
		return game.Command{Kind: game.CmdSubmitAnswer, Player: *player, Answer: p.Answer}, "", true
	default:
		return game.Command{}, "", false
	}
}

func writeError(ctx context.Context, conn *websocket.Conn, msg string) {
	b, err := protocol.EncodeEvent(protocol.EvtError, protocol.ErrorPayload{Message: msg})
	if err != nil {
		return
	}
	if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
		log.Printf("ws write error: %v", err)
	}
}
