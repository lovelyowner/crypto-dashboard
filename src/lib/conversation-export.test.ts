import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  CONVERSATION_EXPORT_LIMITS,
  CONVERSATION_EXPORT_OMITTED,
  createConversationExportHandler,
  parseConversationArchive,
  type ConversationArchive,
  type ConversationExportSnapshot,
} from "./conversation-export.js";
import { createSqlConversationExportStore } from "./conversation-export-store.js";

const now = Date.UTC(2026, 10, 6, 18);
const stamp = new Date(now).toISOString();
const owner = "owner-private-id";
const sender = "sender-private-id";
const stranger = "stranger-private-id";
const actor = "anonymous-actor-private-id";

function archive(): ConversationArchive {
  return {
    version: 1,
    scope: "accessible-conversations",
    complete: true,
    exportedAt: stamp,
    counts: { conversations: 1, replies: 1 },
    conversations: [
      {
        id: "message-1",
        kind: "dm",
        text: "Hello 🌙",
        anonymous: false,
        senderName: "Visible sender",
        recipientHandle: "creator",
        createdAt: stamp,
        paymentStatus: "free",
        direction: "received",
        readAt: null,
        lastActivityAt: stamp,
        replies: [{ id: "reply-1", text: "A reply", createdAt: stamp, fromCreator: true }],
      },
    ],
    omitted: [...CONVERSATION_EXPORT_OMITTED],
  };
}
function handlerFixture(snapshot?: ConversationExportSnapshot) {
  let reads = 0;
  let readUser = "";
  let configured = true;
  let session: {
    user: { id: string };
    session: { userId: string; createdAt: Date | string; expiresAt: Date | string };
  } | null = {
    user: { id: owner },
    session: { userId: owner, createdAt: new Date(now), expiresAt: new Date(now + 86_400_000) },
  };
  const value = archive();
  const source = snapshot ?? {
    exportedAt: stamp,
    counts: value.counts,
    conversations: value.conversations,
    overflow: false,
  };
  const handler = createConversationExportHandler({
    get configured() {
      return configured;
    },
    now: () => now,
    getSession: async () => session,
    readSnapshot: async (id) => {
      reads++;
      readUser = id;
      return source;
    },
  });
  return {
    source,
    setSession: (value: typeof session) => {
      session = value;
    },
    setConfigured: (value: boolean) => {
      configured = value;
    },
    reads: () => reads,
    readUser: () => readUser,
    request: (method = "GET", query = "") =>
      handler(new Request(`https://app.example/api/account/messages-export${query}`, { method })),
  };
}

test("conversation archives require exact complete DTOs, matching counts, and unique identities", () => {
  assert.deepEqual(parseConversationArchive(archive()), archive());
  const changes: ((value: ConversationArchive) => void)[] = [
    (value) => {
      Reflect.set(value, "complete", false);
    },
    (value) => {
      Reflect.set(value, "scope", "account-profile");
    },
    (value) => {
      value.counts.replies = 0;
    },
    (value) => {
      value.counts.conversations = 2;
    },
    (value) => {
      value.exportedAt = "2026-02-31T00:00:00Z";
    },
    (value) => {
      Reflect.set(value.conversations[0], "paymentId", "private-proof");
    },
    (value) => {
      Reflect.set(value.conversations[0], "kind", ["dm"]);
    },
    (value) => {
      Reflect.set(value.conversations[0].replies[0], "authorId", "private-author");
    },
    (value) => {
      value.omitted = [];
    },
    (value) => {
      value.conversations[0].replies.push(value.conversations[0].replies[0]);
      value.counts.replies = 2;
    },
    (value) => {
      value.conversations.push(value.conversations[0]);
      value.counts.conversations = 2;
      value.counts.replies = 2;
    },
    (value) => {
      value.conversations[0].replies = new Array(CONVERSATION_EXPORT_LIMITS.replies + 1);
    },
  ];
  for (const mutate of changes) {
    const value = structuredClone(archive());
    mutate(value);
    assert.throws(() => parseConversationArchive(value));
  }
});

