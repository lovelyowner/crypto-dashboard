import { isFreshAccountSession } from "./auth/policy.js";
import {
  validateContactText,
  type ContactKind,
  type ContactPaymentStatus,
} from "./creator-contact.js";

export const CONVERSATION_EXPORT_LIMITS = Object.freeze({
  conversations: 500,
  replies: 5_000,
  bytes: 2 * 1024 * 1024,
});

export const CONVERSATION_EXPORT_OMITTED = [
  "Payment records and proofs",
  "Moderation and authentication secrets",
  "Browser-local wallets and watchlists",
  "Anonymous sent notes without account inbox ownership",
] as const;

export type ExportedConversationReply = {
  id: string;
  text: string;
  createdAt: string;
  fromCreator: boolean;
};
export type ExportedConversation = {
  id: string;
  kind: ContactKind;
  text: string;
  anonymous: boolean;
  senderName: string;
  recipientHandle: string;
  createdAt: string;
  paymentStatus: ContactPaymentStatus;
  direction: "received" | "sent";
  readAt: string | null;
  lastActivityAt: string;
  replies: ExportedConversationReply[];
};
export type ConversationExportSelection = {
  createdFrom: string | null;
  createdThrough: string | null;
  timeZone: "UTC";
};
type ConversationArchiveContents = {
  complete: true;
  exportedAt: string;
  counts: { conversations: number; replies: number };
  conversations: ExportedConversation[];
  omitted: string[];
};
export type ConversationArchive = ConversationArchiveContents &
  (
    | { version: 1; scope: "accessible-conversations" }
    | {
        version: 2;
        scope: "filtered-accessible-conversations";
        selection: ConversationExportSelection;
      }
  );
export type ConversationExportSnapshot = {
  exportedAt: Date | string;
  counts: { conversations: number; replies: number };
  conversations: unknown[] | null;
  overflow: boolean;
};
type ExportSession = {
  user: { id: string };
  session: { userId: string; createdAt: Date | string; expiresAt: Date | string };
};
type Dependencies = {
  configured: boolean;
  getSession: (headers: Headers) => Promise<ExportSession | null>;
  readSnapshot: (
    userId: string,
    selection?: ConversationExportSelection,
  ) => Promise<ConversationExportSnapshot>;
  now?: () => number;
};

class ConversationArchiveSizeError extends Error {}

function invalid(): never {
  throw new Error("The conversation archive could not be read.");
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    return invalid();
  return row;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) return invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return invalid();
  const time = new Date(value);
  const calendar = new Date(`${value.slice(0, 19)}Z`);
  if (
    !Number.isFinite(time.getTime()) ||
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    return invalid();
  return time.toISOString();
}
function count(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    return invalid();
  return value;
}
function body(value: unknown): string {
  validateContactText(value);
  // Validate without silently trimming or changing the archived text.
  return value as string;
}

function calendarDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-"))
    return invalid();
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    return invalid();
  return value;
}

/** Inclusive conversation-creation days in UTC; at least one bound is required. */
export function parseConversationExportSelection(value: unknown): ConversationExportSelection {
  const row = object(value, ["createdFrom", "createdThrough", "timeZone"]);
  const createdFrom = calendarDate(row.createdFrom);
  const createdThrough = calendarDate(row.createdThrough);
  if (
    row.timeZone !== "UTC" ||
    (!createdFrom && !createdThrough) ||
    (createdFrom && createdThrough && createdFrom > createdThrough)
  )
    return invalid();
  return { createdFrom, createdThrough, timeZone: "UTC" };
}

function requestSelection(url: string): ConversationExportSelection | undefined {
  const params = new URL(url).searchParams;
  if (!params.has("from") && !params.has("through")) return undefined;
  if (params.getAll("from").length > 1 || params.getAll("through").length > 1) return invalid();
  return parseConversationExportSelection({
    createdFrom: params.get("from"),
    createdThrough: params.get("through"),
    timeZone: "UTC",
  });
}

