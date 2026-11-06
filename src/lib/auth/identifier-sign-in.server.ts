import type { BetterAuthPlugin } from "better-auth";
import { isValidUsername, normalizeUsername } from "./policy.js";

const identifierPath = "/sign-in/identifier";
const maxBodyBytes = 8_192;
const invalidCredentials = {
  code: "INVALID_IDENTIFIER_OR_PASSWORD",
  message: "Incorrect email or username, or password.",
};
const credentialErrors = new Set([
  "INVALID_EMAIL_OR_PASSWORD",
  "INVALID_USERNAME_OR_PASSWORD",
  "INVALID_EMAIL",
  "INVALID_USERNAME",
  "USERNAME_TOO_SHORT",
  "USERNAME_TOO_LONG",
]);

function fail(status: number, code: string, message: string) {
  return { response: Response.json({ code, message }, { status }) };
}

async function bodyWithinLimit(request: Request): Promise<string | null> {
  const body = request.clone().body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  } finally {
    reader.releaseLock();
  }
}

/** Route one identifier to one native login after the shared sign-in rate limit runs. */
export function identifierSignIn(): BetterAuthPlugin {
  return {
    id: "fathom-identifier-sign-in",
    async onRequest(request, context) {
      const url = new URL(request.url);
      const basePath = new URL(context.baseURL).pathname.replace(/\/$/, "");
      if (
        request.method !== "POST" ||
        url.pathname.replace(/\/+$/, "") !== `${basePath}${identifierPath}`
      )
        return;

      const origin = request.headers.get("origin");
      const referer = request.headers.get("referer");
      const site = request.headers.get("sec-fetch-site")?.toLowerCase();
      const suppliedOrigin = origin ?? referer;
      if (
        site === "cross-site" ||
        (suppliedOrigin !== null &&
          (!suppliedOrigin ||
            suppliedOrigin === "null" ||
            !context.isTrustedOrigin(suppliedOrigin, { allowRelativePaths: false }))) ||
        (suppliedOrigin === null && (request.headers.has("cookie") || Boolean(site)))
      )
        return fail(403, "INVALID_ORIGIN", "Open this website directly to sign in.");
      if (
        request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
        "application/json"
      )
        return fail(415, "JSON_REQUIRED", "JSON is required.");

      let input: unknown;
      try {
        const raw = await bodyWithinLimit(request);
        if (raw === null) return fail(413, "BODY_TOO_LARGE", "Sign-in request is too large.");
        input = JSON.parse(raw);
      } catch {
        return fail(400, "INVALID_SIGN_IN", "Enter an email or username and password.");
      }
      if (!input || typeof input !== "object" || Array.isArray(input))
        return fail(400, "INVALID_SIGN_IN", "Enter an email or username and password.");
      const body = input as Record<string, unknown>;
      if (
        typeof body.identifier !== "string" ||
        !body.identifier ||
        body.identifier.length > 320 ||
        typeof body.password !== "string" ||
        !body.password ||
        body.password.length > 256 ||
        (body.rememberMe !== undefined && typeof body.rememberMe !== "boolean") ||
        (body.callbackURL !== undefined &&
          (typeof body.callbackURL !== "string" || body.callbackURL.length > 2_048))
      )
        return fail(400, "INVALID_SIGN_IN", "Enter an email or username and password.");

      const identifier = body.identifier.trim();
      if (!identifier)
        return fail(400, "INVALID_SIGN_IN", "Enter an email or username and password.");
      // The registered email namespace wins collisions. Never try another account after a bad password.
      const existingEmail = await context.internalAdapter.findUserByEmail(identifier);
      // Invalid username shapes can still be valid long emails; keep the native email dummy-hash path.
      const useEmail = Boolean(existingEmail) || !isValidUsername(identifier);
      const path = useEmail ? "/sign-in/email" : "/sign-in/username";
      if (context.options.disabledPaths?.includes(path))
        return fail(404, "NOT_FOUND", "Sign-in is unavailable.");
      const nativeBody = {
        ...(useEmail
          ? { email: existingEmail?.user.email ?? identifier }
          : { username: normalizeUsername(identifier) }),
        password: body.password,
        ...(body.rememberMe !== undefined ? { rememberMe: body.rememberMe } : {}),
        ...(body.callbackURL !== undefined ? { callbackURL: body.callbackURL } : {}),
      };
      url.pathname = `${basePath}${path}`;
      const headers = new Headers(request.headers);
      headers.set("content-type", "application/json");
      headers.delete("content-length");
      return {
        request: new Request(url, {
          method: "POST",
          headers,
          body: JSON.stringify(nativeBody),
          signal: request.signal,
        }),
      };
    },
  };
}

/** Do not expose whether an identifier resolved through the email or username namespace. */
export async function normalizeIdentifierSignInResponse(response: Response): Promise<Response> {
  if (![400, 401, 422].includes(response.status)) return response;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("code" in body) ||
    typeof body.code !== "string" ||
    !credentialErrors.has(body.code)
  )
    return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return Response.json(invalidCredentials, { status: 401, headers });
}
