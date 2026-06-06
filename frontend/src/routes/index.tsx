import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const API = import.meta.env.VITE_API_BASE ?? "http://localhost:8080";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const navigate = useNavigate();

  const host = async () => {
    const res = await fetch(`${API}/games`, { method: "POST" });
    const data = (await res.json()) as { code: string };
    navigate({
      to: "/host/$code",
      params: { code: data.code },
      search: { name: name || "host" },
    });
  };

  const join = () =>
    navigate({ to: "/play/$code", params: { code }, search: { name } });

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-8">
      <h1 className="text-3xl font-bold">skoobl</h1>
      <Input
        placeholder="Your name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Button size="lg" onClick={host}>
        Host a game
      </Button>
      <div className="flex gap-2">
        <Input
          placeholder="Game code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <Button variant="outline" onClick={join}>
          Join
        </Button>
      </div>
    </main>
  );
}
