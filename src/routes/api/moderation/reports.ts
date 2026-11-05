import { createFileRoute } from "@tanstack/react-router";
import { handleApiRequest } from "@/lib/api.server";

export const Route = createFileRoute("/api/moderation/reports")({
  server: { handlers: { GET: ({ request }) => handleApiRequest(request) } },
});
