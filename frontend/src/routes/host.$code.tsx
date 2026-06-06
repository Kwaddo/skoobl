import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useGameSocket } from "@/hooks/use-game-socket";
import { cmd } from "@/lib/protocol";
import { useGameStore } from "@/lib/store";

interface HostSearch {
  name: string;
}

export const Route = createFileRoute("/host/$code")({
  validateSearch: (search: Record<string, unknown>): HostSearch => ({
    name: typeof search.name === "string" ? search.name : "host",
  }),
  component: Host,
});

function Host() {
  const { code } = Route.useParams();
  const { name } = Route.useSearch();
  const { send } = useGameSocket(code, name);
  const phase = useGameStore((s) => s.phase);
  const players = useGameStore((s) => s.players);

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 p-8">
      <h1 className="text-2xl font-bold">Room {code}</h1>
      <p className="text-sm opacity-70">Phase: {phase}</p>
      <ul className="flex flex-col gap-1">
        {players.map((p) => (
          <li key={p.name} className="rounded bg-foreground/5 px-3 py-2">
            {p.name}
          </li>
        ))}
      </ul>
      {phase === "lobby" && (
        <Button onClick={() => send(cmd.start())}>Start</Button>
      )}
      {(phase === "inRound" || phase === "reveal") && (
        <Button onClick={() => send(cmd.nextPhase())}>Next</Button>
      )}
    </main>
  );
}
