// Package protocol defines the tagged {type,payload} envelope and the
// command (client→server) and event (server→client) message types.
package protocol

import "encoding/json"

type MsgType string

// Commands (client → server).
const (
	CmdJoin         MsgType = "join"
	CmdLeave        MsgType = "leave"
	CmdStart        MsgType = "start"
	CmdSubmitAnswer MsgType = "submitAnswer"
	CmdNextPhase    MsgType = "nextPhase"
)

// Events (server → client).
const (
	EvtState     MsgType = "state"
	EvtError     MsgType = "error"
	EvtGameEnded MsgType = "gameEnded"
)

// Envelope is the wire format for every message in both directions.
type Envelope struct {
	Type    MsgType         `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Command payloads.
type JoinPayload struct {
	Player string `json:"player"`
}
type SubmitAnswerPayload struct {
	Answer string `json:"answer"`
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
