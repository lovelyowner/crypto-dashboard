/** Real local accounts exercise pair blocking and private reports.
 * Anonymous-note and staff-review rendering use explicit fixtures; no payments are made.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";

const origin = new URL(process.env.TEST_BASE_URL || "http://127.0.0.1:8080").origin;
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const contexts = [];
const published = [];
const errors = [];
let checks = 0;

async function check(name, run) {
  await run();
  checks += 1;
  console.log(`PASS ${name}`);
}
async function context() {
  const value = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders: { "x-forwarded-for": `203.0.113.${1 + (randomBytes(1)[0] % 254)}` },
  });
  contexts.push(value);
  value.on("page", (page) => {
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(error.message));
  });
  await value.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort("blockedbyclient"),
  );
  return value;
}
async function account(name) {
  const value = await context();
  const suffix = randomBytes(8).toString("hex");
  const result = await value.request.post(`${origin}/api/auth/sign-up/email`, {
    headers: { origin },
    data: {
      name,
      email: `moderation-${suffix}@example.com`,
      username: `moderation @ ${suffix}`,
      password: `🔐 ${randomBytes(24).toString("base64")} +/#`,
    },
  });
  assert.equal(result.status(), 200, "Disposable account creation succeeds");
  return value;
}
async function publish(value, name) {
  const handle = `safety-${randomBytes(8).toString("hex")}`;
  const profile = {
    version: 1,
    displayName: name,
    bio: "Disposable local moderation regression.",
    links: [],
    wishlist: [],
    serviceLinks: { allmylinks: "", throne: "", nowpayments: "", bluesky: "" },
    donations: {
      bankLink: "",
      crypto: [
        {
          id: "receiving-eth",
          chain: "ethereum",
          address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
          label: "Public receiving fixture",
        },
      ],
    },
  };
  assert.equal(
    (
      await value.request.put(`${origin}/api/profile/publication`, {
        headers: { origin },
        data: { handle, profile },
      })
    ).status(),
    200,
  );
  published.push(value);
  assert.equal(
    (
      await value.request.put(`${origin}/api/profile/contact`, {
        headers: { origin },
        data: {
          settings: {
            dmMode: "free",
            dmEthPrice: "",
            dmUsdPrice: "",
            donationNotesEnabled: true,
            minimumDonationEth: "0.000001",
            minimumDonationUsd: "1.00",
            ethDonationAddressId: "receiving-eth",
          },
        },
      })
    ).status(),
    200,
  );
  return handle;
}
async function send(value, handle, text) {
  return value.request.post(`${origin}/api/creators/${handle}/messages`, {
    headers: { origin },
    data: { kind: "dm", anonymous: false, text },
  });
}
async function reply(value, id, text) {
  return value.request.post(`${origin}/api/inbox/${id}/replies`, {
    headers: { origin },
    data: { text },
  });
}
async function json(value, path) {
  const response = await value.request.get(`${origin}${path}`);
  assert.equal(response.status(), 200);
  return response.json();
}
async function inboxPage(value, folder = "received") {
  const page = await value.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Display name", { exact: true }).waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  const inbox = page.getByRole("region", { name: "Private creator inbox", exact: true });
  await inbox.waitFor();
  if (folder !== "received")
    await inbox
      .getByRole("tab", { name: folder === "sent" ? "Sent" : "Donation notes", exact: true })
      .click();
  await inbox.getByText("Loading messages…", { exact: true }).waitFor({ state: "hidden" });
  return { page, inbox };
}
async function copied(page, inbox) {
  await page.evaluate(() => {
    window.__safetyTranscript = null;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__safetyTranscript = text;
        },
      },
    });
  });
  await inbox.getByRole("button", { name: "Copy conversation", exact: true }).click();
  await inbox.getByText("Conversation copied.", { exact: true }).waitFor();
  return page.evaluate(() => window.__safetyTranscript);
}
async function mobilePalette(page, region) {
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const violations = await region.evaluate((root) => {
    const text = new Set(["rgb(153, 153, 153)", "rgb(102, 102, 102)", "rgb(51, 51, 51)"]);
    const clear = new Set(["rgba(0, 0, 0, 0)", "transparent"]);
    const bad = [];
    for (const element of [root, ...root.querySelectorAll("*")]) {
      if (!element.getClientRects().length) continue;
      const style = getComputedStyle(element);
      if (!text.has(style.color)) bad.push(`${element.tagName}:color:${style.color}`);
      if (!clear.has(style.backgroundColor) && style.backgroundColor !== "rgb(255, 255, 255)")
        bad.push(`${element.tagName}:background:${style.backgroundColor}`);
      for (const edge of ["Top", "Right", "Bottom", "Left"]) {
        if (
          style[`border${edge}Style`] !== "none" &&
          parseFloat(style[`border${edge}Width`]) > 0 &&
          style[`border${edge}Color`] !== "rgb(204, 204, 204)"
        )
          bad.push(`${element.tagName}:border:${style[`border${edge}Color`]}`);
      }
      if (
        style.outlineStyle !== "none" &&
        parseFloat(style.outlineWidth) > 0 &&
        style.outlineColor !== "rgb(204, 204, 204)"
      )
        bad.push(`${element.tagName}:outline:${style.outlineColor}`);
    }
    return [...new Set(bad)];
  });
  assert.deepEqual(violations, []);
}

try {
  const owner = await account("Safety creator 🌙");
  const sender = await account("Safety sender 🪐");
  const outsider = await account("Unrelated safety account");
  const ownerHandle = await publish(owner, "Safety creator 🌙");
  const senderHandle = await publish(sender, "Safety sender 🪐");
  const initial = "History remains readable after blocking 🪐";
  const created = await send(sender, ownerHandle, initial);
  assert.equal(created.status(), 201);
  const { message } = await created.json();
  const historicReply = "Reply sent before the block 🌙";
  assert.equal((await reply(owner, message.id, historicReply)).status(), 201);

  await check("moderation state and reports are private to participants and staff", async () => {
    const denied = await outsider.request.get(`${origin}/api/inbox/${message.id}/moderation`);
    assert.equal(denied.status(), 404);
    assert.match(denied.headers()["cache-control"], /no-store/);
    assert.equal(
      (
        await outsider.request.post(`${origin}/api/inbox/${message.id}/reports`, {
          headers: { origin },
          data: { reason: "spam", details: "Unrelated caller" },
        })
      ).status(),
      404,
    );
    assert.deepEqual(await json(owner, "/api/moderation/access"), { canReview: false });
    assert.equal((await owner.request.get(`${origin}/api/moderation/reports`)).status(), 403);
  });

  const { page, inbox } = await inboxPage(owner);
  await inbox.locator(".creator-inbox-row").filter({ hasText: historicReply }).click();
  await inbox
    .locator(".creator-inbox-transcript")
    .getByText(historicReply, { exact: true })
    .waitFor();
  const safety = inbox.locator("details.conversation-moderation");
  await safety.locator("summary").click();
  const draft = inbox.getByLabel("Private reply", { exact: true });
  const unsent = "Keep this private unsent draft 📝";
  await draft.fill(unsent);
  await check(
    "blocking requires confirmation and preserves history, copy, and the unsent draft",
    async () => {
      await safety.getByRole("button", { name: "Block account", exact: true }).click();
      await safety.getByRole("heading", { name: "Block this account?", exact: true }).waitFor();
      assert.equal((await json(owner, `/api/inbox/${message.id}/moderation`)).blocked, false);
      await safety.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal((await json(owner, `/api/inbox/${message.id}/moderation`)).blocked, false);
      await safety.getByRole("button", { name: "Block account", exact: true }).click();
      await safety.getByRole("button", { name: "Confirm block", exact: true }).click();
      await safety.getByText("Account blocked.", { exact: true }).waitFor();
      assert.equal(await draft.inputValue(), unsent);
      assert.equal(
        await inbox.getByRole("button", { name: "Send reply", exact: true }).isDisabled(),
        true,
      );
      const transcript = await copied(page, inbox);
      assert.ok(transcript.includes(initial) && transcript.includes(historicReply));
      assert.ok(!transcript.includes(unsent));
      assert.equal(await inbox.locator("details.moderation-review-panel").count(), 0);
    },
  );

  await check(
    "one account's block stops new DMs, replies, and payment quotes in both directions",
    async () => {
      for (const [actor, target] of [
        [sender, ownerHandle],
        [owner, senderHandle],
      ]) {
        assert.equal((await send(actor, target, "Blocked direct message")).status(), 403);
        assert.equal((await reply(actor, message.id, "Blocked reply")).status(), 403);
        const quote = await actor.request.post(`${origin}/api/payments`, {
          headers: { origin },
          data: {
            handle: target,
            kind: "donation",
            text: "Blocked payment quote",
            anonymous: false,
            method: "ethereum",
            amount: "0.00001",
          },
        });
        assert.equal(quote.status(), 403);
        assert.match((await quote.json()).message, /blocked/i);
        const thread = await json(actor, `/api/inbox/${message.id}`);
        assert.equal(thread.message.text, initial);
        assert.equal(thread.replies[0].text, historicReply);
      }
      assert.equal(
        (await json(sender, `/api/inbox/${message.id}/moderation`)).blocked,
        false,
        "A block is not falsely attributed to its target",
      );
    },
  );

  await check(
    "reporting saves the selected reason and keeps the other participant's status private",
    async () => {
      await safety.getByRole("button", { name: "Report conversation", exact: true }).click();
      await safety.getByLabel("Report reason", { exact: true }).selectOption("harassment");
      await safety
        .getByLabel("Details (optional)", { exact: true })
        .fill("Private report details 🌙 <literal>");
      const saved = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/inbox/${message.id}/reports` &&
          response.request().method() === "POST",
      );
      await safety.getByRole("button", { name: "Save report", exact: true }).click();
      const result = await saved;
      assert.equal(result.status(), 200);
      assert.deepEqual(result.request().postDataJSON(), {
        reason: "harassment",
        details: "Private report details 🌙 <literal>",
      });
      await safety.getByText("Report saved.", { exact: true }).waitFor();
      assert.equal(
        await safety.getByRole("button", { name: "Report saved", exact: true }).isDisabled(),
        true,
      );
      assert.equal((await json(owner, `/api/inbox/${message.id}/moderation`)).reported, true);
      assert.equal((await json(sender, `/api/inbox/${message.id}/moderation`)).reported, false);
      assert.equal(await draft.inputValue(), unsent);
    },
  );

  await check("unblocking restores contact and lets the existing draft be sent", async () => {
    await safety.getByRole("button", { name: "Unblock account", exact: true }).click();
    await safety.getByRole("button", { name: "Confirm unblock", exact: true }).click();
    await safety.getByText("Account unblocked.", { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), unsent);
    await inbox.getByRole("button", { name: "Send reply", exact: true }).click();
    await inbox.locator(".creator-inbox-transcript").getByText(unsent, { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), "");
    assert.equal((await send(sender, ownerHandle, "Restored sender contact")).status(), 201);
    assert.equal((await send(owner, senderHandle, "Restored creator contact")).status(), 201);
  });
  await check("moderation controls fit mobile and use the requested palette", async () => {
    await mobilePalette(page, safety);
  });
  await page.close();

  // A paid anonymous note cannot be produced without a real settled payment.
  // Fixture only this view; pair/block and report persistence above use the real server.
  const fixturePage = await owner.newPage();
  const anonymousId = "anonymous-moderation-fixture";
  const stamp = "2026-11-05T12:00:00.000Z";
  const anonymous = {
    id: anonymousId,
    kind: "donation",
    text: "Anonymous paid-note rendering fixture",
    anonymous: true,
    senderName: "Anonymous",
    recipientHandle: ownerHandle,
    createdAt: stamp,
    lastActivityAt: stamp,
    latestReply: null,
    unread: false,
    readAt: stamp,
    direction: "received",
    paymentStatus: "paid",
  };
  let anonymousReported = false;
  await fixturePage.route("**/api/inbox**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body;
    if (path === "/api/inbox")
      body = {
        messages: [anonymous],
        nextCursor: null,
        unreadCounts: { received: 0, sent: 0, donations: 0 },
      };
    else if (path === `/api/inbox/${anonymousId}`) body = { message: anonymous, replies: [] };
    else if (path === `/api/inbox/${anonymousId}/moderation`)
      body = { canBlock: false, blocked: false, canReport: true, reported: anonymousReported };
    else if (path === `/api/inbox/${anonymousId}/reports`) {
      assert.equal(route.request().method(), "POST");
      assert.deepEqual(route.request().postDataJSON(), {
        reason: "scam",
        details: "Anonymous note report fixture",
      });
      anonymousReported = true;
      body = { reported: true };
    } else return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await fixturePage.goto(origin, { waitUntil: "domcontentloaded" });
  await fixturePage.getByLabel("Display name", { exact: true }).waitFor({ state: "attached" });
  await fixturePage.getByRole("button", { name: "Inbox", exact: true }).click();
  const fixtureInbox = fixturePage.getByRole("region", {
    name: "Private creator inbox",
    exact: true,
  });
  await fixtureInbox.locator(".creator-inbox-row").click();
  const anonymousSafety = fixtureInbox.locator("details.conversation-moderation");
  await anonymousSafety.locator("summary").click();
  await check(
    "anonymous note fixture can be reported without implying an account identity to block",
    async () => {
      await anonymousSafety
        .getByText("This conversation has no other account available to block.", { exact: false })
        .waitFor();
      assert.equal(
        await anonymousSafety.getByRole("button", { name: "Block account", exact: true }).count(),
        0,
      );
      assert.equal(await fixtureInbox.getByLabel("Private reply", { exact: true }).count(), 0);
      await anonymousSafety
        .getByRole("button", { name: "Report conversation", exact: true })
        .click();
      await anonymousSafety.getByLabel("Report reason", { exact: true }).selectOption("scam");
      await anonymousSafety
        .getByLabel("Details (optional)", { exact: true })
        .fill("Anonymous note report fixture");
      await anonymousSafety.getByRole("button", { name: "Save report", exact: true }).click();
      await anonymousSafety.getByText("Report saved.", { exact: true }).waitFor();
      assert.equal(anonymousReported, true);
    },
  );
  await fixturePage.close();

  // Staff authorization is enforced by the real API/unit suite; these fixtures test
  // strict access rendering and the review controls without allowlisting test users.
  const reviewPage = await owner.newPage();
  let reviewerAccess = "true";
  const reviewReport = {
    id: "staff-review-fixture",
    reason: "harassment",
    details: "Private staff report fixture",
    status: "open",
    createdAt: stamp,
    message: { text: "Reported conversation fixture", kind: "dm", anonymous: false },
    replies: [{ text: "Reported reply fixture", fromCreator: false, createdAt: stamp }],
  };
  const reviewWrites = [];
  await reviewPage.route("**/api/moderation/**", async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === "/api/moderation/access") body = { canReview: reviewerAccess };
    else if (url.pathname === "/api/moderation/reports")
      body = {
        reports: url.searchParams.get("status") === reviewReport.status ? [reviewReport] : [],
      };
    else if (url.pathname === `/api/moderation/reports/${reviewReport.id}`) {
      assert.equal(route.request().method(), "PATCH");
      const write = route.request().postDataJSON();
      reviewWrites.push(write);
      reviewReport.status = write.status;
      body = { updated: true };
    } else return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  async function openReviewInbox() {
    const access = reviewPage.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/moderation/access",
    );
    await reviewPage.goto(origin, { waitUntil: "domcontentloaded" });
    await reviewPage.getByLabel("Display name", { exact: true }).waitFor({ state: "attached" });
    await reviewPage.getByRole("button", { name: "Inbox", exact: true }).click();
    await access;
    return reviewPage.getByRole("region", { name: "Private creator inbox", exact: true });
  }
  await check(
    "staff review fixture requires literal true access and hides controls for malformed access",
    async () => {
      const inbox = await openReviewInbox();
      assert.equal(await inbox.locator("details.moderation-review-panel").count(), 0);
      reviewerAccess = true;
      await openReviewInbox();
      await reviewPage.locator("details.moderation-review-panel").waitFor();
    },
  );
  await check(
    "authorized staff fixture can review and dismiss a report through explicit status changes",
    async () => {
      const panel = reviewPage.locator("details.moderation-review-panel");
      await panel.locator("summary").first().click();
      await panel.getByText("Private staff report fixture", { exact: true }).waitFor();
      await panel.getByRole("button", { name: "Mark reviewed", exact: true }).click();
      await panel.getByText("Report marked reviewed.", { exact: true }).waitFor();
      assert.deepEqual(reviewWrites, [{ status: "reviewed" }]);
      await panel.getByLabel("Report status", { exact: true }).selectOption("reviewed");
      await panel.getByRole("button", { name: "Dismiss report", exact: true }).click();
      await panel.getByText("Report dismissed.", { exact: true }).waitFor();
      assert.deepEqual(reviewWrites, [{ status: "reviewed" }, { status: "dismissed" }]);
    },
  );
  await check("moderation browser run has no runtime errors", async () =>
    assert.deepEqual(errors, []),
  );
  console.log(
    `Moderation browser: ${checks} checks passed. Real local pair blocking and reports; anonymous/staff UI fixtures; no payments or deployment.`,
  );
} finally {
  for (const value of published)
    await value.request
      .delete(`${origin}/api/profile/publication`, { headers: { origin } })
      .catch(() => undefined);
  await Promise.all(contexts.map((value) => value.close()));
  await browser.close();
}
