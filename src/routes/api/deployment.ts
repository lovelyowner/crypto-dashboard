import { createFileRoute } from "@tanstack/react-router";
import { handleDeploymentStatusRequest } from "@/lib/deployment-status";

export const Route = createFileRoute("/api/deployment")({
  server: {
    handlers: { GET: ({ request }) => handleDeploymentStatusRequest(request) },
  },
});
