"use client"

import { useEffect, useState } from "react";

type ApiResponse = {
  message: string;
};

export default function Home() {
  const [data, setData] = useState<ApiResponse | null>(null);

  useEffect(() => {
    fetch("/api/hello")
      .then((response) => response.json())
      .then((data: ApiResponse) => setData(data)); 
  }, []);

  return (
    <div>
      <h1>Next.js Frontend</h1>
      <p>{data ? data.message : "Loading..."}</p>
    </div>
  );
}
