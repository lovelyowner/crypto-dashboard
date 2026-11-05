import { createFileRoute } from "@tanstack/react-router";
import { handleApiRequest } from "@/lib/api.server";

export const Route = createFileRoute("/api/inbox/$id/reports")({
  server: { handlers: { POST: ({ request }) => handleApiRequest(request) } },
});
