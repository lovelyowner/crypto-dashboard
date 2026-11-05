import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { DEFAULT_CREATOR_PROFILE } from "./creator-profile";
import { DEFAULT_CONTACT_SETTINGS } from "./creator-contact";
import { createSqlContactStore } from "./contact-store";
import { createModerationHandler } from "./moderation-handler";
import { createSqlModerationStore } from "./moderation-store";

const origin = "https://fathom.example.com";
const now = Date.UTC(2026, 10, 5);
const owner = "creator-account-secret";
const sender = "sender-account-secret";
const outsider = "outsider-account-secret";
const reviewer = "reviewer-account-secret";

async function fixture(reviewerIds: string[] = [reviewer]) {
  const pg = new PGlite();
  await pg.exec('create table "user" (id text primary key)');
  for (const file of [
    "0006_public_profiles.sql",
    "0007_creator_contact.sql",
    "0008_creator_payments.sql",
    "0009_inbox_activity.sql",
    "0010_contact_moderation.sql",
  ])
    await pg.exec(await readFile(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  for (const userId of [owner, sender, outsider, reviewer])
    await pg.query('insert into "user"(id) values($1)', [userId]);
  await pg.query(
    "insert into public_creator_profiles(user_id,handle,profile) values($1,'creator',$2::jsonb)",
    [owner, JSON.stringify(DEFAULT_CREATOR_PROFILE)],
  );
  const sql = {
    query: async <T>(text: string, params: unknown[] = []) =>
      (await pg.query<T>(text, params)).rows,
  };
  const contacts = createSqlContactStore(sql);
  const store = createSqlModerationStore(sql);
  await contacts.saveSettings(owner, { ...DEFAULT_CONTACT_SETTINGS, dmMode: "free" });
  const send = () =>
    contacts.createFreeMessage({
      recipientId: owner,
      senderId: sender,
      senderName: "Sender display name",
      anonymous: false,
      kind: "dm",
      text: "Private message evidence",
    });
  const message = (await send())!;
  assert.ok(message);
  const handler = createModerationHandler({
    configured: true,
    allowedOrigins: [origin],
    reviewerIds,
    store,
    now: () => now,
    getSession: async (headers) => {
      const userId = headers.get("x-test-user");
      if (!userId) return null;
      return {
        user: { id: userId },
        session: {
          userId: headers.has("x-test-mismatch") ? outsider : userId,
          expiresAt: headers.has("x-test-invalid-expiry")
            ? "invalid"
            : new Date(now + (headers.has("x-test-expired") ? -1 : 60_000)),
        },
      };
    },
  });
  const request = (
    path: string,
    method = "GET",
    input?: unknown,
    userId: string | null = owner,
    headers: Record<string, string> = {},
  ) =>
    handler(
      new Request(origin + path, {
        method,
        headers: {
          origin,
          "content-type": "application/json",
          ...(userId ? { "x-test-user": userId } : {}),
          ...headers,
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }),
    );
  const moderation = `/api/inbox/${message.id}/moderation`;
  const reports = `/api/inbox/${message.id}/reports`;
  return { pg, contacts, store, send, message, request, moderation, reports };
}

test("moderation authenticates participants and rejects forged targets, unsafe origins and malformed payloads", async () => {
  const f = await fixture();
  try {
    const invalidSessions: Record<string, string>[] = [
      { "x-test-expired": "1" },
      { "x-test-invalid-expiry": "1" },
      { "x-test-mismatch": "1" },
    ];
    for (const headers of invalidSessions)
      assert.equal((await f.request(f.moderation, "GET", undefined, owner, headers)).status, 401);
    assert.equal((await f.request(f.moderation, "GET", undefined, null)).status, 401);
    assert.equal((await f.request(f.moderation, "GET", undefined, outsider)).status, 404);
    assert.equal((await f.request(f.moderation, "PUT", { blocked: true }, outsider)).status, 404);
    assert.equal(
      (await f.request(f.reports, "POST", { reason: "spam", details: "" }, outsider)).status,
      404,
    );
    const initial = await f.request(f.moderation);
    assert.deepEqual(await initial.json(), {
      canBlock: true,
      blocked: false,
      canReport: true,
      reported: false,
    });
    assert.match(initial.headers.get("cache-control")!, /private.*no-store/);
    assert.match(initial.headers.get("vary")!, /Cookie/);
    for (const input of [{ blocked: true, targetUserId: outsider }, { blocked: "true" }, {}])
      assert.equal((await f.request(f.moderation, "PUT", input)).status, 400);
    for (const input of [
      { reason: "spam", details: "", targetUserId: outsider },
      { reason: "invalid", details: "" },
      { reason: "spam", details: "x".repeat(1001) },
      { reason: "spam", details: "hidden\u0000text" },
      { reason: "spam", details: 12 },
      { reason: "spam" },
    ])
      assert.equal((await f.request(f.reports, "POST", input)).status, 400);
    const unsafeOrigins: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { origin: "" },
    ];
    for (const headers of unsafeOrigins)
      assert.equal(
        (await f.request(f.moderation, "PUT", { blocked: true }, owner, headers)).status,
        403,
      );
    assert.equal(
      (
        await f.request(f.moderation, "PUT", { blocked: true }, owner, {
          "content-type": "text/plain",
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await f.request(f.reports, "POST", { reason: "spam", details: "" }, owner, {
          "content-length": "8193",
        })
      ).status,
      413,
    );
    assert.equal((await f.request(f.moderation, "POST", {})).status, 405);
    assert.equal((await f.request("/api/inbox/missing/moderation")).status, 404);
    assert.equal((await f.pg.query("select * from creator_contact_reports")).rows.length, 0);
    const pairs = await f.pg.query<{ denied: boolean }>(
      "select low_blocked or high_blocked as denied from creator_contact_pairs",
    );
    assert.ok(pairs.rows.every((row) => !row.denied));
  } finally {
    await f.pg.close();
  }
});

test("reports deduplicate privately, retain evidence and expose review only to configured reviewers", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.contacts.reply(owner, f.message.id, "Creator reply evidence"), true);
    assert.equal(
      (await f.request(f.reports, "POST", { reason: "harassment", details: "  Context  " })).status,
      200,
    );
    assert.deepEqual(
      await (await f.request(f.reports, "POST", { reason: "scam", details: "Replacement" })).json(),
      { reported: true },
    );
    const own = await (await f.request(f.moderation)).json();
    const other = await (await f.request(f.moderation, "GET", undefined, sender)).json();
    assert.equal(own.reported, true);
    assert.equal(other.reported, false);
    assert.equal(JSON.stringify(own).includes(sender), false);
    const saved = await f.pg.query<{
      reporter_id: string;
      target_id: string;
      reason: string;
      details: string;
    }>("select reporter_id,target_id,reason,details from creator_contact_reports");
    assert.deepEqual(saved.rows, [
      { reporter_id: owner, target_id: sender, reason: "harassment", details: "Context" },
    ]);
    const rate = await f.pg.query<{ count: number }>(
      "select count from creator_moderation_limits where key=$1",
      [`report:${owner}`],
    );
    assert.equal(rate.rows[0].count, 1);
    assert.deepEqual(await (await f.request("/api/moderation/access")).json(), {
      canReview: false,
    });
    assert.deepEqual(
      await (await f.request("/api/moderation/access", "GET", undefined, reviewer)).json(),
      { canReview: true },
    );
    assert.equal((await f.request("/api/moderation/reports")).status, 403);
    const queueResponse = await f.request("/api/moderation/reports", "GET", undefined, reviewer);
    assert.equal(queueResponse.status, 200);
    assert.match(queueResponse.headers.get("cache-control")!, /no-store/);
    const queue = await queueResponse.json();
    assert.equal(queue.reports.length, 1);
    const report = queue.reports[0];
    assert.equal(report.messageId, f.message.id);
    assert.equal(report.status, "open");
    assert.deepEqual(report.message, {
      text: "Private message evidence",
      kind: "dm",
      anonymous: false,
    });
    assert.equal(report.replies[0].text, "Creator reply evidence");
    assert.equal(report.replies[0].fromCreator, true);
    for (const accountId of [owner, sender, reviewer])
      assert.equal(JSON.stringify(queue).includes(accountId), false);
    const reviewPath = `/api/moderation/reports/${report.id}`;
    assert.equal((await f.request(reviewPath, "PATCH", { status: "reviewed" })).status, 403);
    assert.equal(
      (
        await f.request(reviewPath, "PATCH", { status: "reviewed" }, reviewer, {
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    for (const input of [
      { status: "open" },
      { status: "reviewed", reporterId: owner },
      { status: "dismissed", targetId: sender },
    ])
      assert.equal((await f.request(reviewPath, "PATCH", input, reviewer)).status, 400);
    assert.deepEqual(
      await (await f.request(reviewPath, "PATCH", { status: "reviewed" }, reviewer)).json(),
      { updated: true },
    );
    assert.deepEqual(
      await (await f.request("/api/moderation/reports", "GET", undefined, reviewer)).json(),
      { reports: [] },
    );
    const reviewed = await (
      await f.request("/api/moderation/reports?status=reviewed", "GET", undefined, reviewer)
    ).json();
    assert.equal(reviewed.reports[0].id, report.id);
    assert.equal(reviewed.reports[0].status, "reviewed");
    assert.equal(
      (await f.request(reviewPath, "PATCH", { status: "dismissed" }, reviewer)).status,
      200,
    );
    assert.equal(
      (
        await f.request(
          "/api/moderation/reports/missing",
          "PATCH",
          { status: "dismissed" },
          reviewer,
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.request("/api/moderation/reports?status=invalid", "GET", undefined, reviewer))
        .status,
      400,
    );
    const audit = await f.pg.query<{ reviewer_id: string; status: string }>(
      "select reviewer_id,status from creator_contact_reports",
    );
    assert.deepEqual(audit.rows, [{ reviewer_id: reviewer, status: "dismissed" }]);
    assert.equal(
      (await (await f.request(f.moderation, "GET", undefined, sender)).json()).reported,
      false,
    );
  } finally {
    await f.pg.close();
  }
});

test("anonymous notes can be reported without revealing identity and pending recipients cannot moderate", async () => {
  const f = await fixture([]);
  try {
    await f.contacts.createPendingMessage({
      id: "anonymous-note",
      paymentId: "anonymous-payment",
      recipientId: owner,
      senderId: null,
      senderName: "Anonymous",
      anonymous: true,
      kind: "donation",
      text: "Anonymous note evidence",
    });
    assert.equal((await f.request("/api/inbox/anonymous-note/moderation")).status, 404);
    assert.equal(
      await f.contacts.completePendingMessage("anonymous-note", "anonymous-payment"),
      true,
    );
    const anonymousPath = "/api/inbox/anonymous-note/moderation";
    assert.deepEqual(await (await f.request(anonymousPath)).json(), {
      canBlock: false,
      blocked: false,
      canReport: true,
      reported: false,
    });
    assert.equal((await f.request(anonymousPath, "PUT", { blocked: true })).status, 403);
    assert.equal(
      (
        await f.request("/api/inbox/anonymous-note/reports", "POST", {
          reason: "spam",
          details: "Anonymous abuse",
        })
      ).status,
      200,
    );
    const report = await f.pg.query<{ target_id: string | null }>(
      "select target_id from creator_contact_reports where message_id='anonymous-note'",
    );
    assert.equal(report.rows[0].target_id, null);
    await f.contacts.createPendingMessage({
      id: "pending-message",
      paymentId: "pending-payment",
      recipientId: owner,
      senderId: sender,
      senderName: "Sender",
      anonymous: false,
      kind: "dm",
      text: "Pending private evidence",
    });
    for (const [suffix, method, input] of [
      ["moderation", "GET", undefined],
      ["moderation", "PUT", { blocked: true }],
      ["reports", "POST", { reason: "other", details: "Cannot see this message" }],
    ] as const)
      assert.equal(
        (await f.request(`/api/inbox/pending-message/${suffix}`, method, input)).status,
        404,
      );
    assert.equal(
      (await f.request("/api/inbox/pending-message/moderation", "GET", undefined, sender)).status,
      200,
    );
    assert.deepEqual(
      await (await f.request("/api/moderation/access", "GET", undefined, reviewer)).json(),
      { canReview: false },
    );
    assert.equal(
      (await f.request("/api/moderation/reports", "GET", undefined, reviewer)).status,
      403,
    );
  } finally {
    await f.pg.close();
  }
});

test("report and block limits bound new writes while duplicate report receipts remain available", async () => {
  const f = await fixture();
  try {
    const messages = [f.message];
    for (let i = 0; i < 10; i++) messages.push((await f.send())!);
    for (const message of messages.slice(0, 10))
      assert.equal(
        (
          await f.request(`/api/inbox/${message.id}/reports`, "POST", {
            reason: "other",
            details: "Rate bounded report",
          })
        ).status,
        200,
      );
    const limited = await f.request(`/api/inbox/${messages[10].id}/reports`, "POST", {
      reason: "other",
      details: "Over the hourly limit",
    });
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.has("retry-after"));
    assert.equal(
      (await f.request(f.reports, "POST", { reason: "spam", details: "Duplicate receipt" })).status,
      200,
    );
    assert.equal((await f.pg.query("select * from creator_contact_reports")).rows.length, 10);
    for (let i = 0; i < 30; i++)
      assert.equal((await f.request(f.moderation, "PUT", { blocked: i % 2 === 0 })).status, 200);
    const blockLimit = await f.request(f.moderation, "PUT", { blocked: true });
    assert.equal(blockLimit.status, 429);
    assert.equal((await (await f.request(f.moderation)).json()).blocked, false);
  } finally {
    await f.pg.close();
  }
});