test("conversation parser preserves text and uses the same safe displayed sender names as the inbox", () => {
  const value = archive();
  value.conversations[0].text = "  exact text\r\nwith whitespace  ";
  value.conversations[0].senderName = "Display\u202e name\n" + "x".repeat(200);
  const parsed = parseConversationArchive(value);
  assert.equal(parsed.conversations[0].text, value.conversations[0].text);
  assert.equal(parsed.conversations[0].senderName.length, 160);
  assert.doesNotMatch(parsed.conversations[0].senderName, /[\p{Cc}\p{Cf}]/u);
  value.conversations[0].anonymous = true;
  assert.throws(() => parseConversationArchive(value));
  value.conversations[0].kind = "donation";
  value.conversations[0].senderName = "Anonymous";
  assert.equal(parseConversationArchive(value).conversations[0].senderName, "Anonymous");
  value.conversations[0].paymentStatus = "pending";
  assert.throws(() => parseConversationArchive(value));
});

test("conversation export authenticates before reading and requires an unexpired matching fresh session", async () => {
  const f = handlerFixture();
  assert.equal((await f.request("POST")).status, 405);
  f.setConfigured(false);
  assert.equal((await f.request()).status, 503);
  f.setConfigured(true);
  for (const session of [
    null,
    {
      user: { id: owner },
      session: { userId: stranger, createdAt: stamp, expiresAt: new Date(now + 60_000) },
    },
    { user: { id: owner }, session: { userId: owner, createdAt: stamp, expiresAt: new Date(now) } },
    { user: { id: owner }, session: { userId: owner, createdAt: stamp, expiresAt: "invalid" } },
  ]) {
    f.setSession(session);
    assert.equal((await f.request()).status, 401);
  }
  f.setSession({
    user: { id: owner },
    session: {
      userId: owner,
      createdAt: new Date(now - 600_000),
      expiresAt: new Date(now + 60_000),
    },
  });
  assert.equal((await f.request()).status, 403);
  assert.equal(f.reads(), 0);
});

test("successful export is a private attachment and client-supplied owners never change its scope", async () => {
  const f = handlerFixture();
  const response = await f.request("GET", `?userId=${stranger}`);
  assert.equal(response.status, 200);
  assert.equal(f.readUser(), owner);
  assert.match(response.headers.get("cache-control")!, /private.*no-store/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    response.headers.get("content-disposition")!,
    /attachment; filename="fathom-conversations-2026-11-06.json"/,
  );
  assert.deepEqual(parseConversationArchive(await response.json()), archive());
});

test("all row, reply, or UTF-8 overflow returns 413 without a partial download", async () => {
  const base = handlerFixture().source;
  for (const snapshot of [
    { ...base, overflow: true, conversations: null },
    { ...base, counts: { conversations: 501, replies: 0 }, conversations: null },
    { ...base, counts: { conversations: 1, replies: 5_001 }, conversations: null },
  ]) {
    const response = await handlerFixture(snapshot).request();
    assert.equal(response.status, 413);
    assert.equal(response.headers.has("content-disposition"), false);
    assert.match((await response.json()).message, /No partial archive/);
  }
  const value = archive();
  value.conversations = Array.from({ length: 270 }, (_, index) => ({
    ...value.conversations[0],
    id: `message-${index}`,
    text: "🌙".repeat(1_900),
    replies: [],
  }));
  value.counts = { conversations: 270, replies: 0 };
  assert.ok(JSON.stringify(value).length < CONVERSATION_EXPORT_LIMITS.bytes);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(value)).byteLength > CONVERSATION_EXPORT_LIMITS.bytes,
  );
  const response = await handlerFixture({
    exportedAt: stamp,
    counts: value.counts,
    conversations: value.conversations,
    overflow: false,
  }).request();
  assert.equal(response.status, 413);
  assert.equal(response.headers.has("content-disposition"), false);
});

