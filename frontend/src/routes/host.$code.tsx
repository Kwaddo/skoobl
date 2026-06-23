import { createFileRoute, Navigate } from "@tanstack/react-router";
import { GameStage } from "@/components/game/GameStage";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { setFlash } from "@/lib/flash";
import { recallHostPlay } from "@/lib/identity";

export const Route = createFileRoute("/host/$code")({
  component: Host,
});

function Host() {
  const { code } = Route.useParams();
  const isMobile = useIsMobile();
  // A play-along host runs on the phone like any other player, so it's allowed
  // on mobile. The big-screen display host needs a real shared screen, so a
  // phone that lands on a big-screen host route (e.g. a scanned host link)
  // bounces back home with a note and the join tab ready.
  if (isMobile && !recallHostPlay()) {
    setFlash({
      message:
        "The big screen needs a bigger screen — join a match from your phone instead.",
      tab: "join",
    });
    return <Navigate to="/" />;
  }
  return <GameStage code={code} screen="host" />;
}
