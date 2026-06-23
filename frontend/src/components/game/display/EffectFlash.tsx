import { useEffect, useRef, useState } from "react";
import type { Powerup } from "@/lib/protocol";

// The shout each effect throws up the instant it strikes. Frenzy hits land at
// staggered, unpredictable moments, so this flash is the "what just happened?!"
// punctuation that tells the victim they've been got.
const LABELS: Record<Powerup, string> = {
  fog: "fogged!",
  flip: "flipped!",
  lights: "lights out!",
  cramp: "cramp!",
  squint: "blurred!",
  curtain: "curtains!",
  shuffle: "shuffled!",
  hidenames: "names gone!",
};

// The harsh hits (you literally can't act) slam in red and shake; the rest are a
// lighter ink jolt.
const HARSH = new Set<Powerup>(["lights", "cramp"]);

// EffectFlash watches the set of currently-active effects and, the moment a new
// one strikes, throws a big animated label across the screen for a beat. It's a
// fire-and-forget overlay: it renders nothing until a strike, animates, clears.
export function EffectFlash({ effects }: { effects: Set<Powerup> }) {
  const [flash, setFlash] = useState<{ kind: Powerup; id: number } | null>(null);
  const prevRef = useRef<Set<Powerup>>(new Set());
  const idRef = useRef(0);
  // A stable primitive key so the strike-detection effect only runs when the set
  // of active kinds actually changes (not on every sub-second clock tick).
  const key = [...effects].sort().join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `key` (the sorted kinds); `effects` identity is stable across ticks
  useEffect(() => {
    const prev = prevRef.current;
    let struck: Powerup | null = null;
    for (const k of effects) {
      if (!prev.has(k)) struck = k; // last newly-added kind wins the shout
    }
    prevRef.current = new Set(effects);
    if (struck) {
      idRef.current += 1;
      setFlash({ kind: struck, id: idRef.current });
    }
  }, [key]);

  // Auto-clear so the label is a flash, not a banner. Keyed on the flash id so a
  // back-to-back strike restarts the timer (and re-runs the animation).
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 1100);
    return () => window.clearTimeout(t);
  }, [flash]);

  if (!flash) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center"
    >
      <span
        key={flash.id}
        className={`effect-flash font-display font-black uppercase tracking-tight ${
          HARSH.has(flash.kind) ? "effect-flash--harsh" : ""
        }`}
      >
        {LABELS[flash.kind]}
      </span>
    </div>
  );
}
