// Package protocol defines the tagged {type,payload} envelope and the
// command (client→server) and event (server→client) message types.
package protocol

import "encoding/json"

type MsgType string

// Commands (client → server). These mirror the Socket.IO event names the
// realtime bridge listens for; the bridge dispatches them to game.Command.
const (
	CmdJoin          MsgType = "join"
	CmdConfigure     MsgType = "configure"
	CmdStart         MsgType = "start"
	CmdSubmitDrawing MsgType = "submitDrawing"
	CmdSubmitGuess   MsgType = "submitGuess"
	CmdNextPhase     MsgType = "nextPhase"
	CmdLeave         MsgType = "leave"
	CmdKick          MsgType = "kick"
)

// Events (server → client).
const (
	EvtState MsgType = "state"
	EvtError MsgType = "error"
)

// Envelope is the wire format for every message in both directions.
type Envelope struct {
	Type    MsgType         `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Command payloads.
type JoinPayload struct {
	Code string `json:"code"`
	Name string `json:"name"`
}
type SubmitGuessPayload struct {
	Artist string `json:"artist"`
}

// Event payloads.
type ErrorPayload struct {
	Message string `json:"message"`
}

// DecodeEnvelope parses raw bytes into an Envelope.
func DecodeEnvelope(b []byte) (Envelope, error) {
	var e Envelope
	err := json.Unmarshal(b, &e)
	return e, err
}

// EncodeEvent marshals a typed event into envelope bytes.
func EncodeEvent(t MsgType, payload any) ([]byte, error) {
	p, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Envelope{Type: t, Payload: p})
}
