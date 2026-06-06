package game

// Phase is the room's lifecycle stage.
type Phase string

const (
	PhaseLobby   Phase = "lobby"
	PhaseInRound Phase = "inRound"
	PhaseReveal  Phase = "reveal"
	PhaseEnded   Phase = "ended"
)

// Player is one participant.
type Player struct {
	Name   string `json:"name"`
	Answer string `json:"answer,omitempty"`
}

// GameState is the full, serializable room state broadcast to clients.
type GameState struct {
	Code    string   `json:"code"`
	Phase   Phase    `json:"phase"`
	Host    string   `json:"host"`
	Players []Player `json:"players"`
}

func newGameState(code string) GameState {
	return GameState{Code: code, Phase: PhaseLobby, Players: []Player{}}
}

func (g *GameState) playerIndex(name string) int {
	for i, p := range g.Players {
		if p.Name == name {
			return i
		}
	}
	return -1
}
