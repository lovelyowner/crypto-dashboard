import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { DEFAULT_CREATOR_PROFILE } from "./creator-profile";
import { DEFAULT_CONTACT_SETTINGS } from "./creator-contact";
import { createSqlContactStore, contactMessageDto } from "./contact-store";

async function fixture(applyActivity = true) {
  const pg = new PGlite();
  await pg.exec('create table "user" (id text primary key)');
  for (const file of [
    "0006_public_profiles.sql",
    "0007_creator_contact.sql",
    "0008_creator_payments.sql",
    ...(applyActivity ? ["0009_inbox_activity.sql"] : []),
    "0010_contact_moderation.sql",
  ])
    await pg.exec(await readFile(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  await pg.query('insert into "user"(id) values ($1),($2),($3)', ["owner", "sender", "other"]);
  const profile = {
    ...structuredClone(DEFAULT_CREATOR_PROFILE),
    displayName: "Creator",
    donations: {
      bankLink: "",
      crypto: [
        {
          id: "eth",
          chain: "ethereum",
          address: "0x0000000000000000000000000000000000000001",
          label: "ETH",
        },
      ],
    },
  };
  await pg.query(
    "insert into public_creator_profiles(user_id,handle,profile) values($1,$2,$3::jsonb)",
    ["owner", "creator", JSON.stringify(profile)],
  );
  const store = createSqlContactStore({
    query: async <T>(text: string, params: unknown[] = []) =>
      (await pg.query<T>(text, params)).rows,
  });
  return { pg, store };
}
test("contact SQL isolates private participants and protects paid mode against free-message and reply bypasses", async () => {
  const { pg, store } = await fixture();
  try {
    assert.equal((await store.resolveRecipient("creator"))?.recipientUserId, "owner");
    assert.equal(await store.resolveRecipient("missing"), null);
    await store.saveSettings("owner", { ...DEFAULT_CONTACT_SETTINGS, dmMode: "free" });
    const message = await store.createFreeMessage({
      recipientId: "owner",
      senderId: "sender",
      senderName: "Sender 🌙",
      anonymous: false,
      kind: "dm",
      text: "Hello creator",
    });
    assert.ok(message);
    assert.equal((await store.listMessages("owner", "received", null)).messages.length, 1);
    assert.equal((await store.listMessages("sender", "sent", null)).messages.length, 1);
    assert.equal(await store.readThread("other", message.id), null);
    assert.ok((await store.readThread("owner", message.id))?.message.readAt);
    assert.equal(await store.reply("sender", message.id, "A follow-up"), true);
    await store.saveSettings("owner", {
      ...DEFAULT_CONTACT_SETTINGS,
      dmMode: "paid",
      dmUsdPrice: "5.00",
    });
    assert.equal(
      await store.createFreeMessage({
        recipientId: "owner",
        senderId: "sender",
        senderName: "Sender",
        anonymous: false,
        kind: "dm",
        text: "Should not arrive",
      }),
      null,
    );
    assert.equal(await store.reply("sender", message.id, "Should not arrive"), false);
    assert.equal(await store.reply("owner", message.id, "Creator reply is free"), true);
    assert.equal(await store.reply("other", message.id, "Other account"), false);
    const dto = contactMessageDto(message, "owner");
    assert.equal("senderId" in dto, false);
    assert.equal("recipientId" in dto, false);
    assert.equal("paymentId" in dto, false);
    assert.equal(await store.markRead("sender", message.id), true);
  } finally {
    await pg.close();
  }
});
test("pending paid and anonymous donation messages stay hidden until the exact payment settles, idempotently", async () => {
  const { pg, store } = await fixture();
  try {
    const pending = await store.createPendingMessage({
      id: "pending-dm",
      paymentId: "payment-1",
      recipientId: "owner",
      senderId: "sender",
      senderName: "Sender",
      anonymous: false,
      kind: "dm",
      text: "Paid DM",
    });
    assert.equal((await store.listMessages("owner", "received", null)).messages.length, 0);
    assert.equal(await store.readThread("owner", pending.id), null);
    assert.equal(
      contactMessageDto((await store.listMessages("sender", "sent", null)).messages[0], "sender")
        .paymentId,
      "payment-1",
    );
    assert.equal(await store.completePendingMessage(pending.id, "wrong"), false);
    assert.equal(await store.completePendingMessage(pending.id, "payment-1"), true);
    assert.equal(await store.completePendingMessage(pending.id, "payment-1"), true);
    assert.equal((await store.listMessages("owner", "received", null)).messages.length, 1);
    const anonymous = await store.createPendingMessage({
      id: "anonymous-tip",
      paymentId: "payment-2",
      recipientId: "owner",
      senderId: null,
      senderName: "DO NOT STORE",
      anonymous: true,
      kind: "donation",
      text: "Thanks 🌙",
    });
    assert.equal(anonymous.senderId, null);
    assert.equal(anonymous.senderName, "Anonymous");
    assert.equal((await store.listMessages("owner", "donations", null)).messages.length, 0);
    await store.completePendingMessage(anonymous.id, "payment-2");
    assert.equal((await store.listMessages("owner", "donations", null)).messages.length, 1);
    assert.equal(await store.reply("owner", anonymous.id, "Cannot contact anonymous donor"), false);
    await assert.rejects(
      store.createPendingMessage({
        id: "bad",
        paymentId: "payment-3",
        recipientId: "owner",
        senderId: "sender",
        senderName: "Name",
        anonymous: true,
        kind: "donation",
        text: "Hi",
      }),
    );
    await pg.query('delete from "user" where id=$1', ["owner"]);
    assert.equal((await pg.query("select * from creator_messages")).rows.length, 0);
  } finally {
    await pg.close();
  }
});
test("shared message throttle atomically enforces its limit and resets by server time", async () => {
  const { pg, store } = await fixture();
  try {
    const first = Date.now();
    const results = await Promise.all(
      Array.from({ length: 15 }, () => store.consumeRate("opaque-source", 10, first)),
    );
    assert.equal(results.filter(Boolean).length, 10);
    assert.equal(await store.consumeRate("different-source", 10, first), true);
    assert.equal(await store.consumeRate("opaque-source", 10, first + 60_001), true);
  } finally {
    await pg.close();
  }
});

test("new replies update activity and each participant's own unread state", async () => {
  const { pg, store } = await fixture();
  try {
    await store.saveSettings("owner", { ...DEFAULT_CONTACT_SETTINGS, dmMode: "free" });
    const send = async (text: string) =>
      (await store.createFreeMessage({
        recipientId: "owner",
        senderId: "sender",
        senderName: "Sender 🌙",
        anonymous: false,
        kind: "dm",
        text,
      }))!;
    const first = await send("Original first message");
    assert.deepEqual(await store.unreadCounts!("owner"), { received: 1, sent: 0, donations: 0 });
    assert.deepEqual(await store.unreadCounts!("sender"), { received: 0, sent: 0, donations: 0 });
    await store.markRead("sender", first.id);
    assert.equal((await store.unreadCounts!("owner")).received, 1);
    await store.readThread("owner", first.id);
    assert.equal((await store.unreadCounts!("owner")).received, 0);
    const second = await send("A newer conversation");
    assert.equal((await store.listMessages("owner", "received", null)).messages[0].id, second.id);
    assert.equal(await store.reply("sender", first.id, "Latest follow-up 🌙"), true);
    const received = await store.listMessages("owner", "received", null);
    assert.equal(received.messages[0].id, first.id);
    const receivedDto = contactMessageDto(received.messages[0], "owner");
    assert.equal(receivedDto.unread, true);
    assert.equal(receivedDto.latestReply?.text, "Latest follow-up 🌙");
    assert.equal(receivedDto.latestReply?.fromCreator, false);
    assert.equal((await store.unreadCounts!("owner")).received, 2);
    assert.equal(await store.reply("owner", first.id, "Creator reply"), true);
    const sent = contactMessageDto(
      (await store.listMessages("sender", "sent", null)).messages[0],
      "sender",
    );
    assert.equal(sent.unread, true);
    assert.equal(sent.latestReply?.fromCreator, true);
    assert.equal((await store.unreadCounts!("owner")).received, 1);
    assert.equal((await store.unreadCounts!("sender")).sent, 1);
    const senderThread = await store.readThread("sender", first.id);
    assert.equal(contactMessageDto(senderThread!.message, "sender").unread, false);
    assert.equal((await store.unreadCounts!("sender")).sent, 0);
    assert.equal(await store.markRead("other", first.id), false);
    assert.deepEqual(await store.unreadCounts!("other"), { received: 0, sent: 0, donations: 0 });
    const pending = await store.createPendingMessage({
      id: "paid-later",
      paymentId: "paid-later-payment",
      recipientId: "owner",
      senderId: null,
      senderName: "Hidden",
      anonymous: true,
      kind: "donation",
      text: "Anonymous paid note",
    });
    assert.equal((await store.unreadCounts!("owner")).donations, 0);
    await store.completePendingMessage(pending.id, pending.paymentId!);
    assert.equal((await store.unreadCounts!("owner")).donations, 1);
    assert.equal((await store.unreadCounts!("owner")).received, 1);
    const donation = contactMessageDto(
      (await store.listMessages("owner", "donations", null)).messages[0],
      "owner",
    );
    assert.equal(donation.senderName, "Anonymous");
    assert.equal(donation.unread, true);
    assert.equal("senderId" in donation, false);
  } finally {
    await pg.close();
  }
});

test("reading a thread marks only the loaded revision and keeps an unseen concurrent reply unread", async () => {
  const { pg, store } = await fixture();
  try {
    await store.saveSettings("owner", { ...DEFAULT_CONTACT_SETTINGS, dmMode: "free" });
    const message = (await store.createFreeMessage({
      recipientId: "owner",
      senderId: "sender",
      senderName: "Sender",
      anonymous: false,
      kind: "dm",
      text: "Original",
    }))!;
    let inject = true;
    const observed = createSqlContactStore({
      query: async <T>(text: string, params: unknown[] = []) => {
        const result = await pg.query<T>(text, params);
        if (inject) {
          inject = false;
          assert.equal(await store.reply("sender", message.id, "Arrived after the snapshot"), true);
        }
        return result.rows;
      },
    });
    const snapshot = await observed.readThread("owner", message.id);
    assert.deepEqual(snapshot!.replies, []);
    assert.equal(snapshot!.message.activityRevision, 0);
    assert.equal(contactMessageDto(snapshot!.message, "owner").unread, false);
    assert.equal((await store.unreadCounts!("owner")).received, 1);
    assert.equal(
      contactMessageDto((await store.listMessages("owner", "received", null)).messages[0], "owner")
        .unread,
      true,
    );
    const refreshed = await store.readThread("owner", message.id);
    assert.equal(refreshed!.replies[0].text, "Arrived after the snapshot");
    assert.equal((await store.unreadCounts!("owner")).received, 0);
  } finally {
    await pg.close();
  }
});

test("activity pagination preserves microseconds and a stable boundary when the last row gets a reply", async () => {
  const { pg, store } = await fixture();
  try {
    await store.saveSettings("owner", { ...DEFAULT_CONTACT_SETTINGS, dmMode: "free" });
    await pg.exec(`insert into creator_messages(id,recipient_id,recipient_handle,sender_id,sender_name,anonymous,kind,body,payment_status,created_at,last_activity_at)
      select 'page-'||lpad(n::text,3,'0'),'owner','creator','sender','Sender',false,'dm','Message '||n,'free',
      '2026-11-04T10:00:00.000000Z'::timestamptz,
      '2026-11-04T10:00:00.000000Z'::timestamptz+n*interval '1 microsecond' from generate_series(0,55) n`);
    const first = await store.listMessages("owner", "received", null);
    assert.equal(first.messages.length, 50);
    assert.equal(first.messages[49].id, "page-006");
    assert.ok(first.nextCursor?.startsWith("v1_"));
    assert.match(Buffer.from(first.nextCursor!.slice(3), "base64url").toString(), /\.000006Z/);
    await store.reply("sender", "page-006", "Move the boundary conversation to the top");
    const second = await store.listMessages("owner", "received", first.nextCursor);
    assert.deepEqual(
      second.messages.map((m) => m.id),
      ["page-005", "page-004", "page-003", "page-002", "page-001", "page-000"],
    );
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.messages, ...second.messages].map((m) => m.id)).size, 56);
    assert.equal(
      (await store.listMessages("other", "received", first.nextCursor)).messages.length,
      0,
    );
    assert.equal((await store.listMessages("other", "received", "page-006")).messages.length, 0);
  } finally {
    await pg.close();
  }
});

