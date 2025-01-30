"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "@/hooks/use-toast"

interface JoinGameProps {
  onBack: () => void
}

interface GameState {
  players: string[]
  host: string
}

export default function JoinGame({ onBack }: JoinGameProps) {
  const [code, setCode] = useState("")
  const [playerName, setPlayerName] = useState("")
  const [gameState, setGameState] = useState<GameState>({ players: [], host: "" })
  const [ws, setWs] = useState<WebSocket | null>(null)
  const [isJoining, setIsJoining] = useState(false)
  const [hasJoined, setHasJoined] = useState(false)

  const handleJoinGame = async () => {
    if (isJoining) return
    if (!code || !playerName) {
      toast({
        title: "Error",
        description: "Please enter both game code and player name.",
        variant: "destructive",
      })
      return
    }

    setIsJoining(true)
    try {
      const res = await fetch(`http://localhost:8080/join-game?code=${code}&player=${playerName}`)

      if (res.ok) {
        const updatedPlayers = await res.json()
        if (updatedPlayers.includes(playerName)) {
          setHasJoined(true)
          connectWebSocket()
          toast({
            title: "Success",
            description: `You've successfully joined the game as ${playerName}!`,
          })
        } else {
          toast({
            title: "Error",
            description: "Failed to join the game. Please try again.",
            variant: "destructive",
          })
        }
      } else if (res.status === 409) {
        toast({
          title: "Error",
          description: "Player name already taken. Please choose a different name.",
          variant: "destructive",
        })
      } else {
        toast({
          title: "Error",
          description: "Game not found or closed.",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Error joining game:", error)
      toast({
        title: "Error",
        description: "An error occurred while joining the game.",
        variant: "destructive",
      })
    } finally {
      setIsJoining(false)
    }
  }

  const connectWebSocket = () => {
    const websocket = new WebSocket(`ws://localhost:8080/ws?code=${code}&player=${playerName}`)

    websocket.onmessage = (event) => {
      const data = JSON.parse(event.data)

      if (data.type === "game-ended") {
        handleGameClosed("The host has ended the game.")
        return
      }

      setGameState(data)
      if (!data.players.includes(playerName)) {
        handleGameClosed("You have been disconnected from the game.")
      }
    }

    websocket.onerror = (event) => {
      console.error("WebSocket error:", event)
      toast({
        title: "Error",
        description: "WebSocket connection error",
        variant: "destructive",
      })
    }

    setWs(websocket)
  }

  const handleGameClosed = (message: string) => {
    toast({
      title: "Game Closed",
      description: message,
      variant: "destructive",
    })
    setGameState({ players: [], host: "" })
    setHasJoined(false)
    if (ws) {
      ws.close()
    }
    onBack()
  }

  useEffect(() => {
    return () => {
      if (ws) {
        ws.close()
      }
    }
  }, [ws])

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold">Join an Existing Game</h2>
      {!hasJoined ? (
        <>
          <Input type="text" placeholder="Enter Game Code" value={code} onChange={(e) => setCode(e.target.value)} />
          <Input
            type="text"
            placeholder="Enter Your Name"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
          />
          <Button onClick={handleJoinGame} disabled={isJoining}>
            {isJoining ? "Joining..." : "Join Game"}
          </Button>
        </>
      ) : (
        <p className="text-lg font-medium text-green-600">You have joined as {playerName}!</p>
      )}

      {gameState.players.length > 0 && (
        <div>
          <h3 className="text-xl mt-4 mb-2">Players:</h3>
          <ul className="list-disc list-inside">
            {gameState.players.map((player, index) => (
              <li key={index}>
                {player}
                {player === gameState.host ? " (Host)" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Button variant="outline" onClick={onBack}>
        Back
      </Button>
    </div>
  )
}
