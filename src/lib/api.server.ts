import { handleAuthRequest } from "./auth/handler.js";
import { handleProfileRequest } from "./profile.server.js";
import { handleContactRequest } from "./contact.server.js";
import { handlePaymentRequest } from "./payments.server.js";
import { handleModerationRequest } from "./moderation.server.js";
import { handlePublicationRequest, handlePublicProfileRequest } from "./publication.server.js";
import { handleDeploymentStatusRequest } from "./deployment-status.js";
import { handleAccountExportRequest } from "./account-export.server.js";
import { handleConversationExportRequest } from "./conversation-export.server.js";

/** Shared same-origin API for the Node server and Vercel functions. */
export async function handleApiRequest(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  let response: Response;
  if (pathname === "/api/deployment") response = handleDeploymentStatusRequest(request);
  else if (pathname === "/api/account/export") response = await handleAccountExportRequest(request);
  else if (pathname === "/api/account/messages-export")
    response = await handleConversationExportRequest(request);
  else if (
    pathname === "/api/profile/contact" ||
    pathname === "/api/inbox" ||
    pathname.startsWith("/api/inbox/") ||
    /^\/api\/creators\/[^/]+\/(?:contact|messages)$/.test(pathname)
  )
    response = await handleContactRequest(request);
  else if (
    pathname === "/api/profile/payments" ||
    pathname === "/api/payments" ||
    pathname.startsWith("/api/payments/")
  )
    response = await handlePaymentRequest(request);
  else if (pathname === "/api/moderation" || pathname.startsWith("/api/moderation/"))
    response = await handleModerationRequest(request);
  else if (pathname === "/api/profile/publication")
    response = await handlePublicationRequest(request);
  else if (pathname.startsWith("/api/public-profiles/"))
    response = await handlePublicProfileRequest(request);
  else if (pathname === "/api/profile") response = await handleProfileRequest(request);
  else if (pathname.startsWith("/api/auth/")) response = await handleAuthRequest(request);
  else response = Response.json({ message: "API route not found." }, { status: 404 });
  // User-specific drafts, setup and session responses must never be cached by a CDN.
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}
