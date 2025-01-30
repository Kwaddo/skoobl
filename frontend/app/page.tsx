"use client"

import { useState } from "react"
import CreateGame from "@/components/create-game"
import JoinGame from "@/components/join-game"
import { Button } from "@/components/ui/button"

export default function Home() {
  const [activeComponent, setActiveComponent] = useState<"create" | "join" | null>(null)

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
      <h1 className="text-4xl font-bold mb-8">Welcome to Skoobl!</h1>
      {activeComponent === null ? (
        <div className="space-x-4">
          <Button onClick={() => setActiveComponent("create")}>Create a New Game</Button>
          <Button onClick={() => setActiveComponent("join")}>Join an Existing Game</Button>
        </div>
      ) : activeComponent === "create" ? (
        <CreateGame onBack={() => setActiveComponent(null)} />
      ) : (
        <JoinGame onBack={() => setActiveComponent(null)} />
      )}
    </div>
  )
}
