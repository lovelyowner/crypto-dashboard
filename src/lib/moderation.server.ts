import { auth, authConfigured, authIsProduction, authOrigin } from "./auth/server.js";
import { getSql } from "./db.js";
import { createModerationHandler } from "./moderation-handler.js";
import { createSqlModerationStore } from "./moderation-store.js";

export async function handleModerationRequest(request: Request): Promise<Response> {
  if (!authConfigured)
    return Response.json(
      { message: "Account moderation is not configured." },
      {
        status: 503,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  const origin = authOrigin;
  return createModerationHandler({
    configured: authConfigured,
    allowedOrigins: origin
      ? [origin]
      : authIsProduction
        ? []
        : ["http://localhost:8080", "http://127.0.0.1:8080"],
    reviewerIds: (process.env.MODERATION_REVIEWER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    getSession: (headers) => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
    store: createSqlModerationStore(await getSql()),
  })(request);
}
