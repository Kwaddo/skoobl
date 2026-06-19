import { createFileRoute } from "@tanstack/react-router";
import { GameStage } from "@/components/game/GameStage";

export const Route = createFileRoute("/play/$code")({
  component: Play,
});

function Play() {
  const { code } = Route.useParams();
  return <GameStage code={code} screen="player" />;
}