async function sqlFixture() {
  const pg = new PGlite();
  await pg.exec('create table "user" (id text primary key)');
  for (const file of [
    "0007_creator_contact.sql",
    "0008_creator_payments.sql",
    "0009_inbox_activity.sql",
    "0010_contact_moderation.sql",
  ])
    await pg.exec(await readFile(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  await pg.query('insert into "user"(id) values ($1),($2),($3),($4)', [
    owner,
    sender,
    stranger,
    actor,
  ]);
  let calls = 0;
  const store = createSqlConversationExportStore({
    query: async <T>(text: string, params: unknown[] = []) => {
      calls++;
      return (await pg.query<T>(text, params)).rows;
    },
  });
  async function message(
    id: string,
    options: {
      recipient?: string;
      sender?: string | null;
      anonymous?: boolean;
      kind?: "dm" | "donation";
      status?: "free" | "paid" | "pending";
      name?: string;
      text?: string;
      moderationActor?: string | null;
    } = {},
  ) {
    const payment = ["paid", "pending"].includes(options.status ?? "free")
      ? `private-payment-${id}`
      : null;
    await pg.query(
      `insert into creator_messages(id,recipient_id,recipient_handle,sender_id,sender_name,anonymous,kind,body,payment_status,payment_id,created_at,moderation_actor_id)
      values($1,$2,'creator',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        options.recipient ?? owner,
        options.sender === undefined ? sender : options.sender,
        options.name ?? "Visible sender",
        options.anonymous ?? false,
        options.kind ?? "dm",
        options.text ?? "Hello 🌙",
        options.status ?? "free",
        payment,
        stamp,
        options.moderationActor ?? options.sender ?? sender,
      ],
    );
  }
  async function replies(messageId: string, count: number, prefix = "reply") {
    await pg.query(
      `insert into creator_message_replies(id,message_id,author_id,body,activity_revision,created_at)
      select $3 || '-' || n,$1,case when n%2=0 then $4 else $5 end,'Reply ' || n,n,$6::timestamptz+n*interval '1 second'
      from generate_series(1,$2::integer) n`,
      [messageId, count, prefix, owner, sender, stamp],
    );
    await pg.query(
      `update creator_messages set activity_revision=$2::integer,last_activity_at=$3::timestamptz+$2::integer*interval '1 second' where id=$1`,
      [messageId, count, stamp],
    );
  }
  return { pg, store, message, replies, calls: () => calls };
}

test("SQL conversation archives are owner-scoped, complete snapshots with bounded memory", async (t) => {
  const f = await sqlFixture();
  const clear = () => f.pg.exec("truncate creator_messages cascade");
  try {
    await t.test(
      "only currently accessible messages are selected, without private identities or payment fields",
      async () => {
        await f.message("received");
        await f.message("sent", { recipient: sender, sender: owner });
        await f.message("pending-sent", { recipient: sender, sender: owner, status: "pending" });
        await f.message("pending-received", { status: "pending", text: "HIDDEN-PENDING-BODY" });
        await f.message("stranger-thread", { recipient: stranger, text: "HIDDEN-STRANGER-BODY" });
        await f.message("anonymous-sent", {
          recipient: stranger,
          sender: null,
          anonymous: true,
          kind: "donation",
          status: "paid",
          moderationActor: owner,
          text: "HIDDEN-ANONYMOUS-SENT",
        });
        await f.message("anonymous-received", {
          sender: null,
          anonymous: true,
          kind: "donation",
          status: "paid",
          moderationActor: actor,
          name: "HIDDEN-ANONYMOUS-NAME",
        });
        await f.replies("received", 2);
        const before = await f.pg.query(
          "select id,recipient_read_at,sender_read_at,recipient_read_revision,sender_read_revision from creator_messages order by id",
        );
        const calls = f.calls();
        const snapshot = await f.store.readSnapshot(owner);
        assert.equal(f.calls(), calls + 1);
        const response = await handlerFixture(snapshot).request();
        assert.equal(response.status, 200);
        const raw = await response.text();
        const value = parseConversationArchive(JSON.parse(raw));
        assert.deepEqual(
          new Set(value.conversations.map((row) => row.id)),
          new Set(["received", "sent", "pending-sent", "anonymous-received"]),
        );
        assert.deepEqual(value.counts, { conversations: 4, replies: 2 });
        assert.equal(
          value.conversations.find((row) => row.id === "anonymous-received")?.senderName,
          "Anonymous",
        );
        assert.equal(
          value.conversations.find((row) => row.id === "pending-sent")?.direction,
          "sent",
        );
        assert.deepEqual(
          value.conversations
            .find((row) => row.id === "received")
            ?.replies.map((reply) => reply.fromCreator),
          [false, true],
        );
        for (const secret of [
          owner,
          sender,
          stranger,
          actor,
          "private-payment",
          "HIDDEN-",
          "senderId",
          "recipientId",
          "authorId",
          "moderationActor",
          "paymentId",
        ])
          assert.equal(raw.includes(secret), false, `Private field or value appeared: ${secret}`);
        assert.deepEqual(
          (
            await f.pg.query(
              "select id,recipient_read_at,sender_read_at,recipient_read_revision,sender_read_revision from creator_messages order by id",
            )
          ).rows,
          before.rows,
        );
      },
    );
    await t.test(
      "all replies are exported without the inbox display limit and later writes do not alter the snapshot",
      async () => {
        await clear();
        await f.message("history");
        await f.replies("history", 205);
        const snapshot = await f.store.readSnapshot(owner);
        const value = parseConversationArchive(
          await (await handlerFixture(snapshot).request()).json(),
        );
        assert.equal(value.conversations[0].replies.length, 205);
        assert.equal(value.counts.replies, 205);
        await f.pg.query(
          `insert into creator_message_replies(id,message_id,author_id,body,activity_revision) values('late-reply','history',$1,'Late reply',206)`,
          [owner],
        );
        const frozen = parseConversationArchive(
          await (await handlerFixture(snapshot).request()).json(),
        );
        assert.equal(frozen.counts.replies, 205);
        const next = await f.store.readSnapshot(owner);
        assert.equal(next.counts.replies, 206);
        assert.ok(new Date(next.exportedAt).getTime() >= new Date(snapshot.exportedAt).getTime());
      },
    );
    await t.test("empty inboxes are explicitly complete", async () => {
      await clear();
      const snapshot = await f.store.readSnapshot(owner);
      const response = await handlerFixture(snapshot).request();
      assert.equal(response.status, 200);
      const value = parseConversationArchive(await response.json());
      assert.deepEqual(value.counts, { conversations: 0, replies: 0 });
      assert.deepEqual(value.conversations, []);
      assert.equal(value.complete, true);
    });
    await t.test(
      "conversation and reply sentinel limits reject the archive instead of slicing it",
      async () => {
        await clear();
        await f.pg.query(
          `insert into creator_messages(id,recipient_id,recipient_handle,sender_id,sender_name,anonymous,kind,body,payment_status)
        select 'message-' || n,$1,'creator',$2,'Visible sender',false,'dm','Hello','free' from generate_series(1,500) n`,
          [owner, sender],
        );
        const full = await f.store.readSnapshot(owner);
        assert.equal((await handlerFixture(full).request()).status, 200);
        await f.message("message-501");
        const overflow = await f.store.readSnapshot(owner);
        assert.equal(overflow.overflow, true);
        assert.equal(overflow.conversations, null);
        assert.equal((await handlerFixture(overflow).request()).status, 413);
        await clear();
        await f.message("reply-overflow");
        await f.replies("reply-overflow", 5_001);
        const replyOverflow = await f.store.readSnapshot(owner);
        assert.equal(replyOverflow.counts.replies, 5_001);
        assert.equal(replyOverflow.conversations, null);
        assert.equal((await handlerFixture(replyOverflow).request()).status, 413);
      },
    );
    await t.test(
      "UTF-8 is bounded before aggregation and again on the final attachment",
      async () => {
        await clear();
        const text = "🌙".repeat(1_900);
        await f.pg.query(
          `insert into creator_messages(id,recipient_id,recipient_handle,sender_id,sender_name,anonymous,kind,body,payment_status)
        select 'large-' || n,$1,'creator',$2,'Visible sender',false,'dm',$3,'free' from generate_series(1,270) n`,
          [owner, sender, text],
        );
        const nearLimit = await f.store.readSnapshot(owner);
        assert.equal(nearLimit.overflow, false);
        assert.equal((await handlerFixture(nearLimit).request()).status, 413);
        await f.pg.query(
          `insert into creator_messages(id,recipient_id,recipient_handle,sender_id,sender_name,anonymous,kind,body,payment_status)
        select 'large-' || n,$1,'creator',$2,'Visible sender',false,'dm',$3,'free' from generate_series(271,300) n`,
          [owner, sender, text],
        );
        const overflow = await f.store.readSnapshot(owner);
        assert.equal(overflow.overflow, true);
        assert.equal(overflow.conversations, null);
        assert.equal((await handlerFixture(overflow).request()).status, 413);
      },
    );
  } finally {
    await f.pg.close();
  }
});
