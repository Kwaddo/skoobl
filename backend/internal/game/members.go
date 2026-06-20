package game

import (
	"time"
	"unicode/utf8"
)

func (r *Room) join(c Command) {
	if c.Spectator {
		r.joinSpectator(c)
		return
	}
	name := c.Player
	if r.state.Phase == PhaseEnded {
		ack(c, "This game has already ended.")
		return
	}
	if utf8.RuneCountInString(name) > maxNameLen {
		ack(c, "That name is too long.")
		return
	}
	if name == r.state.Host {
		ack(c, "That name's already taken in this room.")
		return
	}
	if p, ok := r.present[name]; ok {
		if p.connected {
			ack(c, "That name's already taken in this room.")
			return
		}
		// Reconnect: same name returning while marked disconnected.
		p.connected = true
		p.gen++ // invalidate the pending prune
		r.addSub(name, c.Subscribe)
		ack(c, "")
		return
	}
	if len(r.state.Players) >= maxPlayers {
		ack(c, "This room is full.")
		return
	}
	r.state.Players = append(r.state.Players, Player{Name: name})
	r.present[name] = &presence{connected: true}
	r.addSub(name, c.Subscribe)
	r.cancelEmptyTimer()
	ack(c, "")
}

// joinSpectator wires up the single host display: it claims the room's Host role
// and subscribes for broadcasts, but is never added to Players — so it never
// draws, guesses, scores, or counts toward minPlayers. A connected host with a
// different name is rejected; the same name returning while disconnected
// reconnects.
func (r *Room) joinSpectator(c Command) {
	name := c.Player
	if r.state.Phase == PhaseEnded {
		ack(c, "This game has already ended.")
		return
	}
	if utf8.RuneCountInString(name) > maxNameLen {
		ack(c, "That name is too long.")
		return
	}
	if r.state.playerIndex(name) >= 0 {
		ack(c, "That name's already taken in this room.")
		return
	}
	if r.state.Host != "" && r.state.Host != name {
		ack(c, "This room already has a host.")
		return
	}
	if r.hostConnected() { // same name, but a host is already live (duplicate tab)
		ack(c, "This room already has a host.")
		return
	}
	if r.host == nil {
		r.host = &presence{}
	}
	r.state.Host = name
	r.host.connected = true
	r.host.gen++ // invalidate any pending host prune
	r.addSub(name, c.Subscribe)
	r.cancelEmptyTimer()
	ack(c, "")
}

func (r *Room) disconnect(c Command) {
	r.unsubscribe(c.Unsub)
	if r.host != nil && c.Player == r.state.Host {
		if !r.host.connected {
			return
		}
		r.host.connected = false
		r.host.gen++
		r.armHostPrune(r.host.gen)
		return
	}
	p, ok := r.present[c.Player]
	if !ok || !p.connected {
		return
	}
	p.connected = false
	p.gen++
	r.armPrune(c.Player, p.gen)
}

// armHostPrune schedules a reap if the host display doesn't return within grace.
// The host is required (it is the shared screen and holds all manual-advance
// authority), so losing it ends the game. A captured gen makes a returned host
// cancel the timer.
func (r *Room) armHostPrune(gen int) {
	time.AfterFunc(r.grace, func() {
		r.Submit(Command{Kind: CmdHostPrune, Gen: gen})
	})
}

func (r *Room) prune(c Command) {
	p, ok := r.present[c.Player]
	if !ok || p.connected || p.gen != c.Gen {
		return // reconnected, already gone, or a stale timer
	}
	r.removePlayer(c.Player)
}

// leave removes a participant immediately at their own request (the Leave
// button), skipping the disconnect grace. A host leaving closes the shared
// screen and ends the game; a player leaving reaps an emptied room.
func (r *Room) leave(c Command) {
	r.unsubscribe(c.Unsub)
	if r.host != nil && c.Player == r.state.Host {
		r.closeRoom()
		return
	}
	if _, ok := r.present[c.Player]; !ok {
		return // never present, or already gone
	}
	r.removePlayer(c.Player)
}

// closeRoom tears the room down when the host departs. It sends a final frame
// flagged Closed to the remaining players first — the room is the shared screen
// and holds all advance authority, so without it nothing can continue — then
// reaps. Run skips its post-handle broadcast once reaped, so this is the players'
// last frame and the cue for their clients to return to the main menu.
func (r *Room) closeRoom() {
	r.state.Closed = true
	r.broadcast()
	r.reap()
}

// removePlayer drops a player from presence and the roster, reaps a room that
// has no players and no connected host, bounces a now-undersized game back to
// the lobby, and otherwise lets a departure complete the current phase for those
// who remain. The host is a spectator (never in Players), so there is no host
// promotion here. Called only from leave and prune — i.e. on a real departure,
// never on a transient disconnect — so a refresh can't trigger the bounce.
func (r *Room) removePlayer(name string) {
	delete(r.present, name)
	if i := r.state.playerIndex(name); i >= 0 {
		r.state.Players = append(r.state.Players[:i], r.state.Players[i+1:]...)
	}
	if len(r.state.Players) == 0 && !r.hostConnected() {
		r.reap()
		return
	}
	// A real departure that drops a running game below the minimum abandons the
	// round: there aren't enough players for "who drew this?" to work, so send
	// everyone back to the lobby (scores reset) rather than limp on under-strength.
	if r.state.Phase.inGame() && len(r.state.Players) < minPlayers {
		r.returnToLobby()
		return
	}
	switch r.state.Phase {
	case PhaseDrawing:
		if r.allLocked() {
			r.beginGuessing()
		}
	case PhaseGuessing:
		if r.allGuessed() {
			r.beginReveal()
		}
	}
}

// reap shuts the room down: tell the hub to drop it, then stop the loop.
func (r *Room) reap() {
	if r.onReap != nil {
		r.onReap()
	}
	r.Stop()
}

func (r *Room) connectedCount() int {
	n := 0
	for _, p := range r.present {
		if p.connected {
			n++
		}
	}
	return n
}

// hostConnected reports whether the host display is currently attached.
func (r *Room) hostConnected() bool { return r.host != nil && r.host.connected }
