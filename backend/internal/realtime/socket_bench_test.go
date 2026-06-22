package realtime

import (
	"testing"

	"skoobl/internal/game"
)

func BenchmarkEnvelope(b *testing.B) {
	s := game.GameState{Code: "ABCD", Players: make([]game.Player, 12)}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = envelope(s)
	}
}
