package protocol

import (
	"encoding/json"
	"testing"
)

func TestDecodeCommand(t *testing.T) {
	raw := []byte(`{"type":"submitGuess","payload":{"artist":"alice"}}`)
	env, err := DecodeEnvelope(raw)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if env.Type != CmdSubmitGuess {
		t.Fatalf("type = %q, want %q", env.Type, CmdSubmitGuess)
	}
	var p SubmitGuessPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if p.Artist != "alice" {
		t.Fatalf("artist = %q, want alice", p.Artist)
	}
}

func TestEncodeEvent(t *testing.T) {
	b, err := EncodeEvent(EvtError, ErrorPayload{Message: "nope"})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	env, err := DecodeEnvelope(b)
	if err != nil {
		t.Fatalf("roundtrip decode: %v", err)
	}
	if env.Type != EvtError {
		t.Fatalf("type = %q, want %q", env.Type, EvtError)
	}
}
