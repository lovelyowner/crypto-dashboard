import {
  validateContactText,
  type ContactMessage,
  type ContactReply,
  type ContactThread,
  type InboxResponse,
} from "./creator-contact";
import { normalizePublicHandle } from "./public-profile";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The inbox response could not be read.");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    throw new Error("The inbox response could not be read.");
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("The message date could not be read.");
  return new Date(value).toISOString();
}
function parseReply(value: unknown): ContactReply {
  const reply = record(value);
  if (typeof reply.fromCreator !== "boolean")
    throw new Error("The conversation could not be read.");
  return {
    id: identifier(reply.id),
    text: validateContactText(reply.text),
    createdAt: timestamp(reply.createdAt),
    fromCreator: reply.fromCreator,
  };
}
export function parseInboxMessage(value: unknown): ContactMessage {
  const row = record(value);
  if (
    !["dm", "donation"].includes(row.kind as string) ||
    typeof row.anonymous !== "boolean" ||
    typeof row.senderName !== "string" ||
    row.senderName.length > 320 ||
    !["free", "unverified", "pending", "paid"].includes(row.paymentStatus as string) ||
    !["received", "sent"].includes(row.direction as string) ||
    (Object.hasOwn(row, "unread") && typeof row.unread !== "boolean")
  )
    throw new Error("The inbox response could not be read.");
  return {
    id: identifier(row.id),
    kind: row.kind as ContactMessage["kind"],
    text: validateContactText(row.text),
    anonymous: row.anonymous,
    senderName: row.anonymous
      ? "Anonymous"
      : row.senderName.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 160),
    recipientHandle: normalizePublicHandle(row.recipientHandle),
    createdAt: timestamp(row.createdAt),
    paymentStatus: row.paymentStatus as ContactMessage["paymentStatus"],
    direction: row.direction as ContactMessage["direction"],
    readAt: row.readAt === null ? null : timestamp(row.readAt),
    ...(Object.hasOwn(row, "lastActivityAt")
      ? { lastActivityAt: timestamp(row.lastActivityAt) }
      : {}),
    ...(Object.hasOwn(row, "unread") ? { unread: row.unread as boolean } : {}),
    ...(Object.hasOwn(row, "latestReply")
      ? { latestReply: row.latestReply === null ? null : parseReply(row.latestReply) }
      : {}),
    ...(row.paymentStatus === "pending" && row.direction === "sent" && row.paymentId != null
      ? { paymentId: identifier(row.paymentId) }
      : {}),
  };
}
export function parseInboxResponse(value: unknown): InboxResponse {
  const row = record(value);
  if (
    !Array.isArray(row.messages) ||
    row.messages.length > 50 ||
    (row.nextCursor !== null &&
      (typeof row.nextCursor !== "string" || !row.nextCursor || row.nextCursor.length > 512))
  )
    throw new Error("The inbox response could not be read.");
  let unreadCounts: InboxResponse["unreadCounts"];
  if (Object.hasOwn(row, "unreadCounts")) {
    const counts = record(row.unreadCounts);
    if (
      [counts.received, counts.sent, counts.donations].some(
        (count) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0,
      )
    )
      throw new Error("The inbox unread counts could not be read.");
    unreadCounts = {
      received: counts.received as number,
      sent: counts.sent as number,
      donations: counts.donations as number,
    };
  }
  return {
    messages: row.messages.map(parseInboxMessage),
    nextCursor: row.nextCursor as string | null,
    ...(unreadCounts ? { unreadCounts } : {}),
  };
}
export function parseInboxThread(value: unknown): ContactThread {
  const row = record(value);
  if (!Array.isArray(row.replies) || row.replies.length > 500)
    throw new Error("The conversation could not be read.");
  return { message: parseInboxMessage(row.message), replies: row.replies.map(parseReply) };
}
export function inboxMessageUnread(message: ContactMessage): boolean {
  if (message.paymentStatus === "pending") return false;
  return message.unread ?? (message.direction === "received" && !message.readAt);
}
export function inboxMessageActivity(message: ContactMessage): string {
  return message.lastActivityAt ?? message.latestReply?.createdAt ?? message.createdAt;
}
export function inboxMessagePreview(message: ContactMessage): string {
  const reply = message.latestReply;
  if (!reply) return message.text.replace(/\s+/gu, " ").slice(0, 170);
  const author =
    message.direction === "received"
      ? reply.fromCreator
        ? "You"
        : "Sender"
      : reply.fromCreator
        ? `@${message.recipientHandle}`
        : "You";
  return `${author}: ${reply.text.replace(/\s+/gu, " ").slice(0, 170)}`;
}
/** Sorting never mutates a rendered page or changes the server's opaque cursor. */
export function sortInboxMessages(messages: ContactMessage[]): ContactMessage[] {
  return [...messages].sort(
    (left, right) =>
      Date.parse(inboxMessageActivity(right)) - Date.parse(inboxMessageActivity(left)) ||
      right.id.localeCompare(left.id),
  );
}
