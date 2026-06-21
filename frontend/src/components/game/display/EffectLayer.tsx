import type { Powerup } from "@/lib/protocol";

// EffectLayer wraps content and renders Frenzy perception effects over it: blur
// (squint) and 180° flip (topsy-turvy) as transforms on the content, and fog /
// lights-out / curtain as pointer-transparent overlays (so input still passes
// through — the victim draws/guesses "blind"). Cramp and shuffle are input/data
// effects handled by consumers, not here.
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
  return (
    <div className={`relative overflow-hidden ${className ?? "h-full w-full"}`}>
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
        <div
          data-effect="lights"
          className="pointer-events-none absolute inset-0 bg-black/85"
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
