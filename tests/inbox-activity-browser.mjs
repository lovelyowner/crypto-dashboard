/** Real local conversations and viewer-scoped activity, plus explicit pagination/error fixtures.
 * No live blockchain requests, wallet transactions, or external payment providers are used.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";

const origin = new URL(process.env.TEST_BASE_URL || "http://127.0.0.1:8080").origin;
const handle = `activity-${randomBytes(8).toString("hex")}`;
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const contexts = [];
const errors = [];
let checks = 0;
let owner;
let unpublished = false;

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
async function account(value, name) {
  const unique = randomBytes(8).toString("hex");
  const response = await value.request.post(`${origin}/api/auth/sign-up/email`, {
    headers: { origin },
    data: {
      name,
      email: `inbox-activity-${unique}@example.com`,
      password: `🔐 ${randomBytes(24).toString("base64")} +/#`,
      username: `activity @ ${unique}`,
    },
  });
  assert.ok(response.ok(), "Disposable local account signup succeeds");
  return (await response.json()).user;
}
async function json(value, path, options) {
  const response = await value.request.get(`${origin}${path}`, options);
  assert.equal(response.status(), 200);
  return response.json();
}
async function send(value, text) {
  const response = await value.request.post(`${origin}/api/creators/${handle}/messages`, {
    headers: { origin },
    data: { kind: "dm", anonymous: false, text },
  });
  assert.equal(response.status(), 201);
  return (await response.json()).message;
}
async function reply(value, id, text) {
  const response = await value.request.post(`${origin}/api/inbox/${id}/replies`, {
    headers: { origin },
    data: { text },
  });
  assert.equal(response.status(), 201);
  return response.json();
}
async function inboxPage(value, folder = "received") {
  const page = await value.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  // Navigation renders before React attaches its handlers.
  await page.getByLabel("Display name", { exact: true }).waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  const inbox = page.getByRole("region", { name: "Private creator inbox", exact: true });
  await inbox.waitFor();
  if (folder === "sent") await inbox.getByRole("tab", { name: "Sent", exact: true }).click();
  await inbox.getByText("Loading messages…", { exact: true }).waitFor({ state: "hidden" });
  return { page, inbox };
}
async function focus(page) {
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}
async function hidden(page, value) {
  await page.evaluate((next) => {
    window.__inboxFixtureHidden = next;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (window.__inboxFixtureHidden ? "hidden" : "visible"),
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => Boolean(window.__inboxFixtureHidden),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);
}

try {
  owner = await context();
  await account(owner, "Activity creator 🌙");
  const sender = await context();
  await account(sender, "Activity sender 🪐");
  const stranger = await context();
  await account(stranger, "Unrelated inbox member");
  const guest = await context();
  const profile = {
    version: 1,
    displayName: "Inbox activity fixture",
    bio: "Local browser regression only.",
    links: [],
    wishlist: [],
    serviceLinks: { allmylinks: "", throne: "", nowpayments: "", bluesky: "" },
    donations: { bankLink: "", crypto: [] },
  };
  assert.equal(
    (
      await owner.request.put(`${origin}/api/profile/publication`, {
        headers: { origin },
        data: { handle, profile },
      })
    ).status(),
    200,
  );
  assert.equal(
    (
      await owner.request.put(`${origin}/api/profile/contact`, {
        headers: { origin },
        data: {
          settings: {
            dmMode: "free",
            dmEthPrice: "",
            dmUsdPrice: "",
            donationNotesEnabled: true,
            minimumDonationEth: "0.000001",
            minimumDonationUsd: "1.00",
            ethDonationAddressId: null,
          },
        },
      })
    ).status(),
    200,
  );

  const first = await send(sender, "Original older conversation 🌙");
  const second = await send(sender, "Original newer conversation 🪐");
  await check(
    "inbox counts are viewer-scoped and newly sent messages are unread only for the creator",
    async () => {
      const received = await json(owner, "/api/inbox?folder=received");
      assert.deepEqual(received.unreadCounts, { received: 2, sent: 0, donations: 0 });
      assert.equal(received.messages[0].id, second.id);
      assert.ok(received.messages.every((message) => message.unread));
      const sent = await json(sender, "/api/inbox?folder=sent");
      assert.deepEqual(sent.unreadCounts, { received: 0, sent: 0, donations: 0 });
      assert.ok(sent.messages.every((message) => !message.unread));
    },
  );
  await check("opening a thread marks only the viewer's snapshot as read", async () => {
    const thread = await json(owner, `/api/inbox/${first.id}`);
    assert.equal(thread.message.unread, false);
    assert.ok(thread.message.readAt);
    assert.equal((await json(owner, "/api/inbox")).unreadCounts.received, 1);
    assert.equal((await json(sender, "/api/inbox?folder=sent")).unreadCounts.sent, 0);
  });
  const incoming = "New sender reply moves the old conversation first";
  await reply(sender, first.id, incoming);
  await check(
    "a sender reply makes the older thread unread, changes its preview and moves it first",
    async () => {
      const received = await json(owner, "/api/inbox");
      assert.equal(received.messages[0].id, first.id);
      assert.equal(received.messages[0].unread, true);
      assert.equal(received.messages[0].latestReply.text, incoming);
      assert.equal(received.messages[0].latestReply.fromCreator, false);
      assert.ok(Date.parse(received.messages[0].lastActivityAt) >= Date.parse(first.createdAt));
      assert.equal(received.unreadCounts.received, 2);
    },
  );
  await check(
    "private counts and conversation activity do not expose another account's inbox",
    async () => {
      const other = await json(stranger, "/api/inbox");
      assert.deepEqual(other.messages, []);
      assert.deepEqual(other.unreadCounts, { received: 0, sent: 0, donations: 0 });
      assert.equal((await stranger.request.get(`${origin}/api/inbox/${first.id}`)).status(), 404);
      const denied = await guest.request.get(`${origin}/api/inbox`);
      assert.equal(denied.status(), 401);
      assert.match(denied.headers()["cache-control"], /no-store/);
      assert.equal((await json(owner, "/api/inbox")).unreadCounts.received, 2);
    },
  );

  const { page: ownerPage, inbox: ownerInbox } = await inboxPage(owner);
  const firstRow = ownerInbox.locator(".creator-inbox-row").filter({ hasText: incoming });
  await firstRow.waitFor();
  await check(
    "inbox rows show latest replies and unread state before opening the conversation",
    async () => {
      assert.match(
        await ownerInbox.locator(".creator-inbox-row").first().innerText(),
        /New sender reply/,
      );
      assert.equal(await firstRow.locator(".creator-inbox-unread").innerText(), "Unread");
    },
  );
  await check(
    "conversation rows support arrow/Home/End keys without opening another thread",
    async () => {
      const rows = ownerInbox.locator(".creator-inbox-row");
      await rows.first().focus();
      await rows.first().press("End");
      assert.equal(await rows.last().evaluate((node) => node === document.activeElement), true);
      await rows.last().press("Home");
      assert.equal(await rows.first().evaluate((node) => node === document.activeElement), true);
    },
  );
  await firstRow.focus();
  await firstRow.press("Enter");
  const transcript = ownerInbox.locator(".creator-inbox-transcript");
  await transcript.getByText(incoming, { exact: true }).waitFor();
  assert.equal(
    await ownerInbox
      .locator(".creator-inbox-thread-summary h3")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  const draft = ownerInbox.getByLabel("Private reply", { exact: true });
  const unsaved = "Keep this unsent creator reply 📝 <literal>";
  await draft.fill(unsaved);
  let inboxReads = 0;
  let replyWrites = 0;
  ownerPage.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/inbox") && request.method() === "GET") inboxReads += 1;
    if (path === `/api/inbox/${first.id}/replies` && request.method() === "POST") replyWrites += 1;
  });
  const liveReply = "Incoming reply appears on focus without sending the draft";
  await reply(sender, first.id, liveReply);
  await focus(ownerPage);
  await transcript.getByText(liveReply, { exact: true }).waitFor();
  await check(
    "foreground refresh updates the open conversation and preserves the unsent reply",
    async () => {
      assert.equal(await draft.inputValue(), unsaved);
      assert.equal(replyWrites, 0);
      assert.equal((await json(owner, "/api/inbox")).unreadCounts.received, 1);
    },
  );
  await check(
    "Copy conversation includes only the loaded transcript and preserves Unicode",
    async () => {
      await ownerPage.evaluate(() => {
        window.__copiedConversation = null;
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text) => {
              window.__copiedConversation = text;
            },
          },
        });
      });
      await ownerInbox.getByRole("button", { name: "Copy conversation", exact: true }).click();
      const copied = await ownerPage.evaluate(() => window.__copiedConversation);
      assert.equal(typeof copied, "string");
      for (const text of [
        "Original older conversation 🌙",
        "Activity sender 🪐",
        incoming,
        liveReply,
      ]) {
        assert.ok(copied.includes(text), `Copied transcript includes ${text}`);
      }
      for (const text of [unsaved, "Original newer conversation 🪐", first.id, second.id]) {
        assert.ok(
          !copied.includes(text),
          "Copied transcript excludes drafts, other threads, and IDs",
        );
      }
      assert.equal(await draft.inputValue(), unsaved);
      assert.equal(replyWrites, 0);
    },
  );

  await hidden(ownerPage, true);
  const hiddenReply = "This arrives while the inbox tab is hidden";
  await reply(sender, first.id, hiddenReply);
  const beforeHidden = inboxReads;
  await ownerPage.evaluate(() => window.dispatchEvent(new Event("focus")));
  // Short observation window verifies that the synchronous focus handler does not request data.
  await ownerPage.waitForTimeout(180);
  await check("hidden inboxes pause refreshes and catch up when visible again", async () => {
    assert.equal(inboxReads, beforeHidden);
    assert.equal(await transcript.getByText(hiddenReply, { exact: true }).count(), 0);
    await hidden(ownerPage, false);
    await transcript.getByText(hiddenReply, { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), unsaved);
  });
  await owner.setOffline(true);
  const offlineReply = "This arrives while the reader is offline";
  await reply(sender, first.id, offlineReply);
  const beforeOffline = inboxReads;
  await ownerPage.evaluate(() => window.dispatchEvent(new Event("focus")));
  await ownerPage.waitForTimeout(180);
  await check("offline inboxes pause refreshes and catch up after reconnecting", async () => {
    assert.equal(inboxReads, beforeOffline);
    await owner.setOffline(false);
    await transcript.getByText(offlineReply, { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), unsaved);
  });

  let rejectNextReply = true;
  await ownerPage.route(`**/api/inbox/${first.id}/replies`, async (route) => {
    if (route.request().method() === "POST" && rejectNextReply) {
      rejectNextReply = false;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          message: "Fixture reply failure: retry without losing this draft.",
        }),
      });
    } else await route.continue();
  });
  const failedReply = ownerPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/inbox/${first.id}/replies` &&
      response.request().method() === "POST",
  );
  await ownerInbox.getByRole("button", { name: "Send reply", exact: true }).click();
  assert.equal((await failedReply).status(), 409);
  const replyError = ownerInbox
    .getByRole("alert")
    .filter({ hasText: "Messages could not be loaded or changed. Please try again." });
  await replyError.waitFor();
  const refreshedThread = ownerPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/inbox/${first.id}` &&
      response.request().method() === "GET",
  );
  await focus(ownerPage);
  await refreshedThread;
  await check("background refresh preserves a failed reply's error and draft", async () => {
    assert.equal(await draft.inputValue(), unsaved);
    assert.equal(await replyError.isVisible(), true);
  });
  await ownerInbox.getByRole("button", { name: "Send reply", exact: true }).click();
  await transcript.getByText(unsaved, { exact: true }).waitFor();
  await check(
    "a creator reply is unread for the sender's Sent folder but read for its author",
    async () => {
      const sent = await json(sender, "/api/inbox?folder=sent");
      assert.equal(sent.messages[0].id, first.id);
      assert.equal(sent.messages[0].latestReply.text, unsaved);
      assert.equal(sent.messages[0].latestReply.fromCreator, true);
      assert.equal(sent.messages[0].unread, true);
      assert.equal(sent.unreadCounts.sent, 1);
      assert.equal((await json(owner, "/api/inbox")).messages[0].unread, false);
      assert.equal(await draft.inputValue(), "");
      assert.equal(await ownerInbox.getByText("Draft", { exact: true }).count(), 0);
    },
  );
  const { page: senderPage, inbox: senderInbox } = await inboxPage(sender, "sent");
  const sentRow = senderInbox.locator(".creator-inbox-row").filter({ hasText: unsaved });
  await sentRow.waitFor();
  await check(
    "Sent shows a creator's latest reply as unread and opening it clears that account's count",
    async () => {
      assert.equal(await sentRow.locator(".creator-inbox-unread").innerText(), "Unread");
      await sentRow.click();
      await senderInbox
        .locator(".creator-inbox-transcript")
        .getByText(unsaved, { exact: true })
        .waitFor();
      assert.equal((await json(sender, "/api/inbox?folder=sent")).unreadCounts.sent, 0);
      assert.equal((await json(owner, "/api/inbox")).unreadCounts.received, 1);
    },
  );
  await senderPage.close();

  const repliedRow = ownerInbox.locator(".creator-inbox-row").filter({ hasText: unsaved });
  const secondRow = ownerInbox
    .locator(".creator-inbox-row")
    .filter({ hasText: "Original newer conversation 🪐" });
  const firstDraft = "Unsent draft for the older conversation 🌙";
  const secondDraft = "Separate unsent draft for the newer conversation 🪐";
  const writesBeforeDraftNavigation = replyWrites;
  await check(
    "separate reply drafts survive conversation, Back, and folder navigation",
    async () => {
      await draft.fill(firstDraft);
      await repliedRow.getByText("Draft", { exact: true }).waitFor();
      await secondRow.click();
      assert.equal(await draft.inputValue(), "");
      await draft.fill(secondDraft);
      await ownerInbox.getByRole("button", { name: "Messages", exact: true }).click();
      await ownerInbox.locator(".creator-inbox-row:focus").waitFor();
      assert.equal(await draft.count(), 0);
      await repliedRow.click();
      assert.equal(await draft.inputValue(), firstDraft);
      await ownerInbox.getByRole("tab", { name: "Sent", exact: true }).click();
      await ownerInbox.getByText("No messages here yet", { exact: true }).waitFor();
      await ownerInbox.getByRole("tab", { name: "Received", exact: true }).click();
      await repliedRow.getByText("Draft", { exact: true }).waitFor();
      await secondRow.getByText("Draft", { exact: true }).waitFor();
      await secondRow.click();
      assert.equal(await draft.inputValue(), secondDraft);
      assert.equal(replyWrites, writesBeforeDraftNavigation);
    },
  );
  await check("discarding a reply draft clears only that conversation", async () => {
    await ownerInbox.getByRole("button", { name: "Discard draft", exact: true }).click();
    assert.equal(await draft.inputValue(), "");
    assert.equal(await secondRow.getByText("Draft", { exact: true }).count(), 0);
    await repliedRow.getByText("Draft", { exact: true }).waitFor();
    await repliedRow.click();
    assert.equal(await draft.inputValue(), firstDraft);
    await secondRow.click();
    assert.equal(await draft.inputValue(), "");
    await repliedRow.click();
    assert.equal(await draft.inputValue(), firstDraft);
    assert.equal(replyWrites, writesBeforeDraftNavigation);
  });

  await ownerPage.setViewportSize({ width: 390, height: 844 });
  await check(
    "the inbox conversation fits mobile and retains the white and gray palette",
    async () => {
      assert.ok(await ownerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const palette = await ownerInbox.evaluate((element) => {
        const style = getComputedStyle(element);
        let paintedBackground = "rgba(0, 0, 0, 0)";
        for (let node = element; node; node = node.parentElement) {
          const background = getComputedStyle(node).backgroundColor;
          if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent") {
            paintedBackground = background;
            break;
          }
        }
        return [
          paintedBackground,
          style.getPropertyValue("--ui-border").trim(),
          style.getPropertyValue("--ui-text-1").trim(),
          style.getPropertyValue("--ui-text-2").trim(),
          style.getPropertyValue("--ui-text-3").trim(),
        ];
      });
      assert.deepEqual(palette, ["rgb(255, 255, 255)", "#ccc", "#999", "#666", "#333"]);
    },
  );
  await ownerPage.setViewportSize({ width: 1440, height: 1000 });

  // Pagination failure is intentionally fixture-only; no large batch of real messages is sent.
  let secondPageCalls = 0;
  const fixtureRows = Array.from({ length: 51 }, (_, index) => {
    const stamp = new Date(Date.UTC(2026, 0, 1, 12, 0, 51 - index)).toISOString();
    return {
      id: `pagination-${String(index + 1).padStart(2, "0")}`,
      kind: "dm",
      text: `Pagination fixture message ${String(index + 1).padStart(2, "0")}`,
      anonymous: false,
      senderName: `Pagination sender ${String(index + 1).padStart(2, "0")}`,
      recipientHandle: handle,
      createdAt: stamp,
      lastActivityAt: stamp,
      latestReply: null,
      unread: false,
      paymentStatus: "free",
      direction: "received",
      readAt: stamp,
    };
  });
  await stranger.route("**/api/inbox?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/inbox" || route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const more = Boolean(url.searchParams.get("cursor"));
    if (more) secondPageCalls += 1;
    if (more && secondPageCalls === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Fixture second page is temporarily unavailable." }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: more ? fixtureRows.slice(50) : fixtureRows.slice(0, 50),
        nextCursor: more ? null : "fixture-next-page",
        unreadCounts: { received: 0, sent: 0, donations: 0 },
      }),
    });
  });
  const { page: pagingPage, inbox: pagingInbox } = await inboxPage(stranger);
  await pagingInbox.locator(".creator-inbox-row").nth(49).waitFor();
  const moreButton = pagingInbox.getByRole("button", { name: "Load more messages", exact: true });
  await moreButton.click();
  await pagingInbox
    .getByRole("alert")
    .filter({ hasText: "The inbox service is unavailable. Please try again later." })
    .waitFor();
  assert.equal(secondPageCalls, 1);
  await moreButton.click();
  await pagingInbox.locator(".creator-inbox-row").nth(50).waitFor();
  await check(
    "a failed Load more can retry the same cursor without duplicate messages",
    async () => {
      assert.equal(secondPageCalls, 2);
      assert.equal(await pagingInbox.locator(".creator-inbox-row").count(), 51);
      const labels = await pagingInbox.locator(".creator-inbox-preview").allTextContents();
      assert.equal(new Set(labels).size, 51);
      assert.equal(await moreButton.count(), 0);
    },
  );
  await pagingPage.close();

  assert.equal(
    (
      await owner.request.delete(`${origin}/api/profile/publication`, { headers: { origin } })
    ).status(),
    200,
  );
  unpublished = true;
  await ownerPage.getByRole("button", { name: "Account & security", exact: true }).click();
  await ownerPage
    .locator(".account-panel")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await ownerPage
    .locator(".account-panel")
    .getByRole("button", { name: "Sign in", exact: true })
    .waitFor();
  await ownerPage.getByRole("button", { name: "Close dialog", exact: true }).click();
  await ownerPage.getByRole("heading", { name: "Your private inbox", exact: true }).waitFor();
  const afterLogout = inboxReads;
  await focus(ownerPage);
  await ownerPage.waitForTimeout(180);
  await check(
    "signing out removes private conversations and stops their automatic refresh",
    async () => {
      assert.equal(inboxReads, afterLogout);
      assert.equal(await ownerPage.locator(".creator-inbox-transcript").count(), 0);
      assert.equal(await ownerPage.getByLabel("Private reply", { exact: true }).count(), 0);
    },
  );
  await check("inbox activity flows have no uncaught browser exceptions", async () => {
    assert.deepEqual(errors, []);
  });
  console.log(
    `Inbox activity browser: ${checks} checks passed (real local conversations; pagination/error fixtures only).`,
  );
} finally {
  if (owner && !unpublished) {
    await owner.setOffline(false).catch(() => {});
    await owner.request
      .delete(`${origin}/api/profile/publication`, { headers: { origin } })
      .catch(() => {});
  }
  for (const value of contexts) await value.close().catch(() => {});
  await browser.close();
}
