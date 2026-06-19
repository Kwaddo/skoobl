import { createFileRoute } from "@tanstack/react-router";
import { GameStage } from "@/components/game/GameStage";

export const Route = createFileRoute("/host/$code")({
  component: Host,
});

function Host() {
  const { code } = Route.useParams();
  return <GameStage code={code} />;
}
