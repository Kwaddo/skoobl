import type { Powerup } from "@/lib/protocol";

// EffectLayer wraps content and renders Frenzy perception effects over it: blur
// (squint) and 180° flip (topsy-turvy) as transforms on the content; fog and
// curtain as pointer-transparent overlays (so input still passes through — the
// victim draws/guesses "blind"); and lights-out as a fully opaque, input-eating
// blackout (the victim can neither see nor do anything until it clears) that
// jolts the box as it slams in. Cramp, shuffle and hidenames are input/data
// effects handled by consumers, not here. Effects now arrive per-player on
// staggered timers, so several of these can be live across the room at once while
// any given box shows whatever its owner happened to roll.
export function EffectLayer({
  effects,
  children,
  className,
}: {
  effects: Set<Powerup>;
  children: React.ReactNode;
  className?: string;
}) {
  const blur = effects.has("squint");
  const flip = effects.has("flip");
  const lights = effects.has("lights");
  return (
    <div
      className={`relative overflow-hidden ${lights ? "effect-shake" : ""} ${
        className ?? "h-full w-full"
      }`}
    >
      <div
        className={`h-full w-full transition-all duration-200 ${
          blur ? "blur-md" : ""
        } ${flip ? "rotate-180" : ""}`}
      >
        {children}
      </div>
      {effects.has("fog") && (
        <div
          data-effect="fog"
          className="pointer-events-none absolute inset-0 animate-pulse bg-white/70 backdrop-blur-md"
        />
      )}
      {effects.has("lights") && (
        // Opaque + input-eating (no pointer-events-none): the victim sees nothing
        // and every tap/drag is swallowed here, so they truly can't act for the
        // effect's duration. touch-none also kills mobile scroll/draw gestures.
        <div
          data-effect="lights"
          className="absolute inset-0 touch-none cursor-not-allowed select-none bg-black"
        />
      )}
      {effects.has("curtain") && (
        <div
          data-effect="curtain"
          className="pointer-events-none absolute inset-0 bg-foreground/90"
        />
      )}
    </div>
  );
}
