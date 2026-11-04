import { createFileRoute } from "@tanstack/react-router";
import { handleApiRequest } from "@/lib/api.server";

export const Route = createFileRoute("/api/payments/nowpayments/webhook/$credentialId")({
  server: {
    handlers: {
      POST: ({ request }) => handleApiRequest(request),
    },
  },
});
