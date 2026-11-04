import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { DEFAULT_CREATOR_PROFILE } from "./creator-profile";
import { DEFAULT_CONTACT_SETTINGS } from "./creator-contact";
import { createSqlContactStore, contactMessageDto } from "./contact-store";

async function fixture() {
  const pg = new PGlite();
  await pg.exec('create table "user" (id text primary key)');
  for (const file of ["0006_public_profiles.sql", "0007_creator_contact.sql"])
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
    assert.equal(await store.markRead("sender", message.id), false);
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
