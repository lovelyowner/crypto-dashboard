import { handleAuthRequest } from "./auth/handler";
import { handleProfileRequest } from "./profile.server";
import { handlePublicationRequest, handlePublicProfileRequest } from "./publication.server";

/** Shared same-origin API for the Node server and Vercel functions. */
export async function handleApiRequest(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  let response: Response;
  if (pathname === "/api/profile/publication") response = await handlePublicationRequest(request);
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
