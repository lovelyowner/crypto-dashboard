import assert from "node:assert/strict";
import test from "node:test";
import {
  inboxMessageActivity,
  inboxMessagePreview,
  inboxMessageUnread,
  parseInboxMessage,
  parseInboxResponse,
  parseInboxThread,
  sortInboxMessages,
} from "./contact-inbox";

const original = {
  id: "original",
  kind: "dm",
  text: "Original private text",
  anonymous: false,
  senderName: "Sender",
  recipientHandle: "creator",
  createdAt: "2026-01-01T00:00:00.000Z",
  paymentStatus: "free",
  direction: "received",
  readAt: null,
};
const reply = {
  id: "reply",
  text: "A new\nprivate reply",
  createdAt: "2026-01-03T12:00:00.000Z",
  fromCreator: true,
};

test("inbox metadata validates activity, viewer unread counts, and latest reply without accepting private extras", () => {
  const result = parseInboxResponse({
    messages: [
      {
        ...original,
        unread: true,
        lastActivityAt: reply.createdAt,
        latestReply: reply,
        senderId: "secret",
      },
    ],
    nextCursor: "opaque-cursor",
    unreadCounts: { received: 2, sent: 3, donations: 1, ownerId: "secret" },
  });
  assert.equal(result.messages[0].latestReply?.text, reply.text);
  assert.equal(result.messages[0].unread, true);
  assert.equal("senderId" in result.messages[0], false);
  assert.deepEqual(result.unreadCounts, { received: 2, sent: 3, donations: 1 });
  for (const value of [-1, 1.5, "3", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() =>
      parseInboxResponse({
        messages: [],
        nextCursor: null,
        unreadCounts: { received: value, sent: 0, donations: 0 },
      }),
    );
  }
  assert.throws(() => parseInboxMessage({ ...original, unread: "yes" }));
  assert.throws(() => parseInboxMessage({ ...original, lastActivityAt: "invalid" }));
  assert.throws(() =>
    parseInboxMessage({ ...original, latestReply: { ...reply, fromCreator: 1 } }),
  );
});

test("legacy inbox responses preserve unread fallback while pending payments never appear as unread", () => {
  const message = parseInboxMessage(original);
  assert.equal(inboxMessageUnread(message), true);
  assert.equal(inboxMessageActivity(message), original.createdAt);
  assert.equal(inboxMessagePreview(message), original.text);
  assert.equal(inboxMessageUnread(parseInboxMessage({ ...original, direction: "sent" })), false);
  assert.equal(inboxMessageUnread(parseInboxMessage({ ...original, unread: false })), false);
  assert.equal(
    inboxMessageUnread(parseInboxMessage({ ...original, paymentStatus: "pending", unread: true })),
    false,
  );
  assert.deepEqual(
    parseInboxResponse({ messages: [original], nextCursor: null }).unreadCounts,
    undefined,
  );
});

test("latest reply previews identify the author for both participants and retain plain text", () => {
  const incoming = parseInboxMessage({ ...original, latestReply: reply });
  assert.equal(inboxMessagePreview(incoming), "You: A new private reply");
  assert.equal(
    inboxMessagePreview({ ...incoming, direction: "sent" }),
    "@creator: A new private reply",
  );
  assert.equal(
    inboxMessagePreview({ ...incoming, latestReply: { ...reply, fromCreator: false } }),
    "Sender: A new private reply",
  );
  const parsed = parseInboxThread({
    message: original,
    replies: [{ ...reply, text: "<script>literal</script>", authorId: "secret" }],
  });
  assert.equal(parsed.replies[0].text, "<script>literal</script>");
  assert.equal("authorId" in parsed.replies[0], false);
});

test("reply activity reorders conversations without mutating original pages", () => {
  const older = parseInboxMessage({
    ...original,
    latestReply: reply,
    lastActivityAt: reply.createdAt,
  });
  const newer = parseInboxMessage({
    ...original,
    id: "newer",
    createdAt: "2026-01-02T00:00:00.000Z",
  });
  const page = [newer, older];
  assert.deepEqual(
    sortInboxMessages(page).map((message) => message.id),
    ["original", "newer"],
  );
  assert.deepEqual(
    page.map((message) => message.id),
    ["newer", "original"],
  );
});
