import { useNavigate } from "@tanstack/react-router";
import { Alert } from "../icons";

// ErrorPanel is the full-screen error fallback (bad room, server unreachable).
export function ErrorPanel({ message }: { message: string }) {
  const navigate = useNavigate();
  return (
    <main className="grain-above mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="card-arcade rise flex flex-col items-center gap-4 p-8">
        <Alert className="h-12 w-12 text-foreground" />
        <h1 className="font-display text-2xl font-bold">{message}</h1>
        <button
          type="button"
          className="btn-key px-6 py-3"
          onClick={() => navigate({ to: "/" })}
        >
          Back to start
        </button>
      </div>
    </main>
  );
}
