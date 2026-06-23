package game

import (
	"testing"
	"time"
)

func TestFirstWaveDelayFloored(t *testing.T) {
	// 0.12 * 80000ms = 9.6s, above the floor.
	if got := firstWaveDelay(80_000); got != 9600*time.Millisecond {
		t.Errorf("firstWaveDelay(80000) = %v, want 9.6s", got)
	}
	// 0.12 * 10000ms = 1.2s, below the 4s floor.
	if got := firstWaveDelay(10_000); got != minWaveGap {
		t.Errorf("firstWaveDelay(10000) = %v, want floor %v", got, minWaveGap)
	}
}

func TestWaveGapTightensWithProgress(t *testing.T) {
	early := waveGap(0.0, 80_000) // 0.28 * 80s = 22.4s
	late := waveGap(1.0, 80_000)  // 0.10 * 80s = 8s
	if !(early > late) {
		t.Fatalf("gap must tighten: early=%v late=%v", early, late)
	}
	if early != 22400*time.Millisecond {
		t.Errorf("waveGap(0,80000) = %v, want 22.4s", early)
	}
	if late != 8*time.Second {
		t.Errorf("waveGap(1,80000) = %v, want 8s", late)
	}
}

func TestWaveGapFloored(t *testing.T) {
	// 0.10 * 20000ms = 2s, below the 4s floor.
	if got := waveGap(1.0, 20_000); got != minWaveGap {
		t.Errorf("waveGap(1,20000) = %v, want floor %v", got, minWaveGap)
	}
}

func TestWaveEffectDurationFloored(t *testing.T) {
	// 0.9 * 8s = 7.2s, above the floor.
	if got := waveEffectDuration(8 * time.Second); got != 7200*time.Millisecond {
		t.Errorf("waveEffectDuration(8s) = %v, want 7.2s", got)
	}
	// 0.9 * 2s = 1.8s, below the 2.5s floor.
	if got := waveEffectDuration(2 * time.Second); got != minEffectDur {
		t.Errorf("waveEffectDuration(2s) = %v, want floor", got)
	}
}

func TestPhaseProgress(t *testing.T) {
	r := syncRoom(t, "alice", "bob", "carol", "dave")
	r.state.Phase = PhaseDrawing
	r.state.DrawMs = 80_000
	// Half the phase remains → progress ~0.5.
	r.state.PhaseEndsAt = time.Now().Add(40 * time.Second).UnixMilli()
	if p := r.phaseProgress(); p < 0.45 || p > 0.55 {
		t.Fatalf("phaseProgress = %v, want ~0.5", p)
	}
	// Outside a timed play phase → 0.
	r.state.Phase = PhaseReveal
	if p := r.phaseProgress(); p != 0 {
		t.Fatalf("phaseProgress(reveal) = %v, want 0", p)
	}
}
