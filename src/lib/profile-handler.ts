import { validateCreatorProfile, type CreatorProfile } from "./creator-profile";

export const MAX_PROFILE_BODY_BYTES = 128 * 1024;

export interface StoredCreatorProfile {
  profile: unknown;
  updatedAt: Date | string;
}

export interface ProfileStore {
  read(userId: string): Promise<StoredCreatorProfile | null>;
  write(userId: string, profile: CreatorProfile): Promise<StoredCreatorProfile>;
}

export interface ProfileSession {
  user: { id: string };
  session: { userId: string; expiresAt: Date | string };
}

export interface ProfileResponse {
  profile: CreatorProfile | null;
  updatedAt: string | null;
}

export interface ProfileHandlerDependencies {
  configured: boolean;
  allowedOrigins: readonly string[];
  getSession(headers: Headers): Promise<ProfileSession | null>;
  store: ProfileStore;
  now?: () => number;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const responseHeaders = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie, Origin",
  "X-Content-Type-Options": "nosniff",
};

function respond(
  body: ProfileResponse | { message: string },
  status = 200,
  extraHeaders?: HeadersInit,
) {
  const headers = new Headers(responseHeaders);
  new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return Response.json(body, { status, headers });
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_PROFILE_BODY_BYTES
  )
    throw new RequestError(413, "Profile request is too large.");
  if (!request.body) throw new RequestError(400, "A JSON profile is required.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_PROFILE_BODY_BYTES) {
        // Cancel without waiting on the sender's cleanup: a hostile stream's
        // cancel promise must not keep an oversized request running.
        void reader.cancel().catch(() => undefined);
        throw new RequestError(413, "Profile request is too large.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new RequestError(400, "A valid JSON profile is required.");
  }
}

function profileFromEnvelope(input: unknown): CreatorProfile {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new RequestError(400, "Send a JSON object containing only the profile field.");
  const fields = Object.keys(input);
  if (fields.length !== 1 || fields[0] !== "profile")
    throw new RequestError(400, "Send a JSON object containing only the profile field.");
  try {
    return validateCreatorProfile((input as { profile: unknown }).profile);
  } catch {
    throw new RequestError(400, "Profile is invalid. Check the profile fields and public links.");
  }
}

function publicResponse(record: StoredCreatorProfile | null): ProfileResponse {
  if (!record) return { profile: null, updatedAt: null };
  // Revalidate persisted JSON as well as request input. Only the explicitly
  // supported public profile fields can ever leave the storage boundary.
  const profile = validateCreatorProfile(record.profile);
  const updatedAt = new Date(record.updatedAt);
  if (!Number.isFinite(updatedAt.getTime())) throw new Error("Invalid profile timestamp");
  return { profile, updatedAt: updatedAt.toISOString() };
}

/** Account drafts stay private: every storage operation uses the session owner. */
export function createProfileHandler(dependencies: ProfileHandlerDependencies) {
  const allowedOrigins = new Set(dependencies.allowedOrigins.map(originOf).filter(Boolean));
  return async function handleProfileRequest(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "PUT")
      return respond({ message: "Method not allowed." }, 405, { Allow: "GET, PUT" });
    if (!dependencies.configured)
      return respond({ message: "Account profile storage is not configured." }, 503);

    try {
      if (request.method === "PUT") {
        const origin = request.headers.get("origin");
        // Requiring Origin protects cookie sessions even when browsers omit
        // fetch metadata. Compare against configured origins, never Host or
        // forwarded headers supplied by the request.
        if (
          !origin ||
          !allowedOrigins.has(origin) ||
          request.headers.get("sec-fetch-site") === "cross-site"
        )
          throw new RequestError(403, "This profile request must come from this app.");
        const contentType = request.headers
          .get("content-type")
          ?.split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (contentType !== "application/json")
          throw new RequestError(415, "Use application/json to save a profile.");
      }

      const session = await dependencies.getSession(request.headers);
      if (
        !session?.user.id ||
        session.session.userId !== session.user.id ||
        !(new Date(session.session.expiresAt).getTime() > (dependencies.now?.() ?? Date.now()))
      )
        throw new RequestError(401, "Sign in to access your account profile.");

      const record =
        request.method === "GET"
          ? await dependencies.store.read(session.user.id)
          : await dependencies.store.write(
              session.user.id,
              profileFromEnvelope(await readBoundedJson(request)),
            );
      return respond(publicResponse(record));
    } catch (error) {
      if (error instanceof RequestError) return respond({ message: error.message }, error.status);
      return respond(
        { message: "Your account profile could not be loaded or saved. Please retry." },
        500,
      );
    }
  };
}
