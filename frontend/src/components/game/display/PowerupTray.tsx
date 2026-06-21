import { useEffect, useRef } from "react";
import type { GameActions } from "@/hooks/use-game-socket";
import type { Powerup } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";

// Human labels + emoji for each powerup, used on the tray buttons and toasts.
const META: Record<Powerup, { label: string; icon: string }> = {
  fog: { label: "Fog", icon: "🌫️" },
  lights: { label: "Lights-Out", icon: "🌑" },
  flip: { label: "Topsy-Turvy", icon: "🙃" },
  cramp: { label: "Cramp", icon: "✋" },
  squint: { label: "Squint", icon: "😵" },
  curtain: { label: "Curtain", icon: "🎭" },
  shuffle: { label: "Shuffle", icon: "🔀" },
};

// PowerupTray is the Frenzy fire UI: a row of held powerups. Tapping one fires it
// at a random rival (the server chooses). It also surfaces a transient toast when
// an effect lands on this player ("Bob fogged you!").
export function PowerupTray({ actions }: { actions: GameActions }) {
  const powerups = useGameStore((s) => s.yourPowerups);
  const effects = useGameStore((s) => s.yourEffects);
  const pushNotice = useGameStore((s) => s.pushNotice);
  const seen = useRef(0);

  // Announce newly-arrived incoming effects once each.
  useEffect(() => {
    if (effects.length > seen.current) {
      for (const e of effects.slice(seen.current)) {
        pushNotice(`${e.from} hit you with ${META[e.kind].label}!`);
      }
    }
    seen.current = effects.length;
  }, [effects, pushNotice]);

  if (powerups.length === 0) {
    return (
      <div className="flex shrink-0 items-center justify-center gap-2 font-hand text-lg text-muted">
        no powerups yet — hang tight…
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-2">
      {powerups.map((p, i) => (
        <button
          // index-keyed: duplicates of the same powerup are distinct slots
          key={`${p}-${i}`}
          type="button"
          aria-label={`fire ${META[p].label}`}
          title={`Fire ${META[p].label} at a random rival`}
          onClick={() => actions.firePowerup(p)}
          className="card-arcade card-hover card-press pop flex items-center gap-1.5 px-3 py-2 text-sm font-bold"
        >
          <span aria-hidden>{META[p].icon}</span>
          {META[p].label}
        </button>
      ))}
    </div>
  );
}
