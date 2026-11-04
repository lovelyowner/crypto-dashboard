import { createFileRoute } from "@tanstack/react-router";
import { handleApiRequest } from "@/lib/api.server";

export const Route = createFileRoute("/api/payments/$id/verify")({
  server: {
    handlers: {
      POST: ({ request }) => handleApiRequest(request),
    },
  },
});
