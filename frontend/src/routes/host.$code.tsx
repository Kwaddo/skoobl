import { createFileRoute, Navigate } from "@tanstack/react-router";
import { GameStage } from "@/components/game/GameStage";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { setFlash } from "@/lib/flash";

export const Route = createFileRoute("/host/$code")({
  component: Host,
});

function Host() {
  const { code } = Route.useParams();
  const isMobile = useIsMobile();
  // The host is the shared big screen. A phone (e.g. a scanned host link) can't
  // run it, so bounce back home with a note and the join tab ready.
  if (isMobile) {
    setFlash({
      message:
        "Hosting needs a bigger screen, join a match from your phone instead.",
      tab: "join",
    });
    return <Navigate to="/" />;
  }
  return <GameStage code={code} screen="host" />;
}
