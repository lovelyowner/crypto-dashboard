import type { ContactSession } from "./contact-handler.js";
import { REPORT_REASONS, type ReportReason, type ReportStatus } from "./moderation.js";
import type { ModerationStore } from "./moderation-store.js";

export interface ModerationHandlerDependencies {
  configured: boolean;
  allowedOrigins: readonly string[];
  reviewerIds: readonly string[];
  getSession(headers: Headers): Promise<ContactSession | null>;
  store: ModerationStore;
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
function respond(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie, Origin",
      ...(status === 429 ? { "Retry-After": "60" } : {}),
    },
  });
}
async function body(request: Request, keys: string[]): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 8192))
    throw new RequestError(413, "The request is too large.");
  if (!request.body) throw new RequestError(400, "Send a JSON object.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) {
        void reader.cancel().catch(() => undefined);
        throw new RequestError(413, "The request is too large.");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new RequestError(400, "Send valid JSON.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw new RequestError(400, "Send only the supported request fields.");
  return value as Record<string, unknown>;
}
function id(value: string) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new RequestError(404, "Item not found.");
  return value;
}
export function createModerationHandler(deps: ModerationHandlerDependencies) {
  const origins = new Set(deps.allowedOrigins.map((o) => new URL(o).origin));
  const reviewers = new Set(deps.reviewerIds);
  return async (request: Request): Promise<Response> => {
    if (!deps.configured) return respond({ message: "Account moderation is not configured." }, 503);
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const thread = /^\/api\/inbox\/([^/]+)\/(moderation|reports)$/.exec(path);
      const review = /^\/api\/moderation\/reports\/([^/]+)$/.exec(path);
      const access = path === "/api/moderation/access";
      const queue = path === "/api/moderation/reports";
      if (!thread && !review && !access && !queue)
        throw new RequestError(404, "Moderation route not found.");
      const methods = thread
        ? thread[2] === "moderation"
          ? ["GET", "PUT"]
          : ["POST"]
        : review
          ? ["PATCH"]
          : ["GET"];
      if (!methods.includes(request.method)) throw new RequestError(405, "Method not allowed.");
      if (request.method !== "GET") {
        if (
          !origins.has(request.headers.get("origin") ?? "") ||
          request.headers.get("sec-fetch-site") === "cross-site"
        )
          throw new RequestError(403, "Make moderation changes from this app.");
        if (
          request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
          "application/json"
        )
          throw new RequestError(415, "Use application/json.");
      }
      const account = await deps.getSession(request.headers);
      if (
        !account?.user.id ||
        account.user.id !== account.session.userId ||
        new Date(account.session.expiresAt).getTime() <= (deps.now?.() ?? Date.now()) ||
        !Number.isFinite(new Date(account.session.expiresAt).getTime())
      )
        throw new RequestError(401, "Sign in to use moderation controls.");
      const userId = account.user.id;
      const canReview = reviewers.has(userId);
      if (access) return respond({ canReview });
      if (queue || review) {
        if (!canReview) throw new RequestError(403, "Review access is required.");
        if (!(await deps.store.consumeLimit(`review:${userId}`, 120, 60)))
          throw new RequestError(429, "Too many requests. Please wait a minute.");
        if (queue) {
          const status = url.searchParams.get("status") ?? "open";
          if (!["open", "reviewed", "dismissed"].includes(status))
            throw new RequestError(400, "Choose a supported report status.");
          return respond({ reports: await deps.store.listReports(status as ReportStatus) });
        }
        const input = await body(request, ["status"]);
        if (input.status !== "reviewed" && input.status !== "dismissed")
          throw new RequestError(400, "Choose reviewed or dismissed.");
        if (!(await deps.store.review(userId, id(review![1]), input.status)))
          throw new RequestError(404, "Report not found.");
        return respond({ updated: true });
      }
      const messageId = id(thread![1]);
      const state = await deps.store.state(userId, messageId);
      if (!state) throw new RequestError(404, "Message not found.");
      if (request.method === "GET") return respond(state);
      if (thread![2] === "moderation") {
        const input = await body(request, ["blocked"]);
        if (typeof input.blocked !== "boolean")
          throw new RequestError(400, "Send blocked as a boolean.");
        if (!state.canBlock)
          throw new RequestError(403, "This note has no account identity to block.");
        if (!(await deps.store.consumeLimit(`block:${userId}`, 30, 60)))
          throw new RequestError(429, "Too many changes. Please wait a minute.");
        if (!(await deps.store.setBlocked(userId, messageId, input.blocked)))
          throw new RequestError(404, "Message not found.");
        return respond(await deps.store.state(userId, messageId));
      }
      const input = await body(request, ["reason", "details"]);
      if (
        !REPORT_REASONS.includes(input.reason as ReportReason) ||
        typeof input.details !== "string" ||
        [...input.details].length > 1000 ||
        [...input.details].some((character) => {
          const code = character.codePointAt(0)!;
          return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
        })
      )
        throw new RequestError(
          400,
          "Choose a report reason and use up to 1000 characters of details.",
        );
      if (!state.canReport) throw new RequestError(403, "This conversation cannot be reported.");
      if (!state.reported) {
        if (!(await deps.store.consumeLimit(`report:${userId}`, 10, 3600)))
          throw new RequestError(429, "The report limit was reached. Please try again later.");
        if (
          !(await deps.store.report(
            userId,
            messageId,
            input.reason as ReportReason,
            input.details.trim(),
          ))
        )
          throw new RequestError(404, "Message not found.");
      }
      return respond({ reported: true });
    } catch (error) {
      if (error instanceof RequestError) return respond({ message: error.message }, error.status);
      return respond(
        { message: "Moderation controls could not be loaded or changed. Please retry." },
        503,
      );
    }
  };
}