test("concurrent replies cannot exceed the conversation limit or reuse an activity revision", async () => {
  const { pg, store } = await fixture();
  try {
    await store.saveSettings("owner", { ...DEFAULT_CONTACT_SETTINGS, dmMode: "free" });
    const message = (await store.createFreeMessage({
      recipientId: "owner",
      senderId: "sender",
      senderName: "Sender",
      anonymous: false,
      kind: "dm",
      text: "Original",
    }))!;
    await pg.query(
      `insert into creator_message_replies(id,message_id,author_id,body,activity_revision)
      select 'seed-'||n,$1,'owner','Reply '||n,n from generate_series(1,199) n`,
      [message.id],
    );
    await pg.query("update creator_messages set activity_revision=199 where id=$1", [message.id]);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        store.reply(n % 2 ? "owner" : "sender", message.id, `Concurrent ${n}`),
      ),
    );
    assert.equal(outcomes.filter(Boolean).length, 1);
    const thread = await store.readThread("owner", message.id, false);
    assert.equal(thread!.message.activityRevision, 200);
    assert.equal(thread!.replies.length, 200);
    assert.equal(await store.reply("owner", message.id, "Over limit"), false);
  } finally {
    await pg.close();
  }
});

test("activity migration backfills existing replies and accepts legacy inserts during deployment", async () => {
  const { pg, store } = await fixture(false);
  try {
    await pg.exec(`insert into creator_messages(id,recipient_id,recipient_handle,sender_id,sender_name,anonymous,kind,body,payment_status,created_at,recipient_read_at)
      values('existing','owner','creator','sender','Sender',false,'dm','Original','free','2026-11-04T10:00:00Z','2026-11-04T10:00:01Z');
      insert into creator_message_replies(id,message_id,author_id,body,created_at) values
      ('old-1','existing','owner','Creator first','2026-11-04T10:00:01Z'),
      ('old-2','existing','sender','Sender reply','2026-11-04T10:00:02Z'),
      ('old-3','existing','owner','Creator latest','2026-11-04T10:00:03Z')`);
    const migration = await readFile(
      new URL("../../migrations/0009_inbox_activity.sql", import.meta.url),
      "utf8",
    );
    await pg.exec(migration);
    const owner = contactMessageDto(
      (await store.listMessages("owner", "received", null)).messages[0],
      "owner",
    );
    const sender = contactMessageDto(
      (await store.listMessages("sender", "sent", null)).messages[0],
      "sender",
    );
    assert.equal(owner.unread, false);
    assert.equal(sender.unread, true);
    assert.equal(owner.latestReply?.id, "old-3");
    assert.equal(owner.lastActivityAt, "2026-11-04T10:00:03.000Z");
    assert.equal(sender.readAt, "2026-11-04T10:00:02.000Z");
    await pg.exec(
      "insert into creator_message_replies(id,message_id,author_id,body) values('legacy-insert','existing','sender','Legacy deployment reply')",
    );
    const updated = (await store.listMessages("owner", "received", null)).messages[0];
    assert.equal(updated.activityRevision, 4);
    assert.equal(updated.latestReply?.id, "legacy-insert");
    assert.equal(contactMessageDto(updated, "owner").unread, true);
    await store.readThread("owner", "existing");
    await pg.exec(migration);
    assert.equal(
      contactMessageDto((await store.listMessages("owner", "received", null)).messages[0], "owner")
        .unread,
      false,
    );
    assert.equal((await store.readThread("owner", "existing", false))!.message.activityRevision, 4);
  } finally {
    await pg.close();
  }
});

