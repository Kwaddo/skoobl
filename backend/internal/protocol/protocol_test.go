package protocol

import (
	"encoding/json"
	"testing"
)

func TestDecodeCommand(t *testing.T) {
	raw := []byte(`{"type":"submitAnswer","payload":{"answer":"banana"}}`)
	env, err := DecodeEnvelope(raw)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if env.Type != CmdSubmitAnswer {
		t.Fatalf("type = %q, want %q", env.Type, CmdSubmitAnswer)
	}
	var p SubmitAnswerPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if p.Answer != "banana" {
		t.Fatalf("answer = %q, want banana", p.Answer)
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
