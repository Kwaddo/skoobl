package game

import (
	"context"
	"encoding/json"
	"log"
	"time"
)

func (r *Room) addSub(name string, ch chan GameState) {
	if ch != nil {
		r.subs = append(r.subs, subscriber{name: name, ch: ch})
	}
}

// ack sends the join outcome on c.Ack if present (buffered, never blocks).
func ack(c Command, msg string) {
	if c.Ack != nil {
		c.Ack <- msg
	}
}

// unsubscribe removes ch from the subscriber set by channel identity. Runs in
// the room goroutine, so r.subs is touched by nothing else and stays race-free.
func (r *Room) unsubscribe(ch chan GameState) {
	if ch == nil {
		return
	}
	for i, s := range r.subs {
		if s.ch == ch {
			r.subs = append(r.subs[:i], r.subs[i+1:]...)
			return
		}
	}
}

// broadcast hands each subscriber its own redacted view of the state.
func (r *Room) broadcast() {
	for _, s := range r.subs {
		view := r.state.viewFor(s.name, r.present)
		if r.kicked != "" && s.name == r.kicked {
			view.Kicked = true
		}
		select {
		case s.ch <- view:
		default: // drop for a slow/closed subscriber rather than block the room
		}
	}
}

// unsubscribeByName drops every subscriber registered under name (mirrors
// unsubscribe, which drops by channel identity). Runs in the room goroutine, so
// r.subs is touched by nothing else and stays race-free.
func (r *Room) unsubscribeByName(name string) {
	kept := r.subs[:0]
	for _, s := range r.subs {
		if s.name != name {
			kept = append(kept, s)
		}
	}
	r.subs = kept
}

// persist writes the current state to the Snapshotter. Nil-safe; save errors
// are logged but never take the room down.
func (r *Room) persist() {
	if r.snap == nil {
		return
	}
	data, err := json.Marshal(r.state)
	if err != nil {
		log.Printf("room %s marshal snapshot: %v", r.state.Code, err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := r.snap.SaveSnapshot(ctx, r.state.Code, data); err != nil {
		log.Printf("room %s save snapshot: %v", r.state.Code, err)
	}
}
