// app/page.tsx
'use client'

import Link from 'next/link';

export default function Home() {
  return (
    <div style={{ textAlign: 'center', padding: '50px' }}>
      <h1>Welcome to the Jackbox Clone</h1>
      <p>Start or join a game</p>
      <div>
        <Link href="/create">
          <button style={{ margin: '10px', padding: '10px 20px', fontSize: '16px' }}>
            Create a New Game
          </button>
        </Link>
        <Link href="/join">
          <button style={{ margin: '10px', padding: '10px 20px', fontSize: '16px' }}>
            Join an Existing Game
          </button>
        </Link>
      </div>
    </div>
  );
}