test("inbox page rows and counts retain one snapshot when a concurrent read changes live counts", async () => {
  const { pg, store } = await fixture();
  try {
    await store.saveSettings("owner", { ...DEFAULT_CONTACT_SETTINGS, dmMode: "free" });
    const send = async (text: string) =>
      (await store.createFreeMessage({
        recipientId: "owner",
        senderId: "sender",
        senderName: "Sender",
        anonymous: false,
        kind: "dm",
        text,
      }))!;
    const first = await send("Unread A");
    await send("Unread B");
    let queries = 0;
    const observed = createSqlContactStore({
      query: async <T>(text: string, params: unknown[] = []) => {
        const result = await pg.query<T>(text, params);
        if (++queries === 1) await store.readThread("owner", first.id);
        return result.rows;
      },
    });
    const page = await observed.listMessages("owner", "received", null);
    assert.equal(queries, 1);
    assert.deepEqual(page.unreadCounts, { received: 2, sent: 0, donations: 0 });
    assert.equal(
      page.messages.filter((message) => contactMessageDto(message, "owner").unread).length,
      2,
    );
    assert.equal((await store.unreadCounts!("owner")).received, 1);
    const updated = await store.listMessages("owner", "received", null);
    assert.equal(updated.unreadCounts!.received, 1);
    assert.equal(
      updated.messages.filter((message) => contactMessageDto(message, "owner").unread).length,
      1,
    );
    const empty = await store.listMessages("owner", "donations", null);
    assert.deepEqual(empty.messages, []);
    assert.deepEqual(empty.unreadCounts, { received: 1, sent: 0, donations: 0 });
    assert.deepEqual((await store.listMessages("other", "received", null)).unreadCounts, {
      received: 0,
      sent: 0,
      donations: 0,
    });
  } finally {
    await pg.close();
  }
});
