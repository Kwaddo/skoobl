package game

import (
	"testing"
	"time"
)

func TestFirstWaveDelayFloored(t *testing.T) {
	// 0.06 * 80000ms = 4.8s, between the floor and the cap.
	if got := firstWaveDelay(80_000); got != 4800*time.Millisecond {
		t.Errorf("firstWaveDelay(80000) = %v, want 4.8s", got)
	}
	// 0.06 * 10000ms = 0.6s, below the floor.
	if got := firstWaveDelay(10_000); got != minWaveGap {
		t.Errorf("firstWaveDelay(10000) = %v, want floor %v", got, minWaveGap)
	}
}

func TestFirstWaveDelayCapped(t *testing.T) {
	// 0.06 * 180000ms = 10.8s, above the cap — a long phase must still open fast.
	if got := firstWaveDelay(180_000); got != maxFirstWave {
		t.Errorf("firstWaveDelay(180000) = %v, want cap %v", got, maxFirstWave)
	}
}

func TestWaveGapTightensWithProgress(t *testing.T) {
	// 0.17 * 80s = 13.6s (above the cap → maxWaveGap); 0.06 * 80s = 4.8s.
	early := waveGap(0.0, 80_000)
	late := waveGap(1.0, 80_000)
	if !(early > late) {
		t.Fatalf("gap must tighten: early=%v late=%v", early, late)
	}
	if early != maxWaveGap {
		t.Errorf("waveGap(0,80000) = %v, want cap %v", early, maxWaveGap)
	}
	if late != 4800*time.Millisecond {
		t.Errorf("waveGap(1,80000) = %v, want 4.8s", late)
	}
}

func TestWaveGapFloored(t *testing.T) {
	// 0.06 * 20000ms = 1.2s, below the floor.
	if got := waveGap(1.0, 20_000); got != minWaveGap {
		t.Errorf("waveGap(1,20000) = %v, want floor %v", got, minWaveGap)
	}
}

func TestWaveGapCapped(t *testing.T) {
	// 0.17 * 180s = 30.6s, far above the cap — long phases must not go sparse.
	if got := waveGap(0.0, 180_000); got != maxWaveGap {
		t.Errorf("waveGap(0,180000) = %v, want cap %v", got, maxWaveGap)
	}
}

func TestNextWaveGapWithinJitterBand(t *testing.T) {
	// The live gap scatters around the smooth baseline by ±waveJitterFrac, never
	// below the floor and never beyond the upper jitter bound.
	const durMs = 80_000
	base := waveGap(0.5, durMs)
	upper := time.Duration(float64(base) * (1 + waveJitterFrac))
	for i := 0; i < 500; i++ {
		got := nextWaveGap(0.5, durMs)
		if got < minWaveGap {
			t.Fatalf("nextWaveGap = %v, below floor %v", got, minWaveGap)
		}
		if got > upper {
			t.Fatalf("nextWaveGap = %v, above jitter ceiling %v", got, upper)
		}
	}
}

func TestEffectLifetimeBands(t *testing.T) {
	for i := 0; i < 200; i++ {
		d := effectLifetime(PhaseDrawing, 80_000)
		if d < drawEffectMinMs*time.Millisecond || d > drawEffectMaxMs*time.Millisecond {
			t.Fatalf("draw lifetime %v outside band [%dms,%dms]", d, drawEffectMinMs, drawEffectMaxMs)
		}
		// Guessing flashes are short and scale with the vote; they must stay well
		// under the full vote length.
		g := effectLifetime(PhaseGuessing, 25_000)
		if g <= 0 || g > 5*time.Second {
			t.Fatalf("guess flash %v out of expected range", g)
		}
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
