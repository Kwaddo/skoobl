import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGameSocket } from "@/hooks/use-game-socket";
import { cmd } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";

interface PlaySearch {
  name: string;
}

export const Route = createFileRoute("/play/$code")({
  validateSearch: (search: Record<string, unknown>): PlaySearch => ({
    name: typeof search.name === "string" ? search.name : "player",
  }),
  component: Play,
});

function Play() {
  const { code } = Route.useParams();
  const { name } = Route.useSearch();
  const { send } = useGameSocket(code, name);
  const phase = useGameStore((s) => s.phase);
  const error = useGameStore((s) => s.error);
  const [answer, setAnswer] = useState("");

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-8">
      <h1 className="text-xl font-bold">{name}</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <p className="text-sm opacity-70">Phase: {phase}</p>
      {phase === "inRound" && (
        <div className="flex gap-2">
          <Input
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Answer"
          />
          <Button onClick={() => send(cmd.submitAnswer(answer))}>Submit</Button>
        </div>
      )}
      {phase === "lobby" && <p>Waiting for host to start…</p>}
    </main>
  );
}
