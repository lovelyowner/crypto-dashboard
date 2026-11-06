import { normalizePublicHandle } from "./public-profile.js";
import {
  validateContactSettings,
  validateContactMessageInput,
  validateContactText,
  type ContactConfiguration,
  type InboxFolder,
} from "./creator-contact.js";
import {
  contactMessageDto,
  contactThreadDto,
  validInboxCursor,
  type ContactStore,
} from "./contact-store.js";
import type { ProfileSession } from "./profile-handler.js";
import { isContactBlockedError } from "./moderation.js";

export type ContactSession = ProfileSession & { user: { id: string; name?: string | null } };
export interface ContactHandlerDependencies {
  configured: boolean;
  allowedOrigins: readonly string[];
  getSession(headers: Headers): Promise<ContactSession | null>;
  store: ContactStore;
  getPaymentAvailability?: (userId: string) => Promise<{ nowpaymentsConfigured: boolean }>;
  requestKey?: (request: Request) => Promise<string> | string;
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
function respond(value: unknown, status = 200, headers?: HeadersInit): Response {
  const all = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Cookie, Origin",
  });
  new Headers(headers).forEach((v, k) => all.set(k, v));
  return Response.json(value, { status, headers: all });
}
function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
async function readJson(request: Request, max = 16_384): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > max))
    throw new RequestError(413, "The message request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "A JSON request is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        void reader.cancel().catch(() => undefined);
        throw new RequestError(413, "The message request is too large.");
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
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestError(400, "Send valid JSON.");
  }
}
function envelope(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError(400, "Send only the supported request fields.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((k) => !Object.hasOwn(row, k)))
    throw new RequestError(400, "Send only the supported request fields.");
  return row;
}
function identifier(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new RequestError(404, "Message not found.");
  return value;
}
/** Message contents and participants are private; no public route lists an inbox. */
export function createContactHandler(dependencies: ContactHandlerDependencies) {
  const origins = new Set(dependencies.allowedOrigins.map(originOf).filter(Boolean));
  const now = () => dependencies.now?.() ?? Date.now();
  async function session(request: Request): Promise<ContactSession> {
    const value = await dependencies.getSession(request.headers);
    if (
      !value?.user.id ||
      value.user.id !== value.session.userId ||
      !(new Date(value.session.expiresAt).getTime() > now())
    )
      throw new RequestError(401, "Sign in to use private messages.");
    return value;
  }
  function mutation(request: Request) {
    if (
      !origins.has(request.headers.get("origin")) ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      throw new RequestError(403, "Send messages and change settings from this app.");
    if (
      request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
      "application/json"
    )
      throw new RequestError(415, "Use application/json.");
  }
  async function configuration(userId: string): Promise<ContactConfiguration> {
    const config = await dependencies.store.readConfiguration(userId);
    const payments = await dependencies.getPaymentAvailability?.(userId);
    return { ...config, nowpaymentsConfigured: payments?.nowpaymentsConfigured ?? false };
  }
  async function throttle(request: Request, userId: string) {
    const requestKey = (await dependencies.requestKey?.(request)) ?? "unknown";
    if (
      !(await dependencies.store.consumeRate(`contact:user:${userId}`, 12, now())) ||
      !(await dependencies.store.consumeRate(`contact:source:${requestKey}`, 40, now()))
    )
      throw new RequestError(429, "Too many messages. Please wait a minute before trying again.");
  }
  return async function handleContactRequest(request: Request): Promise<Response> {
    if (!dependencies.configured)
      return respond({ message: "Creator messaging is not configured." }, 503);
    try {
      const url = new URL(request.url),
        path = url.pathname;
      if (request.method !== "GET") mutation(request);
      if (path === "/api/profile/contact") {
        if (request.method !== "GET" && request.method !== "PUT")
          return respond({ message: "Method not allowed." }, 405, { Allow: "GET, PUT" });
        const owner = await session(request);
        if (request.method === "PUT") {
          const body = envelope(await readJson(request, 8192), ["settings"]);
          let settings;
          try {
            settings = validateContactSettings(body.settings);
          } catch (error) {
            throw new RequestError(
              400,
              error instanceof Error ? error.message : "Invalid contact settings.",
            );
          }
          const current = await dependencies.store.readConfiguration(owner.user.id);
          if (
            settings.ethDonationAddressId &&
            !current.ethereumAddresses.some((a) => a.id === settings.ethDonationAddressId)
          )
            throw new RequestError(
              400,
              "Choose an Ethereum address from your currently published profile.",
            );
          await dependencies.store.saveSettings(owner.user.id, settings);
        }
        return respond(await configuration(owner.user.id));
      }
      const creator = /^\/api\/creators\/([^/]+)\/(contact|messages)$/.exec(path);
      if (creator) {
        let handle: string;
        try {
          handle = normalizePublicHandle(decodeURIComponent(creator[1]));
        } catch {
          throw new RequestError(404, "Creator not found.");
        }
        const recipient = await dependencies.store.resolveRecipient(handle);
        if (!recipient) throw new RequestError(404, "Creator not found.");
        if (creator[2] === "contact") {
          if (request.method !== "GET")
            return respond({ message: "Method not allowed." }, 405, { Allow: "GET" });
          const payments = await dependencies.getPaymentAvailability?.(recipient.recipientUserId);
          return respond({
            handle: recipient.handle,
            settings: recipient.settings,
            ethereumAddresses: recipient.ethereumAddresses,
            nowpaymentsConfigured: payments?.nowpaymentsConfigured ?? false,
          });
        }
        if (request.method !== "POST")
          return respond({ message: "Method not allowed." }, 405, { Allow: "POST" });
        let input;
        try {
          input = validateContactMessageInput(await readJson(request));
        } catch (error) {
          if (error instanceof RequestError) throw error;
          throw new RequestError(400, error instanceof Error ? error.message : "Invalid message.");
        }
        if (input.kind === "donation") {
          if (!recipient.settings.donationNotesEnabled)
            throw new RequestError(403, "This creator is not accepting donation messages.");
          return respond(
            {
              message: "A verified donation is required before its note is delivered.",
              paymentRequired: true,
              settings: recipient.settings,
            },
            402,
          );
        }
        const sender = await session(request);
        if (sender.user.id === recipient.recipientUserId)
          throw new RequestError(400, "Choose another creator to send a message.");
        if (
          dependencies.store.contactAllowed &&
          !(await dependencies.store.contactAllowed(sender.user.id, recipient.recipientUserId))
        )
          throw new RequestError(403, "Contact is blocked. New messages are unavailable.");
        if (recipient.settings.dmMode === "closed")
          throw new RequestError(403, "This creator is not accepting direct messages.");
        if (recipient.settings.dmMode === "paid")
          return respond(
            {
              message: "A verified payment is required for each message to this creator.",
              paymentRequired: true,
              settings: recipient.settings,
            },
            402,
          );
        await throttle(request, sender.user.id);
        const message = await dependencies.store.createFreeMessage({
          recipientId: recipient.recipientUserId,
          senderId: sender.user.id,
          senderName: sender.user.name?.slice(0, 160) || "Account member",
          anonymous: false,
          kind: "dm",
          text: input.text,
        });
        if (!message)
          throw new RequestError(
            409,
            "The creator’s message policy changed. Reload before sending.",
          );
        return respond({ message: contactMessageDto(message, sender.user.id) }, 201);
      }
      if (path === "/api/inbox") {
        if (request.method !== "GET")
          return respond({ message: "Method not allowed." }, 405, { Allow: "GET" });
        const owner = await session(request),
          folder = url.searchParams.get("folder") ?? "received";
        if (!["received", "sent", "donations"].includes(folder))
          throw new RequestError(400, "Choose a supported inbox folder.");
        const cursor = url.searchParams.get("cursor");
        if (cursor && !validInboxCursor(cursor))
          throw new RequestError(400, "The inbox page could not be read. Refresh the inbox.");
        const result = await dependencies.store.listMessages(
          owner.user.id,
          folder as InboxFolder,
          cursor,
        );
        return respond({
          messages: result.messages.map((m) => contactMessageDto(m, owner.user.id)),
          nextCursor: result.nextCursor,
          unreadCounts:
            result.unreadCounts ??
            (dependencies.store.unreadCounts
              ? await dependencies.store.unreadCounts(owner.user.id)
              : { received: 0, sent: 0, donations: 0 }),
        });
      }
      const thread = /^\/api\/inbox\/([^/]+)(\/replies)?$/.exec(path);
      if (thread) {
        const owner = await session(request),
          id = identifier(decodeURIComponent(thread[1]));
        const item = await dependencies.store.readThread(
          owner.user.id,
          id,
          request.method === "GET",
        );
        if (!item) throw new RequestError(404, "Message not found.");
        if (thread[2]) {
          if (request.method !== "POST")
            return respond({ message: "Method not allowed." }, 405, { Allow: "POST" });
          const body = envelope(await readJson(request), ["text"]);
          let text;
          try {
            text = validateContactText(body.text);
          } catch (error) {
            throw new RequestError(400, error instanceof Error ? error.message : "Invalid reply.");
          }
          if (item.message.anonymous || !item.message.senderId)
            throw new RequestError(403, "Anonymous donation notes cannot receive replies.");
          if (item.message.paymentStatus === "pending")
            throw new RequestError(
              402,
              "Payment must be verified before this message can receive replies.",
            );
          if (
            dependencies.store.contactAllowed &&
            !(await dependencies.store.contactAllowed(
              item.message.senderId,
              item.message.recipientId,
            ))
          )
            throw new RequestError(403, "Contact is blocked. New replies are unavailable.");
          if (owner.user.id !== item.message.recipientId) {
            const config = await dependencies.store.readConfiguration(item.message.recipientId);
            if (config.settings.dmMode === "paid")
              return respond(
                {
                  message: "A verified payment is required for each new message to this creator.",
                  paymentRequired: true,
                  handle: item.message.recipientHandle,
                },
                402,
              );
            if (config.settings.dmMode !== "free")
              throw new RequestError(403, "This creator is not accepting new direct messages.");
          }
          await throttle(request, owner.user.id);
          if (!(await dependencies.store.reply(owner.user.id, id, text)))
            throw new RequestError(
              409,
              "The message policy changed or this conversation has reached its reply limit.",
            );
          const updated = await dependencies.store.readThread(owner.user.id, id, false);
          if (!updated) throw new RequestError(404, "Message not found.");
          return respond(contactThreadDto(updated, owner.user.id), 201);
        }
        if (request.method === "PATCH") {
          const body = envelope(await readJson(request), ["read"]);
          if (body.read !== true) throw new RequestError(400, "Send read: true.");
          if (
            !(await dependencies.store.markRead(owner.user.id, id, item.message.activityRevision))
          )
            throw new RequestError(404, "Message not found.");
          const updated = await dependencies.store.readThread(owner.user.id, id, false);
          if (!updated) throw new RequestError(404, "Message not found.");
          return respond({ message: contactMessageDto(updated.message, owner.user.id) });
        }
        if (request.method !== "GET")
          return respond({ message: "Method not allowed." }, 405, { Allow: "GET, PATCH" });
        return respond(contactThreadDto(item, owner.user.id));
      }
      throw new RequestError(404, "Messaging route not found.");
    } catch (error) {
      if (isContactBlockedError(error))
        return respond(
          { message: "Contact is blocked. New messages and replies are unavailable." },
          403,
        );
      if (error instanceof RequestError)
        return respond(
          { message: error.message },
          error.status,
          error.status === 429 ? { "Retry-After": "60" } : undefined,
        );
      return respond(
        { message: "Messages or contact settings could not be loaded or changed. Please retry." },
        500,
      );
    }
  };
}
