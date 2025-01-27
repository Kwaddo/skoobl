// app/join/page.tsx
'use client'

import { useState } from 'react';

export default function Join() {
  const [code, setCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [players, setPlayers] = useState<string[]>([]);
  const [message, setMessage] = useState('');

  const handleJoinGame = async () => {
    // Send request to join the game
    const res = await fetch(`http://localhost:8080/join-game?code=${code}&player=${playerName}`);

    if (res.ok) {
      // If joining is successful, fetch the updated list of players
      const updatedPlayers = await res.json();
      setPlayers(updatedPlayers);
      setMessage(`Successfully joined game with code: ${code}`);
    } else {
      setMessage('Game not found.');
    }
  };

  return (
    <div>
      <h1>Join an Existing Game</h1>
      <input
        type="text"
        placeholder="Enter Game Code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <input
        type="text"
        placeholder="Enter Your Name"
        value={playerName}
        onChange={(e) => setPlayerName(e.target.value)}
      />
      <button onClick={handleJoinGame}>Join Game</button>
      {message && <p>{message}</p>}

      {players.length > 0 && (
        <div>
          <h2>Players:</h2>
          <ul>
            {players.map((player, index) => (
              <li key={index}>{player}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
