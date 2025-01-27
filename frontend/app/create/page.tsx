'use client'

import { useState, useEffect } from 'react';

export default function Create() {
  const [gameCode, setGameCode] = useState<string>('');
  const [players, setPlayers] = useState<string[]>([]); // State to hold the players list
  const [ws, setWs] = useState<WebSocket | null>(null); // WebSocket connection

  // Function to create the game and generate a game code
  const handleCreateGame = async () => {
    try {
      const res = await fetch('http://localhost:8080/create-game');
      const data = await res.text();
      const code = data.split(': ')[1]; // Get the game code from the response
      setGameCode(code); // Set the game code state
      setPlayers([]); // Reset players list when creating a new game

      // Connect to WebSocket server
      const websocket = new WebSocket(`ws://localhost:8080/ws?code=${code}`);

      // Handle incoming messages from WebSocket (list of players)
      websocket.onmessage = (event) => {
        const updatedPlayers = JSON.parse(event.data);
        setPlayers(updatedPlayers); // Update the players list in the frontend
      };

      // Handle any WebSocket errors
      websocket.onerror = (event) => {
        console.error('WebSocket error:', event);
      };

      // Store the WebSocket connection
      setWs(websocket);
    } catch (error) {
      console.error('Error creating game:', error);
    }
  };

  // Clean up WebSocket connection when the component is unmounted
  useEffect(() => {
    return () => {
      if (ws) {
        ws.close(); // Close the WebSocket connection
      }
    };
  }, [ws]);

  return (
    <div>
      <h1>Create a New Game</h1>
      <button onClick={handleCreateGame}>Create Game</button>

      {gameCode && (
        <div>
          <p>Game Code: {gameCode}</p>
          <p>Share this code with others to join the game!</p>

          <h2>Players:</h2>
          <ul>
            {players.map((player, index) => (
              <li key={index}>{player}</li> // List each player
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
