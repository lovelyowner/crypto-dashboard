import { isFreshAccountSession } from "./policy.js";
import {
  auth,
  authConfigured,
  authIsProduction,
  authOrigin,
  publicAuthConfiguration,
} from "./server.js";

export async function handleAuthRequest(request: Request) {
  if (request.method === "GET" && new URL(request.url).pathname === "/api/auth/config")
    return Response.json(publicAuthConfiguration());
  if (!authConfigured)
    return Response.json(
      {
        code: "ACCOUNT_SETUP_REQUIRED",
        message:
          "Authentication requires BETTER_AUTH_SECRET, BETTER_AUTH_URL (HTTPS), and DATABASE_URL in production.",
      },
      { status: 503 },
    );
  if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/link-social") {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user.emailVerified)
      return Response.json(
        { message: "Verify your email before linking a social account." },
        { status: 403 },
      );
  }
  if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/add-password") {
    const configuredOrigin = authOrigin ?? "http://localhost:8080";
    const origin = request.headers.get("origin");
    if (origin !== configuredOrigin && !(!authIsProduction && origin === "http://127.0.0.1:8080"))
      return Response.json({ message: "Invalid origin" }, { status: 403 });
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return Response.json({ message: "JSON required" }, { status: 415 });
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user.emailVerified)
      return Response.json(
        { message: "Verify your email before adding a password." },
        { status: 403 },
      );
    if (!isFreshAccountSession(session.session.createdAt))
      return Response.json({ message: "Sign in again before adding a password." }, { status: 403 });
    try {
      const body = await request.json();
      return await auth.api.setPassword({
        headers: request.headers,
        body: { newPassword: body.newPassword },
        asResponse: true,
      });
    } catch {
      return Response.json(
        {
          message:
            "Could not add password. Sign in again, use 12–256 characters, and confirm no password is already set.",
        },
        { status: 400 },
      );
    }
  }
  return auth.handler(request);
}
