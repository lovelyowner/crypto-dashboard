import { createFileRoute } from "@tanstack/react-router";
import { handlePublicAuthConfigurationRequest } from "@/lib/auth/public-settings.server";

export const Route = createFileRoute("/api/auth/config")({
  server: {
    handlers: { GET: ({ request }) => handlePublicAuthConfigurationRequest(request) },
  },
});
