import test from "node:test";
import assert from "node:assert/strict";
import { createContactHandler, type ContactHandlerDependencies } from "./contact-handler";
import { DEFAULT_CONTACT_SETTINGS, type ContactSettings } from "./creator-contact";
import { DEFAULT_CREATOR_PROFILE } from "./creator-profile";
import type { ContactStore, StoredContactMessage } from "./contact-store";

const origin = "https://fathom.example.com",
  now = Date.UTC(2026, 10, 4);
function fixture() {
  let settings: ContactSettings = { ...DEFAULT_CONTACT_SETTINGS, dmMode: "free" };
  let writes = 0,
    sessionReads = 0,
    rateAllowed = true;
  const row: StoredContactMessage = {
    id: "message-1",
    recipientId: "creator-id",
    recipientHandle: "creator",
    senderId: "sender-id",
    senderName: "Sender 🌙",
    anonymous: false,
    kind: "dm",
    text: "Hello",
    paymentStatus: "free",
    paymentId: null,
    createdAt: new Date(now),
    readAt: null,
  };
  const store: ContactStore = {
    resolveRecipient: async (handle) =>
      handle === "creator"
        ? {
            recipientUserId: "creator-id",
            handle: "creator",
            displayName: "Creator",
            profile: { ...structuredClone(DEFAULT_CREATOR_PROFILE), displayName: "Creator" },
            settings,
            ethereumAddresses: [
              { id: "eth", address: "0x0000000000000000000000000000000000000001", label: "ETH" },
            ],
            ethereumAddress: null,
          }
        : null,
    readConfiguration: async () => ({
      handle: "creator",
      settings,
      ethereumAddresses: [
        { id: "eth", address: "0x0000000000000000000000000000000000000001", label: "ETH" },
      ],
    }),
    saveSettings: async (_id, value) => {
      writes++;
      settings = value;
    },
    consumeRate: async () => rateAllowed,
    createFreeMessage: async (input) => {
      writes++;
      return { ...row, senderId: input.senderId, senderName: input.senderName, text: input.text };
    },
    createPendingMessage: async () => {
      throw new Error("Not exposed by this handler");
    },
    completePendingMessage: async () => false,
    readInternalMessage: async () => row,
    listMessages: async (userId) => ({
      messages: userId === "sender-id" ? [row] : [],
      nextCursor: null,
    }),
    readThread: async (userId, id) =>
      id === row.id && [row.recipientId, row.senderId].includes(userId)
        ? { message: row, replies: [] }
        : null,
    reply: async () => {
      writes++;
      return true;
    },
    markRead: async (userId) => [row.recipientId, row.senderId].includes(userId),
  };
  const dependencies: ContactHandlerDependencies = {
    configured: true,
    allowedOrigins: [origin],
    now: () => now,
    store,
    getPaymentAvailability: async () => ({ nowpaymentsConfigured: true }),
    getSession: async (headers) => {
      sessionReads++;
      const id = headers.get("x-test-user");
      if (!id) return null;
      return {
        user: { id, name: id === "sender-id" ? "Sender 🌙" : "Creator" },
        session: {
          userId: id,
          expiresAt: new Date(now + (headers.has("x-expired") ? -1 : 60_000)),
        },
      };
    },
  };
  const handler = createContactHandler(dependencies);
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    user?: string,
    extra: Record<string, string> = {},
  ) {
    return handler(
      new Request(origin + path, {
        method,
        headers: {
          origin,
          "content-type": "application/json",
          ...(user ? { "x-test-user": user } : {}),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  return {
    handler,
    dependencies,
    request,
    row,
    get writes() {
      return writes;
    },
    get sessionReads() {
      return sessionReads;
    },
    set settings(value: ContactSettings) {
      settings = value;
    },
    set rateAllowed(value: boolean) {
      rateAllowed = value;
    },
  };
}
test("public contact metadata reveals no account identity and does not read an authentication session", async () => {
  const f = fixture();
  const response = await f.request("/api/creators/creator/contact");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.handle, "creator");
  assert.equal(data.nowpaymentsConfigured, true);
  assert.equal(f.sessionReads, 0);
  assert.equal("recipientUserId" in data, false);
  assert.equal("email" in data, false);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal((await f.request("/api/creators/missing/contact")).status, 404);
  assert.equal((await f.request("/api/inbox")).status, 401);
  assert.equal(
    (await f.request("/api/profile/contact", "GET", undefined, "sender-id", { "x-expired": "1" }))
      .status,
    401,
  );
});
test("private contact settings require same-origin strict JSON and a currently published receiving address", async () => {
  const f = fixture();
  const settings = {
    ...DEFAULT_CONTACT_SETTINGS,
    dmMode: "paid",
    dmEthPrice: "0.01",
    ethDonationAddressId: "other-wallet",
  };
  assert.equal(
    (await f.request("/api/profile/contact", "PUT", { settings }, "creator-id")).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        "/api/profile/contact",
        "PUT",
        { settings: DEFAULT_CONTACT_SETTINGS },
        "creator-id",
        { origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        "/api/profile/contact",
        "PUT",
        { settings: DEFAULT_CONTACT_SETTINGS, userId: "other" },
        "creator-id",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        "/api/profile/contact",
        "PUT",
        { settings: DEFAULT_CONTACT_SETTINGS },
        "creator-id",
        { "content-type": "text/plain" },
      )
    ).status,
    415,
  );
  assert.equal(f.writes, 0);
  const saved = await f.request(
    "/api/profile/contact",
    "PUT",
    { settings: { ...settings, ethDonationAddressId: "eth" } },
    "creator-id",
  );
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).settings.ethDonationAddressId, "eth");
});
test("free DMs derive sender identity from the session; paid DMs and donation notes cannot arrive without proof", async () => {
  const f = fixture();
  const input = { kind: "dm", text: "Hello creator", anonymous: false };
  assert.equal((await f.request("/api/creators/creator/messages", "POST", input)).status, 401);
  assert.equal(
    (
      await f.request(
        "/api/creators/creator/messages",
        "POST",
        { ...input, senderId: "other" },
        "sender-id",
      )
    ).status,
    400,
  );
  const free = await f.request("/api/creators/creator/messages", "POST", input, "sender-id");
  assert.equal(free.status, 201);
  assert.equal((await free.json()).message.senderName, "Sender 🌙");
  assert.equal(f.writes, 1);
  f.settings = { ...DEFAULT_CONTACT_SETTINGS, dmMode: "paid", dmUsdPrice: "5.00" };
  assert.equal(
    (await f.request("/api/creators/creator/messages", "POST", input, "sender-id")).status,
    402,
  );
  assert.equal(
    (
      await f.request("/api/creators/creator/messages", "POST", {
        kind: "donation",
        text: "Donation bypass",
        anonymous: true,
      })
    ).status,
    402,
  );
  assert.equal(f.writes, 1);
  f.settings = { ...DEFAULT_CONTACT_SETTINGS, donationNotesEnabled: false };
  assert.equal(
    (await f.request("/api/creators/creator/messages", "POST", input, "sender-id")).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/creators/creator/messages", "POST", {
        kind: "donation",
        text: "Tip",
        anonymous: true,
      })
    ).status,
    403,
  );
});
test("inbox and replies remain participant-only and incoming paid follow-ups cannot bypass a fee", async () => {
  const f = fixture();
  assert.equal((await f.request("/api/inbox/message-1", "GET", undefined, "other-id")).status, 404);
  const sent = await f.request("/api/inbox?folder=sent", "GET", undefined, "sender-id");
  assert.equal(sent.status, 200);
  const messages = (await sent.json()).messages;
  assert.equal(messages.length, 1);
  assert.equal("senderId" in messages[0], false);
  assert.equal(
    (await f.request("/api/inbox/message-1/replies", "POST", { text: "Hi" }, "other-id")).status,
    404,
  );
  f.settings = { ...DEFAULT_CONTACT_SETTINGS, dmMode: "paid", dmUsdPrice: "2.00" };
  assert.equal(
    (
      await f.request(
        "/api/inbox/message-1/replies",
        "POST",
        { text: "Unpaid followup" },
        "sender-id",
      )
    ).status,
    402,
  );
  assert.equal(
    (
      await f.request(
        "/api/inbox/message-1/replies",
        "POST",
        { text: "Creator reply" },
        "creator-id",
      )
    ).status,
    201,
  );
  assert.equal(
    (await f.request("/api/inbox/message-1", "PATCH", { read: true }, "sender-id")).status,
    200,
  );
  assert.equal(
    (await f.request("/api/inbox/message-1", "PATCH", { read: true }, "creator-id")).status,
    200,
  );
  assert.equal(
    (await f.request("/api/inbox?folder=all-accounts", "GET", undefined, "creator-id")).status,
    400,
  );
});
test("inbox activity metadata and unread counts use the current viewer without exposing read receipts", async () => {
  const f = fixture();
  const readAt = new Date(now - 30_000);
  const senderReadAt = new Date(now - 10_000);
  Object.assign(f.row, {
    activityRevision: 3,
    recipientReadRevision: 2,
    senderReadRevision: 3,
    readAt,
    senderReadAt,
    lastActivityAt: new Date(now - 5_000),
    latestReply: {
      id: "reply-3",
      text: "Newest 🌙",
      createdAt: new Date(now - 5_000).toISOString(),
      fromCreator: false,
    },
  });
  f.dependencies.store.listMessages = async () => ({ messages: [f.row], nextCursor: null });
  const counted: string[] = [];
  f.dependencies.store.unreadCounts = async (id) => {
    counted.push(id);
    return { received: id === "creator-id" ? 1 : 0, sent: 0, donations: 0 };
  };
  const received = await (await f.request("/api/inbox", "GET", undefined, "creator-id")).json();
  assert.deepEqual(received.unreadCounts, { received: 1, sent: 0, donations: 0 });
  assert.equal(received.messages[0].unread, true);
  assert.equal(received.messages[0].latestReply.text, "Newest 🌙");
  assert.equal(received.messages[0].readAt, readAt.toISOString());
  assert.equal(received.messages[0].lastActivityAt, new Date(now - 5_000).toISOString());
  const sent = await (
    await f.request("/api/inbox?folder=sent", "GET", undefined, "sender-id")
  ).json();
  assert.equal(sent.messages[0].unread, false);
  assert.equal(sent.messages[0].readAt, senderReadAt.toISOString());
  assert.deepEqual(counted, ["creator-id", "sender-id"]);
  for (const field of [
    "senderId",
    "recipientId",
    "senderReadAt",
    "activityRevision",
    "recipientReadRevision",
    "senderReadRevision",
  ])
    assert.equal(field in received.messages[0], false);
  assert.equal(JSON.stringify(sent).includes(readAt.toISOString()), false);
  const marked: unknown[][] = [];
  f.dependencies.store.markRead = async (...args) => {
    marked.push(args);
    return true;
  };
  assert.equal(
    (await f.request("/api/inbox/message-1", "PATCH", { read: true }, "sender-id")).status,
    200,
  );
  assert.deepEqual(marked, [["sender-id", "message-1", 3]]);
  const beforeGuest = counted.length;
  assert.equal((await f.request("/api/inbox")).status, 401);
  assert.equal(counted.length, beforeGuest);
  for (const cursor of ["v1_bad", "x".repeat(513), "[bad]"])
    assert.equal(
      (
        await f.request(
          `/api/inbox?cursor=${encodeURIComponent(cursor)}`,
          "GET",
          undefined,
          "sender-id",
        )
      ).status,
      400,
    );
});
test("message writes are bounded, rate limited, cross-site protected and internal errors never leak", async () => {
  const f = fixture();
  const input = { kind: "dm", text: "Hi", anonymous: false };
  assert.equal(
    (
      await f.request("/api/creators/creator/messages", "POST", input, "sender-id", {
        "sec-fetch-site": "cross-site",
      })
    ).status,
    403,
  );
  const oversized = new Request(origin + "/api/creators/creator/messages", {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-test-user": "sender-id" },
    body: "x".repeat(16_385),
  });
  assert.equal((await f.handler(oversized)).status, 413);
  f.rateAllowed = false;
  const limited = await f.request("/api/creators/creator/messages", "POST", input, "sender-id");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(f.writes, 0);
  const broken = createContactHandler({
    ...f.dependencies,
    store: {
      ...f.dependencies.store,
      resolveRecipient: async () => {
        throw new Error("private database credential");
      },
    },
  });
  const failure = await broken(new Request(origin + "/api/creators/creator/contact"));
  assert.equal(failure.status, 500);
  assert.doesNotMatch(await failure.text(), /credential/);
  const unconfigured = createContactHandler({ ...f.dependencies, configured: false });
  assert.equal((await unconfigured(new Request(origin + "/api/inbox"))).status, 503);
});

test("inbox API uses the page's snapshot counters instead of a later separate read", async () => {
  const f = fixture();
  f.dependencies.store.listMessages = async () => ({
    messages: [f.row],
    nextCursor: null,
    unreadCounts: { received: 2, sent: 1, donations: 3 },
  });
  f.dependencies.store.unreadCounts = async () => {
    throw new Error("A second count read would race");
  };
  const response = await f.request("/api/inbox", "GET", undefined, "creator-id");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).unreadCounts, { received: 2, sent: 1, donations: 3 });
});
