"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { toast } from "@/hooks/use-toast"

interface CreateGameProps {
    onBack: () => void
}

interface GameState {
    players: string[]
    host: string
}

export default function CreateGame({ onBack }: CreateGameProps) {
    const [gameCode, setGameCode] = useState<string>("")
    const [gameState, setGameState] = useState<GameState>({ players: [], host: "" })
    const [ws, setWs] = useState<WebSocket | null>(null)

    // 🔹 Create Game & WebSocket Connection
    const handleCreateGame = async () => {
        try {
            const res = await fetch("http://localhost:8080/create-game")
            const data = await res.text()
            const code = data.split(": ")[1]
            setGameCode(code)

            const websocket = new WebSocket(`ws://localhost:8080/ws?code=${code}&isHost=true`)
            setWs(websocket)

            toast({
                title: "Success",
                description: `Game created with code: ${code}`,
            })
        } catch (error) {
            console.error("Error creating game:", error)
            toast({
                title: "Error",
                description: "Failed to create game",
                variant: "destructive",
            })
        }
    }

    useEffect(() => {
        if (!ws) return

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data)

            if (data.type === "game-ended") {
                toast({ title: "Game Over", description: "The host has ended the game." })
                ws.close()
                setGameCode("")
                setGameState({ players: [], host: "" })
                setWs(null)
                return
            }

            setGameState(data)
        }

        ws.onerror = (event) => {
            console.error("WebSocket error:", event)
            toast({
                title: "Error",
                description: "WebSocket connection error",
                variant: "destructive",
            })
        }

        return () => {
            ws.close()
        }
    }, [ws])

    const handleBack = async () => {
        if (gameCode) {
            await fetch(`http://localhost:8080/delete-game?code=${gameCode}`, { method: "DELETE" })
        }

        if (ws) ws.close()
        setGameCode("")
        setGameState({ players: [], host: "" })
        setWs(null)

        onBack()
    }

    return (
        <div className="space-y-4">
            <h2 className="text-2xl font-semibold">Create a New Game</h2>
            {!gameCode && <Button onClick={handleCreateGame}>Create Game</Button>}

            {gameCode && (
                <div className="mt-4">
                    <p className="text-lg">
                        Game Code: <span className="font-bold">{gameCode}</span>
                    </p>
                    <p>Share this code with others to join the game!</p>

                    <h3 className="text-xl mt-4 mb-2">
                        Players: <span className="font-normal">({gameState.players.length})</span>
                    </h3>
                    <ul className="list-disc list-inside">
                        {gameState.players.map((player, index) => (
                            <li key={index}>
                                {player}
                                {player === gameState.host.split("-")[1] ? " (Host)" : ""}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            <Button variant="outline" onClick={handleBack}>
                End Game
            </Button>
        </div>
    )
}
