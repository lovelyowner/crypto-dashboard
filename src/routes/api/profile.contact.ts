import { createFileRoute } from "@tanstack/react-router";
import { handleApiRequest } from "@/lib/api.server";

export const Route = createFileRoute("/api/profile/contact")({
  server: {
    handlers: {
      GET: ({ request }) => handleApiRequest(request),
      PUT: ({ request }) => handleApiRequest(request),
    },
  },
});
