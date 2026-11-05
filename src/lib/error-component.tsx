import type { ErrorComponentProps } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import "./error-component.css";

const FALLBACK_MESSAGE = "An unexpected error occurred. Try reloading the page.";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return FALLBACK_MESSAGE;
}

export function AppErrorComponent({ error }: ErrorComponentProps) {
  return (
    <main className="app-error">
      <span className="app-error-symbol" aria-hidden="true">
        <TriangleAlert strokeWidth={2} />
      </span>
      <h1>Something went wrong</h1>
      <p>{errorMessage(error)}</p>
    </main>
  );
}
