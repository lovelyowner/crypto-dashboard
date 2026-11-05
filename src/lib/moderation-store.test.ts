import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { DEFAULT_CREATOR_PROFILE } from "./creator-profile";
import { DEFAULT_CONTACT_SETTINGS } from "./creator-contact";
import { createSqlContactStore, contactMessageDto } from "./contact-store";
import { createSqlPaymentStore } from "./payment-store";
import { createSqlModerationStore } from "./moderation-store";
import { isContactBlockedError } from "./moderation";

async function fixture() {
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../../migrations/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(await readFile(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  for (const userId of ["owner", "sender", "other"])
    await pg.query(
      'insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,true,now(),now())',
      [userId, `${userId}@example.com`],
    );
  await pg.query(
    "insert into public_creator_profiles(user_id,handle,profile) values('owner','creator',$1::jsonb)",
    [JSON.stringify(DEFAULT_CREATOR_PROFILE)],
  );
  const sql = {
    query: async <T>(text: string, params: unknown[] = []) =>
      (await pg.query<T>(text, params)).rows,
  };
  const contacts = createSqlContactStore(sql);
  const moderation = createSqlModerationStore(sql);
  const payments = createSqlPaymentStore(sql);
  await contacts.saveSettings("owner", { ...DEFAULT_CONTACT_SETTINGS, dmMode: "free" });
  const send = (senderId = "sender") =>
    contacts.createFreeMessage({
      recipientId: "owner",
      senderId,
      senderName: senderId,
      anonymous: false,
      kind: "dm",
      text: "Private original",
    });
  const draft = async (anonymous = false, actorId?: string) => {
    const id = randomUUID(),
      messageId = randomUUID();
    const message = await contacts.createPendingMessage({
      id: messageId,
      paymentId: id,
      recipientId: "owner",
      senderId: anonymous ? null : "sender",
      senderName: anonymous ? "Anonymous" : "Sender",
      anonymous,
      kind: anonymous ? "donation" : "dm",
      text: "Pending private message",
      moderationActorId: actorId,
    });
    return { id, messageId, message };
  };
  const intent = (draft: { id: string; messageId: string }, anonymous = false) =>
    payments.create({
      ...draft,
      recipientId: "owner",
      senderId: anonymous ? null : "sender",
      capabilityHash: anonymous ? "a".repeat(64) : null,
      kind: anonymous ? "donation" : "dm",
      method: "ethereum",
      amount: "0.01",
      recipientAddress: "0x52908400098527886e0f7030069857d2e4169ee7",
      amountWei: "10000000000000000",
      nonceData: `0x${"b".repeat(64)}`,
      credentialId: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
  return { pg, contacts, moderation, payments, send, draft, intent };
}

test("SQL blocks both directions for new free/paid contact and all reply paths while preserving history", async () => {
  const f = await fixture();
  try {
    const message = (await f.send())!;
    assert.equal(await f.moderation.setBlocked("other", message.id, true), false);
    assert.equal(await f.moderation.setBlocked("owner", message.id, true), true);
    await assert.rejects(f.send(), isContactBlockedError);
    await assert.rejects(f.draft(), isContactBlockedError);
    for (const author of ["owner", "sender"])
      await assert.rejects(
        f.contacts.reply(author, message.id, "Blocked reply"),
        isContactBlockedError,
      );
    await assert.rejects(
      f.pg.query(
        "insert into creator_message_replies(id,message_id,author_id,body) values('legacy',$1,'sender','Older server reply')",
        [message.id],
      ),
      isContactBlockedError,
    );
    const history = (await f.contacts.readThread("sender", message.id, false))!;
    assert.equal(history.message.activityRevision, 0);
    assert.deepEqual(history.replies, []);
    assert.equal((await f.contacts.listMessages("owner", "received", null)).messages.length, 1);
    assert.equal(await f.moderation.setBlocked("sender", message.id, true), true);
    assert.equal(await f.moderation.setBlocked("owner", message.id, false), true);
    assert.equal((await f.moderation.state("owner", message.id))?.blocked, false);
    assert.equal((await f.moderation.state("sender", message.id))?.blocked, true);
    await assert.rejects(f.send(), isContactBlockedError);
    await f.moderation.setBlocked("sender", message.id, false);
    assert.ok(await f.send());
  } finally {
    await f.pg.close();
  }
});

test("SQL guards quotes after draft creation and preserves old pending payment settlement and proofs", async () => {
  const f = await fixture();
  try {
    const history = (await f.send())!;
    const old = await f.draft();
    await f.intent(old);
    const raceDraft = await f.draft();
    await f.moderation.setBlocked("owner", history.id, true);
    await assert.rejects(f.intent(raceDraft), isContactBlockedError);
    await f.contacts.discardPendingMessage!(raceDraft.messageId, raceDraft.id);
    assert.equal(await f.contacts.readInternalMessage(raceDraft.messageId), null);
    assert.equal(await f.payments.confirm(old.id, "ethereum:1:old-proof", 3), true);
    assert.equal(await f.payments.confirm(old.id, "ethereum:1:old-proof", 3), true);
    await f.contacts.discardPendingMessage!(old.messageId, old.id);
    assert.equal(
      (await f.contacts.readThread("owner", old.messageId))?.message.paymentStatus,
      "paid",
    );
    assert.equal((await f.pg.query("select * from creator_payment_proofs")).rows.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("known anonymous actors obey blocks without exposing identity, and truly anonymous notes stay reportable", async () => {
  const f = await fixture();
  try {
    const history = (await f.send())!;
    const anonymousBeforeBlock = await f.draft(true, "sender");
    await f.intent(anonymousBeforeBlock, true);
    const anonymousRace = await f.draft(true, "sender");
    await f.moderation.setBlocked("owner", history.id, true);
    await assert.rejects(f.draft(true, "sender"), isContactBlockedError);
    await assert.rejects(f.intent(anonymousRace, true), isContactBlockedError);
    assert.equal(
      await f.payments.confirm(anonymousBeforeBlock.id, "ethereum:1:anonymous-old-proof", 3),
      true,
    );
    const loggedOut = await f.draft(true);
    await f.intent(loggedOut, true);
    await f.payments.confirm(loggedOut.id, "ethereum:1:anonymous-new-proof", 3);
    const dto = contactMessageDto(
      (await f.contacts.readThread("owner", anonymousBeforeBlock.messageId))!.message,
      "owner",
    );
    assert.equal(dto.anonymous, true);
    assert.equal(JSON.stringify(dto).includes("moderationActor"), false);
    assert.deepEqual(await f.moderation.state("owner", anonymousBeforeBlock.messageId), {
      canBlock: false,
      blocked: false,
      canReport: true,
      reported: false,
    });
    assert.equal(
      await f.moderation.setBlocked("owner", anonymousBeforeBlock.messageId, true),
      false,
    );
    assert.equal(
      await f.moderation.report("owner", anonymousBeforeBlock.messageId, "spam", "Anonymous note"),
      true,
    );
    const report = (await f.moderation.listReports("open"))[0];
    assert.equal(JSON.stringify(report).includes("moderation_actor_id"), false);
    assert.equal(
      (
        await f.pg.query<{ target_id: string | null }>(
          "select target_id from creator_contact_reports",
        )
      ).rows[0].target_id,
      null,
    );
  } finally {
    await f.pg.close();
  }
});

test("reports are participant scoped, deduplicated, bounded and snapshot evidence for the private queue", async () => {
  const f = await fixture();
  try {
    const message = (await f.send())!;
    await f.contacts.reply("owner", message.id, "Creator reply");
    assert.equal(await f.moderation.report("other", message.id, "scam", "Outsider"), false);
    assert.equal(await f.moderation.report("owner", message.id, "spam", "First report"), true);
    assert.equal(
      await f.moderation.report(
        "owner",
        message.id,
        "other",
        "Duplicate cannot overwrite evidence",
      ),
      true,
    );
    assert.equal((await f.moderation.state("owner", message.id))?.reported, true);
    assert.equal((await f.moderation.state("sender", message.id))?.reported, false);
    const reports = await f.moderation.listReports("open");
    assert.equal(reports.length, 1);
    assert.equal(reports[0].details, "First report");
    assert.equal(reports[0].replies[0].text, "Creator reply");
    for (const field of ["reporter_id", "reporterId", "target_id", "senderId", "recipientId"])
      assert.equal(JSON.stringify(reports).includes(field), false);
    const pending = await f.draft();
    assert.equal(await f.moderation.state("owner", pending.messageId), null);
    assert.equal(
      await f.moderation.report("owner", pending.messageId, "spam", "Hidden pending"),
      false,
    );
    assert.equal(await f.moderation.consumeLimit("report:owner", 2, 3600), true);
    assert.equal(await f.moderation.consumeLimit("report:owner", 2, 3600), true);
    assert.equal(await f.moderation.consumeLimit("report:owner", 2, 3600), false);
    assert.equal(await f.moderation.review("other", reports[0].id, "reviewed"), true);
    assert.equal((await f.moderation.listReports("reviewed")).length, 1);
  } finally {
    await f.pg.close();
  }
});
