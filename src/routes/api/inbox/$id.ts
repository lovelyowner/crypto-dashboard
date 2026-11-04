import { createFileRoute } from "@tanstack/react-router";
import { handleApiRequest } from "@/lib/api.server";

export const Route = createFileRoute("/api/inbox/$id")({
  server: {
    handlers: {
      GET: ({ request }) => handleApiRequest(request),
      PATCH: ({ request }) => handleApiRequest(request),
    },
  },
});
