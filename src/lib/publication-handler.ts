import type { CreatorProfile } from "./creator-profile.js";
import { isReservedRootHandle } from "./profile-url.js";
import type { ProfileSession } from "./profile-handler.js";
import {
  PublicationConflictError,
  normalizePublicHandle,
  validatePublication,
  validatePublicCreatorProfile,
  validatePublishableProfile,
  type ProfilePublication,
} from "./public-profile.js";

export interface StoredPublication {
  handle: string;
  profile: unknown;
  updatedAt: Date | string;
  published: boolean;
}
export interface PublicationStore {
  read(userId: string): Promise<StoredPublication | null>;
  readPublic(handle: string): Promise<StoredPublication | null>;
  publish(userId: string, handle: string, profile: CreatorProfile): Promise<StoredPublication>;
  unpublish(userId: string): Promise<StoredPublication | null>;
}
export interface PublicationHandlerDependencies {
  configured: boolean;
  allowedOrigins: readonly string[];
  getSession(headers: Headers): Promise<ProfileSession | null>;
  store: PublicationStore;
  now?: () => number;
}

export const MAX_PUBLICATION_BODY_BYTES = 128 * 1024;
class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function respond(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return Response.json(body, { status, headers });
}
function allowedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
async function publishBody(request: Request): Promise<{ handle: string; profile: CreatorProfile }> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_PUBLICATION_BODY_BYTES))
    throw new RequestError(413, "Profile publication is too large.");
  if (!request.body) throw new RequestError(400, "Send a public handle and profile.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PUBLICATION_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new RequestError(413, "Profile publication is too large.");
      }
      chunks.push(value);
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
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestError(400, "Send a valid JSON public handle and profile.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError(400, "Send only the handle and profile fields.");
  const body = value as Record<string, unknown>;
  const fields = Object.keys(body);
  if (fields.length !== 2 || !Object.hasOwn(body, "handle") || !Object.hasOwn(body, "profile"))
    throw new RequestError(400, "Send only the handle and profile fields.");
  try {
    return {
      handle: normalizePublicHandle(body.handle),
      profile: validatePublishableProfile(body.profile),
    };
  } catch (error) {
    throw new RequestError(
      400,
      error instanceof Error ? error.message : "The public profile is invalid.",
    );
  }
}
function publicationResponse(record: StoredPublication | null): {
  publication: ProfilePublication | null;
} {
  if (!record) return { publication: null };
  return {
    publication: validatePublication({
      ...record,
      updatedAt: new Date(record.updatedAt).toISOString(),
    }),
  };
}

/** Publishing is explicit and separate from saving a private account or local draft. */
export function createPublicationHandlers(dependencies: PublicationHandlerDependencies) {
  const origins = new Set(dependencies.allowedOrigins.map(allowedOrigin).filter(Boolean));
  async function handlePublicationRequest(request: Request): Promise<Response> {
    const privateHeaders = { Vary: "Cookie, Origin" };
    const reply = (body: unknown, status = 200, extraHeaders?: HeadersInit) => {
      const headers = new Headers(privateHeaders);
      new Headers(extraHeaders).forEach((value, name) => headers.set(name, value));
      return respond(body, status, headers);
    };
    if (!["GET", "PUT", "DELETE"].includes(request.method))
      return reply({ message: "Method not allowed." }, 405, { Allow: "GET, PUT, DELETE" });
    if (!dependencies.configured)
      return reply({ message: "Public profile publishing is not configured." }, 503);
    try {
      if (request.method !== "GET") {
        const origin = request.headers.get("origin");
        if (
          !origin ||
          !origins.has(origin) ||
          request.headers.get("sec-fetch-site") === "cross-site"
        )
          throw new RequestError(403, "Publish or unpublish from this app.");
        if (
          request.method === "PUT" &&
          request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
            "application/json"
        )
          throw new RequestError(415, "Use application/json to publish a profile.");
      }
      const session = await dependencies.getSession(request.headers);
      if (
        !session?.user.id ||
        session.session.userId !== session.user.id ||
        !(new Date(session.session.expiresAt).getTime() > (dependencies.now?.() ?? Date.now()))
      )
        throw new RequestError(401, "Sign in to manage your public profile.");
      let record: StoredPublication | null;
      if (request.method === "GET") record = await dependencies.store.read(session.user.id);
      else if (request.method === "DELETE")
        record = await dependencies.store.unpublish(session.user.id);
      else {
        const body = await publishBody(request);
        if (
          isReservedRootHandle(body.handle) &&
          (await dependencies.store.read(session.user.id))?.handle !== body.handle
        )
          throw new RequestError(
            400,
            "This ID is reserved for an application page. Choose another public ID.",
          );
        record = await dependencies.store.publish(session.user.id, body.handle, body.profile);
      }
      return reply(publicationResponse(record));
    } catch (error) {
      if (error instanceof RequestError) return reply({ message: error.message }, error.status);
      if (error instanceof PublicationConflictError)
        return reply(
          {
            message:
              "This handle is already claimed, or differs from your account’s existing handle. Public handles cannot be changed.",
          },
          409,
        );
      return reply(
        { message: "Your public profile could not be loaded or changed. Please retry." },
        500,
      );
    }
  }
  async function handlePublicProfileRequest(request: Request): Promise<Response> {
    if (request.method !== "GET")
      return respond({ message: "Method not allowed." }, 405, { Allow: "GET" });
    if (!dependencies.configured)
      return respond({ message: "Public profiles are not configured." }, 503);
    let handle: string;
    try {
      const match = /^\/api\/public-profiles\/([^/]+)\/?$/.exec(new URL(request.url).pathname);
      if (!match) throw new Error("Invalid public profile path");
      handle = normalizePublicHandle(decodeURIComponent(match[1]));
    } catch {
      return respond({ message: "Public profile not found." }, 404);
    }
    try {
      const record = await dependencies.store.readPublic(handle);
      if (!record || record.published !== true)
        return respond({ message: "Public profile not found." }, 404);
      const value = validatePublicCreatorProfile({
        ...record,
        updatedAt: new Date(record.updatedAt).toISOString(),
      });
      if (value.handle !== handle) throw new Error("Mismatched profile handle");
      return respond(value);
    } catch {
      return respond({ message: "The public profile could not be loaded. Please retry." }, 500);
    }
  }
  return { handlePublicationRequest, handlePublicProfileRequest };
}