/** Require a complete, bounded archive and reconstruct only its supported fields. */
export function parseConversationArchive(value: unknown): ConversationArchive {
  const filtered =
    typeof value === "object" && value !== null && "version" in value && value.version === 2;
  const root = object(value, [
    "version",
    "scope",
    "complete",
    "exportedAt",
    "counts",
    "conversations",
    "omitted",
    ...(filtered ? ["selection"] : []),
  ]);
  if (
    root.complete !== true ||
    (filtered
      ? root.scope !== "filtered-accessible-conversations"
      : root.version !== 1 || root.scope !== "accessible-conversations")
  )
    return invalid();
  const selection = filtered ? parseConversationExportSelection(root.selection) : undefined;
  const totals = object(root.counts, ["conversations", "replies"]);
  const counts = {
    conversations: count(totals.conversations, CONVERSATION_EXPORT_LIMITS.conversations),
    replies: count(totals.replies, CONVERSATION_EXPORT_LIMITS.replies),
  };
  if (!Array.isArray(root.conversations) || root.conversations.length !== counts.conversations)
    return invalid();
  if (
    !Array.isArray(root.omitted) ||
    root.omitted.length !== CONVERSATION_EXPORT_OMITTED.length ||
    CONVERSATION_EXPORT_OMITTED.some((item, index) => (root.omitted as unknown[])[index] !== item)
  )
    return invalid();

  const messageIds = new Set<string>();
  const replyIds = new Set<string>();
  let replyCount = 0;
  const conversations = Array.from(root.conversations, (value) => {
    const row = object(value, [
      "id",
      "kind",
      "text",
      "anonymous",
      "senderName",
      "recipientHandle",
      "createdAt",
      "paymentStatus",
      "direction",
      "readAt",
      "lastActivityAt",
      "replies",
    ]);
    const id = identifier(row.id);
    if (messageIds.has(id)) return invalid();
    messageIds.add(id);
    if (
      typeof row.kind !== "string" ||
      !["dm", "donation"].includes(row.kind) ||
      typeof row.paymentStatus !== "string" ||
      !["free", "unverified", "pending", "paid"].includes(row.paymentStatus) ||
      typeof row.direction !== "string" ||
      !["received", "sent"].includes(row.direction) ||
      typeof row.anonymous !== "boolean" ||
      typeof row.senderName !== "string" ||
      !row.senderName ||
      row.senderName.length > 320 ||
      typeof row.recipientHandle !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/.test(row.recipientHandle) ||
      !Array.isArray(row.replies) ||
      row.replies.length > CONVERSATION_EXPORT_LIMITS.replies
    )
      return invalid();
    const createdAt = timestamp(row.createdAt);
    const createdDay = createdAt.slice(0, 10);
    if (
      selection &&
      ((selection.createdFrom && createdDay < selection.createdFrom) ||
        (selection.createdThrough && createdDay > selection.createdThrough))
    )
      return invalid();
    if (
      (row.anonymous &&
        (row.senderName !== "Anonymous" ||
          row.direction !== "received" ||
          row.kind !== "donation")) ||
      (row.direction === "received" && row.paymentStatus === "pending")
    )
      return invalid();
    const replies = Array.from(row.replies, (value) => {
      replyCount++;
      if (replyCount > CONVERSATION_EXPORT_LIMITS.replies) return invalid();
      const reply = object(value, ["id", "text", "createdAt", "fromCreator"]);
      const id = identifier(reply.id);
      if (replyIds.has(id) || typeof reply.fromCreator !== "boolean") return invalid();
      replyIds.add(id);
      return {
        id,
        text: body(reply.text),
        createdAt: timestamp(reply.createdAt),
        fromCreator: reply.fromCreator,
      };
    });
    return {
      id,
      kind: row.kind as ContactKind,
      text: body(row.text),
      anonymous: row.anonymous,
      senderName: row.anonymous
        ? "Anonymous"
        : row.senderName.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 160),
      recipientHandle: row.recipientHandle,
      createdAt,
      paymentStatus: row.paymentStatus as ContactPaymentStatus,
      direction: row.direction as "received" | "sent",
      readAt: row.readAt === null ? null : timestamp(row.readAt),
      lastActivityAt: timestamp(row.lastActivityAt),
      replies,
    };
  });
  if (replyCount !== counts.replies) return invalid();
  const contents: ConversationArchiveContents = {
    complete: true,
    exportedAt: timestamp(root.exportedAt),
    counts,
    conversations,
    omitted: [...CONVERSATION_EXPORT_OMITTED],
  };
  const archive: ConversationArchive = selection
    ? { version: 2, scope: "filtered-accessible-conversations", selection, ...contents }
    : { version: 1, scope: "accessible-conversations", ...contents };
  if (
    new TextEncoder().encode(JSON.stringify(archive)).byteLength > CONVERSATION_EXPORT_LIMITS.bytes
  )
    throw new ConversationArchiveSizeError("The conversation archive exceeds its size limit.");
  return archive;
}

