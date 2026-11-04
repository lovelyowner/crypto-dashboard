import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createSqlPaymentStore, PaymentProofConflictError } from "./payment-store";
import { createSqlContactStore } from "./contact-store";
import { DEFAULT_CREATOR_PROFILE } from "./creator-profile";

export async function paymentFixture() {
  const pg = new PGlite();
  for (const name of (await readdir(new URL("../../migrations/", import.meta.url)))
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await pg.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  for (const id of ["owner", "sender", "other"])
    await pg.query(
      'insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,true,now(),now())',
      [id, `${id}@example.com`],
    );
  const profile = {
    ...structuredClone(DEFAULT_CREATOR_PROFILE),
    displayName: "Creator",
    donations: {
      bankLink: "",
      crypto: [
        {
          id: "eth",
          chain: "ethereum",
          address: "0x52908400098527886e0f7030069857d2e4169ee7",
          label: "ETH",
        },
      ],
    },
  };
  await pg.query(
    "insert into public_creator_profiles(user_id,handle,profile) values($1,$2,$3::jsonb)",
    ["owner", "creator", JSON.stringify(profile)],
  );
  const sql = {
    query: async <T>(text: string, params: unknown[] = []) =>
      (await pg.query<T>(text, params)).rows,
  };
  const store = createSqlPaymentStore(sql),
    contacts = createSqlContactStore(sql);
  const pending = async (senderId: string | null = "sender") => {
    const id = randomUUID(),
      messageId = randomUUID();
    await contacts.createPendingMessage({
      id: messageId,
      paymentId: id,
      recipientId: "owner",
      senderId,
      senderName: senderId ?? "Anonymous",
      anonymous: !senderId,
      kind: senderId ? "dm" : "donation",
      text: "A private paid message",
    });
    return store.create({
      id,
      messageId,
      recipientId: "owner",
      senderId,
      capabilityHash: senderId ? null : "a".repeat(64),
      kind: senderId ? "dm" : "donation",
      method: "ethereum",
      amount: "0.01",
      recipientAddress: profile.donations.crypto[0].address,
      amountWei: "10000000000000000",
      nonceData: `0x${"b".repeat(64)}`,
      credentialId: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
  };
  return { pg, sql, store, contacts, pending };
}

test("payment proof claim and exact pending message delivery are atomic, replay-safe and owner isolated", async () => {
  const f = await paymentFixture();
  try {
    const a = await f.pending(),
      b = await f.pending("other");
    assert.equal((await f.contacts.listMessages("owner", "received", null)).messages.length, 0);
    const outcomes = await Promise.allSettled([
      f.store.confirm(a.id, "ethereum:1:one-proof", 3),
      f.store.confirm(b.id, "ethereum:1:one-proof", 3),
    ]);
    assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
    const rejected = outcomes.find((x) => x.status === "rejected");
    assert.ok(
      rejected &&
        rejected.status === "rejected" &&
        rejected.reason instanceof PaymentProofConflictError,
    );
    const rows = await f.pg.query<{ status: string }>(
      "select status from creator_payment_intents order by status",
    );
    assert.deepEqual(
      rows.rows.map((x) => x.status),
      ["paid", "pending"],
    );
    const delivered = (await f.contacts.listMessages("owner", "received", null)).messages;
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].paymentStatus, "paid");
    const paid = (await f.store.read(a.id))!.status === "paid" ? a : b;
    assert.equal(await f.store.confirm(paid.id, "ethereum:1:one-proof", 3), true);
    assert.equal((await f.pg.query("select * from creator_payment_proofs")).rows.length, 1);
    assert.equal((await f.contacts.listMessages("owner", "received", null)).messages.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("newly verified messages use delivery activity and a repeated proof does not reorder the inbox", async () => {
  const f = await paymentFixture();
  try {
    const older = await f.pending();
    await f.pg.query(
      "update creator_messages set created_at='2020-01-01T00:00:00Z',last_activity_at='2020-01-01T00:00:00Z' where id=$1",
      [older.messageId],
    );
    const recent = await f.pending("other");
    await f.store.confirm(recent.id, "ethereum:1:recent-delivery", 3);
    assert.equal((await f.contacts.listMessages("owner", "received", null)).messages.length, 1);
    await f.store.confirm(older.id, "ethereum:1:older-delivery", 3);
    const delivered = (await f.contacts.listMessages("owner", "received", null)).messages;
    assert.deepEqual(
      delivered.map((message) => message.id),
      [older.messageId, recent.messageId],
    );
    const activity = async () =>
      (
        await f.pg.query<{ value: string }>(
          "select last_activity_at::text as value from creator_messages where id=$1",
          [older.messageId],
        )
      ).rows[0].value;
    const verifiedActivity = await activity();
    assert.ok(Date.parse(verifiedActivity) > Date.parse("2020-01-01T00:00:00Z"));
    await f.store.confirm(older.id, "ethereum:1:older-delivery", 3);
    assert.equal(await activity(), verifiedActivity);
  } finally {
    await f.pg.close();
  }
});

test("merchant credentials retain encrypted invoice versions and limits consume atomically", async () => {
  const f = await paymentFixture();
  try {
    await f.store.saveCredential({
      id: randomUUID(),
      userId: "owner",
      encrypted: "cipher-one",
      active: true,
    });
    const first = await f.store.credential("owner");
    assert.ok(first);
    await f.store.saveCredential({
      id: randomUUID(),
      userId: "owner",
      encrypted: "cipher-two",
      active: true,
    });
    const second = await f.store.credential("owner");
    assert.ok(second);
    assert.notEqual(first.id, second.id);
    assert.equal((await f.store.credentialById(first.id))!.active, false);
    assert.equal(await f.store.credential("other"), null);
    await f.store.disableCredentials("owner");
    assert.equal(await f.store.credential("owner"), null);
    assert.equal((await f.store.credentialById(first.id))!.encrypted, "cipher-one");
    const consume = await Promise.all(
      Array.from({ length: 5 }, () => f.store.consumeLimit("test-limit", 60, 3)),
    );
    assert.equal(consume.filter(Boolean).length, 3);
  } finally {
    await f.pg.close();
  }
});

test("a proof cannot mark an intent paid when its pending message ownership is inconsistent", async () => {
  const f = await paymentFixture();
  try {
    const payment = await f.pending();
    await f.pg.query("update creator_messages set recipient_id='other' where id=$1", [
      payment.messageId,
    ]);
    await assert.rejects(
      f.store.confirm(payment.id, "ethereum:1:inconsistent", 3),
      PaymentProofConflictError,
    );
    assert.equal((await f.store.read(payment.id))?.status, "pending");
    assert.equal((await f.pg.query("select * from creator_payment_proofs")).rows.length, 0);
  } finally {
    await f.pg.close();
  }
});