export function createConversationExportHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const headers = {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie",
    };
    const error = (message: string, status: number) =>
      Response.json({ message }, { status, headers });
    if (request.method !== "GET")
      return Response.json(
        { message: "Method not allowed." },
        { status: 405, headers: { ...headers, Allow: "GET" } },
      );
    if (!deps.configured) return error("Conversation export is not configured.", 503);
    try {
      const session = await deps.getSession(request.headers);
      const now = deps.now?.() ?? Date.now();
      const expiresAt = session ? new Date(session.session.expiresAt).getTime() : NaN;
      if (
        !session?.user.id ||
        session.user.id !== session.session.userId ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now
      )
        return error("Sign in to export your conversations.", 401);
      if (!isFreshAccountSession(session.session.createdAt, now))
        return error("Sign in again to download your conversations.", 403);
      let selection: ConversationExportSelection | undefined;
      try {
        selection = requestSelection(request.url);
      } catch {
        return error("Choose valid UTC dates, with From on or before Through.", 400);
      }
      const snapshot = await deps.readSnapshot(session.user.id, selection);
      if (
        snapshot.overflow ||
        snapshot.counts.conversations > CONVERSATION_EXPORT_LIMITS.conversations ||
        snapshot.counts.replies > CONVERSATION_EXPORT_LIMITS.replies
      )
        return error(
          "Your conversations exceed this download’s limits. No partial archive was created.",
          413,
        );
      const value = {
        ...(selection
          ? { version: 2, scope: "filtered-accessible-conversations", selection }
          : { version: 1, scope: "accessible-conversations" }),
        complete: true,
        exportedAt: new Date(snapshot.exportedAt).toISOString(),
        counts: snapshot.counts,
        conversations: snapshot.conversations,
        omitted: [...CONVERSATION_EXPORT_OMITTED],
      };
      const raw = JSON.stringify(value);
      if (new TextEncoder().encode(raw).byteLength > CONVERSATION_EXPORT_LIMITS.bytes)
        return error(
          "Your conversations exceed this download’s limits. No partial archive was created.",
          413,
        );
      const archive = parseConversationArchive(value);
      const range = selection
        ? `-${selection.createdFrom ?? "start"}-through-${selection.createdThrough ?? "latest"}`
        : "";
      return new Response(JSON.stringify(archive), {
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="fathom-conversations${range}-${archive.exportedAt.slice(0, 10)}.json"`,
        },
      });
    } catch (cause) {
      if (cause instanceof ConversationArchiveSizeError)
        return error(
          "Your conversations exceed this download’s limits. No partial archive was created.",
          413,
        );
      return error("Could not export conversations. Try again.", 503);
    }
  };
}
