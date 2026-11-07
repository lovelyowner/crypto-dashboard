/** Real local conversation downloads and owner privacy, plus explicit download-failure fixtures.
 * No live OAuth, blockchain transaction, or payment provider is used.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";

const origin = new URL(process.env.TEST_BASE_URL || "http://127.0.0.1:8080").origin;
const endpoint = `${origin}/api/account/messages-export`;
const routePattern = (url) =>
  url.origin === origin && url.pathname === "/api/account/messages-export";
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const contexts = [];
const errors = [];
let checks = 0;

async function check(name, operation) {
  await operation();
  checks++;
  console.log(`PASS ${name}`);
}
async function context() {
  const value = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${1 + (randomBytes(1)[0] % 254)}` },
  });
  contexts.push(value);
  value.on("page", (page) => {
    page.setDefaultTimeout(20_000);
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
  const suffix = randomBytes(8).toString("hex");
  const password = `🔐 ${randomBytes(24).toString("base64")} /# +`;
  const response = await value.request.post(`${origin}/api/auth/sign-up/email`, {
    headers: { origin },
    data: { name, email: `export-${suffix}@example.com`, username: `export @ ${suffix}`, password },
  });
  assert.ok(response.ok(), "Disposable local account creation succeeds");
  return { ...(await response.json()).user, password };
}
async function publish(value, handle) {
  const profile = {
    version: 1,
    displayName: "Conversation export creator 🌙",
    bio: "Local regression fixture.",
    links: [],
    wishlist: [],
    serviceLinks: { allmylinks: "", throne: "", nowpayments: "", bluesky: "" },
    donations: { bankLink: "", crypto: [] },
  };
  const response = await value.request.put(`${origin}/api/profile/publication`, {
    headers: { origin },
    data: { handle, profile },
  });
  assert.equal(response.status(), 200, "Disposable creator publication succeeds");
  const settings = await value.request.put(`${origin}/api/profile/contact`, {
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
  });
  assert.equal(settings.status(), 200, "Free local messaging is enabled");
}
async function get(value, path) {
  const response = await value.request.get(new URL(path, origin).href);
  assert.equal(response.status(), 200);
  return response.json();
}
async function send(value, handle, text) {
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
}
async function readDownload(download) {
  assert.equal(await download.failure(), null);
  const stream = await download.createReadStream();
  assert.ok(stream);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  await download.delete();
  return { raw, value: JSON.parse(raw) };
}
function noPrivateFields(value) {
  const forbidden = new Set([
    "senderId",
    "recipientId",
    "authorId",
    "moderationActorId",
    "paymentId",
    "sender_id",
    "recipient_id",
    "author_id",
    "moderation_actor_id",
    "payment_id",
    "accessToken",
    "refreshToken",
    "password",
    "passwordHash",
    "token",
    "secret",
    "backupCodes",
  ]);
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, "Archive fields must not expose identities or secrets");
    noPrivateFields(child);
  }
}
function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function readState(inbox) {
  return {
    unreadCounts: inbox.unreadCounts,
    messages: inbox.messages.map(({ id, unread, readAt, lastActivityAt }) => ({
      id,
      unread,
      readAt,
      lastActivityAt,
    })),
  };
}

try {
  const owner = await context(),
    sender = await context(),
    stranger = await context(),
    guest = await context();
  const ownerAccount = await account(owner, "Archive owner 🪐");
  const senderAccount = await account(sender, "Archive sender 🌙");
  const strangerAccount = await account(stranger, "Unrelated account");
  await check(
    "a fresh account can export an explicitly complete empty conversation archive",
    async () => {
      const response = await stranger.request.get(endpoint);
      assert.equal(response.status(), 200);
      assert.match(response.headers()["cache-control"], /no-store/);
      assert.match(response.headers()["content-disposition"], /attachment/);
      const archive = await response.json();
      assert.equal(archive.scope, "accessible-conversations");
      assert.equal(archive.complete, true);
      assert.deepEqual(archive.counts, { conversations: 0, replies: 0 });
      assert.deepEqual(archive.conversations, []);
    },
  );

  const ownerHandle = `archive-owner-${randomBytes(8).toString("hex")}`;
  const senderHandle = `archive-sender-${randomBytes(8).toString("hex")}`;
  await publish(owner, ownerHandle);
  await publish(sender, senderHandle);
  const firstText = "Literal conversation 🌙 <script>this is text</script>";
  const secondText = "Second accessible conversation 🪐";
  const first = await send(sender, ownerHandle, firstText);
  const second = await send(sender, ownerHandle, secondText);
  await reply(owner, first.id, "Creator reply with Unicode ✨");
  await reply(sender, first.id, "Sender follow-up keeps the conversation unread 🌟");
  const privateText = "Unrelated private message must not reach the owner archive";
  const unrelated = await send(stranger, senderHandle, privateText);

  await check("export ownership comes from the session, not a supplied account ID", async () => {
    const forbidden = await guest.request.get(endpoint);
    assert.equal(forbidden.status(), 401);
    assert.match(forbidden.headers()["cache-control"], /no-store/);
    const other = await get(
      stranger,
      `/api/account/messages-export?userId=${encodeURIComponent(ownerAccount.id)}`,
    );
    assert.equal(other.complete, true);
    assert.deepEqual(
      other.conversations.map(({ id }) => id),
      [unrelated.id],
    );
    assert.ok(!JSON.stringify(other).includes(firstText));
  });

  const page = await owner.newPage();
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Display name", { exact: true }).waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Open account", exact: true }).click();
  const panel = page.locator(".account-panel");
  await panel.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  const exportSection = panel.getByRole("region", { name: "Account data export", exact: true });
  const conversationButton = () =>
    exportSection.getByRole("button", { name: "Download conversations", exact: true });
  const profileButton = () =>
    exportSection.getByRole("button", { name: "Download account and profile data", exact: true });
  const noNewDownload = async (before) => {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    assert.equal(
      downloads.length,
      before,
      "A failed, cancelled, or detached export must not download a file",
    );
  };
  const downloadConversations = async (selection) => {
    const waiting = page.waitForEvent("download");
    await conversationButton().click();
    const download = await waiting;
    assert.equal(
      download.suggestedFilename(),
      selection
        ? `fathom-conversations-${selection.createdFrom ?? "start"}-through-${selection.createdThrough ?? "end"}.json`
        : "fathom-conversations.json",
    );
    return readDownload(download);
  };
  let archive;
  await check(
    "the account UI downloads complete owned conversations and all replies without marking them read",
    async () => {
      const before = readState(await get(owner, "/api/inbox"));
      const downloaded = await downloadConversations();
      archive = downloaded.value;
      await exportSection
        .getByRole("status")
        .filter({ hasText: "Downloaded 2 conversations and 2 replies." })
        .waitFor();
      assert.equal(archive.version, 1);
      assert.equal(archive.scope, "accessible-conversations");
      assert.equal(archive.complete, true);
      assert.deepEqual(archive.counts, { conversations: 2, replies: 2 });
      assert.deepEqual(
        new Set(archive.conversations.map(({ id }) => id)),
        new Set([first.id, second.id]),
      );
      const thread = archive.conversations.find(({ id }) => id === first.id);
      assert.equal(thread.text, firstText);
      assert.equal(thread.direction, "received");
      assert.equal(thread.senderName, senderAccount.name);
      assert.deepEqual(
        thread.replies.map(({ text }) => text),
        ["Creator reply with Unicode ✨", "Sender follow-up keeps the conversation unread 🌟"],
      );
      assert.deepEqual(
        thread.replies.map(({ fromCreator }) => fromCreator),
        [true, false],
      );
      assert.ok(Number.isFinite(Date.parse(archive.exportedAt)));
      assert.ok(Buffer.byteLength(downloaded.raw) <= 2 * 1024 * 1024);
      noPrivateFields(archive);
      for (const privateValue of [
        ownerAccount.id,
        senderAccount.id,
        strangerAccount.id,
        ownerAccount.password,
        privateText,
      ])
        assert.equal(
          downloaded.raw.includes(privateValue),
          false,
          "Unrelated identities, credentials, and messages stay out of the archive",
        );
      for (const cookie of await owner.cookies()) {
        if (!cookie.name.includes("session_token") || !cookie.value) continue;
        assert.equal(
          downloaded.raw.includes(cookie.value),
          false,
          "Session cookies stay out of the archive",
        );
      }
      assert.deepEqual(readState(await get(owner, "/api/inbox")), before);
      assert.equal(before.unreadCounts.received, 2);
      assert.equal(await conversationButton().isEnabled(), true);
      assert.equal(await profileButton().isEnabled(), true);
    },
  );

  await check(
    "the existing account/profile download remains separate and explicitly incomplete as a whole-account archive",
    async () => {
      const waiting = page.waitForEvent("download");
      await profileButton().click();
      const download = await waiting;
      assert.equal(download.suggestedFilename(), "fathom-account-profile.json");
      const { value } = await readDownload(download);
      assert.equal(value.scope, "account-profile");
      assert.equal(value.complete, false);
      assert.equal(value.account.id, ownerAccount.id);
      assert.equal("conversations" in value, false);
      await exportSection
        .getByRole("status")
        .filter({ hasText: "Account and profile data downloaded." })
        .waitFor();
    },
  );

  const fromInput = exportSection.getByLabel("Created from (UTC)", { exact: true });
  const throughInput = exportSection.getByLabel("Created through (UTC)", { exact: true });
  const clearDates = exportSection.getByRole("button", { name: "Clear dates", exact: true });
  const createdDates = archive.conversations.map(({ createdAt }) => createdAt.slice(0, 10)).sort();
  const firstDate = createdDates[0];
  const lastDate = createdDates.at(-1);
  const selection = { createdFrom: firstDate, createdThrough: lastDate, timeZone: "UTC" };
  let filteredArchive;
  async function setDates(value) {
    await fromInput.fill(value.createdFrom ?? "");
    await throughInput.fill(value.createdThrough ?? "");
  }
  async function downloadSelected(value) {
    const waiting = page.waitForRequest((request) => routePattern(new URL(request.url())));
    const downloaded = await downloadConversations(value);
    const request = await waiting;
    assert.equal(request.method(), "GET");
    const parameters = new URL(request.url()).searchParams;
    assert.deepEqual(
      [...parameters.entries()].sort(),
      [
        ...(value.createdFrom ? [["from", value.createdFrom]] : []),
        ...(value.createdThrough ? [["through", value.createdThrough]] : []),
      ].sort(),
      "Only the selected UTC date bounds are sent to the API",
    );
    assert.equal(downloaded.value.version, 2);
    assert.equal(downloaded.value.scope, "filtered-accessible-conversations");
    assert.equal(downloaded.value.complete, true);
    assert.deepEqual(downloaded.value.selection, value);
    noPrivateFields(downloaded.value);
    return downloaded;
  }

  await check(
    "UTC date selection downloads complete matching conversations and clear restores the unfiltered v1 archive",
    async () => {
      await exportSection
        .locator("summary")
        .filter({ hasText: /^Filter conversations$/ })
        .click();
      const before = readState(await get(owner, "/api/inbox"));
      await setDates(selection);
      const viewport = page.viewportSize();
      await page.setViewportSize({ width: 390, height: 844 });
      try {
        assert.equal(
          await exportSection.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          true,
          "Date filters fit their account section on a narrow screen",
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          "The mobile account view has no horizontal page overflow",
        );
        for (const input of [fromInput, throughInput]) {
          const bounds = await input.boundingBox();
          assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391);
        }
      } finally {
        await page.setViewportSize(viewport);
      }
      const downloaded = await downloadSelected(selection);
      filteredArchive = downloaded.value;
      assert.deepEqual(filteredArchive.counts, { conversations: 2, replies: 2 });
      assert.deepEqual(filteredArchive.conversations, archive.conversations);
      assert.deepEqual(readState(await get(owner, "/api/inbox")), before);
      await clearDates.click();
      assert.equal(await fromInput.inputValue(), "");
      assert.equal(await throughInput.inputValue(), "");
      const request = page.waitForRequest((value) => routePattern(new URL(value.url())));
      const all = await downloadConversations();
      assert.equal(new URL((await request).url()).search, "");
      assert.equal(all.value.version, 1);
      assert.equal(all.value.scope, "accessible-conversations");
      assert.equal("selection" in all.value, false);
      assert.deepEqual(all.value.counts, { conversations: 2, replies: 2 });
    },
  );

  await check(
    "one-sided UTC bounds include their creation day and exclude conversations on the other side",
    async () => {
      for (const [bounds, included] of [
        [{ createdFrom: firstDate, createdThrough: null, timeZone: "UTC" }, true],
        [{ createdFrom: null, createdThrough: lastDate, timeZone: "UTC" }, true],
        [{ createdFrom: shiftDate(lastDate, 1), createdThrough: null, timeZone: "UTC" }, false],
        [{ createdFrom: null, createdThrough: shiftDate(firstDate, -1), timeZone: "UTC" }, false],
      ]) {
        await setDates(bounds);
        const { value } = await downloadSelected(bounds);
        assert.deepEqual(value.counts, {
          conversations: included ? 2 : 0,
          replies: included ? 2 : 0,
        });
        assert.deepEqual(value.conversations, included ? archive.conversations : []);
      }
      await clearDates.click();
    },
  );

  await check(
    "invalid date ranges do not request a UI download and the API rejects ambiguous date queries",
    async () => {
      const requests = [];
      const observe = (request) => {
        if (routePattern(new URL(request.url()))) requests.push(request);
      };
      page.on("request", observe);
      const before = downloads.length;
      try {
        await setDates({
          createdFrom: shiftDate(lastDate, 1),
          createdThrough: shiftDate(firstDate, -1),
        });
        if (await conversationButton().isEnabled()) {
          await conversationButton().click();
          await exportSection
            .getByRole("status")
            .filter({ hasText: "Choose valid dates, with the start on or before the end date." })
            .waitFor();
        }
        await noNewDownload(before);
        assert.equal(requests.length, 0, "An inverted date range is stopped before fetch");
        assert.equal(await profileButton().isEnabled(), true);
      } finally {
        page.off("request", observe);
        await clearDates.click();
      }
      assert.equal(await conversationButton().isEnabled(), true);
      for (const query of [
        "from=",
        "from=2026-02-30",
        `from=${firstDate}&from=${firstDate}`,
        `from=${shiftDate(lastDate, 1)}&through=${shiftDate(firstDate, -1)}`,
      ]) {
        const response = await owner.request.get(`${endpoint}?${query}`);
        assert.equal(response.status(), 400, "Invalid or duplicate date bounds fail closed");
        assert.match(response.headers()["cache-control"], /no-store/);
      }
    },
  );

  await check(
    "filtered downloads reject missing or mismatched selection and malformed or out-of-range archives",
    async () => {
      const outOfRange = structuredClone(filteredArchive);
      outOfRange.conversations[0].createdAt = `${shiftDate(firstDate, -1)}T12:00:00.000Z`;
      const mismatch = "The export response did not match the selected dates.";
      const malformed = "The conversation archive could not be read.";
      const invalidArchives = [
        [archive, selection, mismatch],
        [
          {
            ...filteredArchive,
            selection: { createdFrom: null, createdThrough: lastDate, timeZone: "UTC" },
          },
          selection,
          mismatch,
        ],
        [{ ...filteredArchive, complete: false }, selection, malformed],
        [outOfRange, selection, malformed],
        [filteredArchive, {}, mismatch],
      ];
      try {
        for (const [value, bounds, message] of invalidArchives) {
          await setDates(bounds);
          const handler = (route) =>
            route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(value),
            });
          await owner.route(routePattern, handler);
          const before = downloads.length;
          try {
            const response = page.waitForResponse((result) => routePattern(new URL(result.url())));
            await conversationButton().click();
            await (await response).finished();
            await exportSection.getByRole("status").filter({ hasText: message }).waitFor();
            assert.equal(await conversationButton().isEnabled(), true);
            assert.equal(await profileButton().isEnabled(), true);
            await noNewDownload(before);
          } finally {
            await owner.unroute(routePattern, handler);
          }
        }
      } finally {
        if (await clearDates.isVisible()) await clearDates.click();
      }
    },
  );

  for (const [status, message] of [
    [403, "Sign in again to download your account data."],
    [413, "This export exceeds the download limit. Nothing was downloaded."],
  ]) {
    await check(
      `HTTP ${status} prevents a download and leaves export actions retryable`,
      async () => {
        const handler = (route) =>
          route.fulfill({
            status,
            contentType: "application/json",
            body: JSON.stringify({ message: "Fixture rejection" }),
          });
        await owner.route(routePattern, handler);
        const before = downloads.length;
        try {
          await conversationButton().click();
          await exportSection.getByRole("status").filter({ hasText: message }).waitFor();
          assert.equal(await conversationButton().isEnabled(), true);
          assert.equal(await profileButton().isEnabled(), true);
          await noNewDownload(before);
        } finally {
          await owner.unroute(routePattern, handler);
        }
      },
    );
  }

  await check(
    "an incomplete or malformed archive is rejected before creating a download",
    async () => {
      const handler = (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...archive, complete: false }),
        });
      await owner.route(routePattern, handler);
      const before = downloads.length;
      try {
        await conversationButton().click();
        await exportSection
          .getByRole("status")
          .filter({ hasText: "The conversation archive could not be read." })
          .waitFor();
        assert.equal(await conversationButton().isEnabled(), true);
        await noNewDownload(before);
      } finally {
        await owner.unroute(routePattern, handler);
      }
    },
  );

  async function heldResponse({ ignoreAbort = false } = {}) {
    if (ignoreAbort) {
      await page.evaluate(() => {
        const original = window.fetch;
        const fixture = { original, settled: 0 };
        window.__conversationExportFetchFixture = fixture;
        window.fetch = function (input, init) {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.origin !== location.origin || url.pathname !== "/api/account/messages-export")
            return original.call(this, input, init);
          // A transport that ignores abort must not keep the UI busy or later create a file.
          const options = { ...init };
          delete options.signal;
          return original.call(this, input, options).finally(() => fixture.settled++);
        };
      });
    }
    let release, reached, finished;
    let intercepted = false;
    let completed = false;
    let transportError;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      reached = resolve;
    });
    const done = new Promise((resolve) => {
      finished = resolve;
    });
    const handler = async (route) => {
      // Only the original request is held; a deliberate retry reaches the actual local API.
      if (intercepted) return route.fallback();
      intercepted = true;
      reached();
      await gate;
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(archive),
        });
      } catch (error) {
        // Native logout cancellation can close its intercepted request.
        if (ignoreAbort) transportError = error;
      } finally {
        completed = true;
        finished();
      }
    };
    await owner.route(routePattern, handler);
    return {
      handler,
      release,
      started,
      done,
      completed: () => completed,
      async settled() {
        await done;
        if (transportError) throw transportError;
        if (ignoreAbort)
          await page.waitForFunction(() => window.__conversationExportFetchFixture.settled === 2);
      },
      async restore() {
        release();
        await owner.unroute(routePattern, handler);
        if (ignoreAbort)
          await page.evaluate(() => {
            const fixture = window.__conversationExportFetchFixture;
            window.fetch = fixture.original;
            delete window.__conversationExportFetchFixture;
          });
      },
    };
  }
  await check(
    "cancelling frees the UI immediately and a retry completes before the original response arrives",
    async () => {
      const held = await heldResponse({ ignoreAbort: true });
      const before = downloads.length;
      try {
        await conversationButton().click();
        await held.started;
        assert.equal(await profileButton().isDisabled(), true);
        assert.equal(await fromInput.isDisabled(), true);
        assert.equal(await throughInput.isDisabled(), true);
        assert.equal(
          await exportSection
            .getByRole("button", { name: "Preparing conversations…", exact: true })
            .isDisabled(),
          true,
        );
        await exportSection.getByRole("button", { name: "Cancel download", exact: true }).click();
        await exportSection
          .getByRole("status")
          .filter({ hasText: "Download cancelled." })
          .waitFor();
        assert.equal(await conversationButton().isEnabled(), true);
        assert.equal(await profileButton().isEnabled(), true);
        assert.equal(held.completed(), false, "The cancelled response is still held");
        await noNewDownload(before);
        const downloaded = await downloadConversations();
        assert.deepEqual(downloaded.value.counts, { conversations: 2, replies: 2 });
        await exportSection
          .getByRole("status")
          .filter({ hasText: "Downloaded 2 conversations and 2 replies." })
          .waitFor();
        assert.equal(
          held.completed(),
          false,
          "Retry completes before the old response is released",
        );
        held.release();
        await held.settled();
        await noNewDownload(before + 1);
        assert.equal(await conversationButton().isEnabled(), true);
        await exportSection
          .getByRole("status")
          .filter({ hasText: "Downloaded 2 conversations and 2 replies." })
          .waitFor();
      } finally {
        await held.restore();
      }
    },
  );

  await check(
    "timeout frees the UI despite ignored abort and a late response cannot overwrite a completed retry",
    async () => {
      const held = await heldResponse({ ignoreAbort: true });
      const before = downloads.length;
      try {
        await conversationButton().click();
        await held.started;
        await exportSection
          .getByRole("status")
          .filter({ hasText: "The download timed out. Try again." })
          .waitFor({ timeout: 22_000 });
        assert.equal(await conversationButton().isEnabled(), true);
        assert.equal(await profileButton().isEnabled(), true);
        assert.equal(held.completed(), false, "The timed-out response is still held");
        await noNewDownload(before);
        const downloaded = await downloadConversations();
        assert.deepEqual(downloaded.value.counts, { conversations: 2, replies: 2 });
        await exportSection
          .getByRole("status")
          .filter({ hasText: "Downloaded 2 conversations and 2 replies." })
          .waitFor();
        assert.equal(
          held.completed(),
          false,
          "Retry completes before the old response is released",
        );
        held.release();
        await held.settled();
        await noNewDownload(before + 1);
        assert.equal(await conversationButton().isEnabled(), true);
        await exportSection
          .getByRole("status")
          .filter({ hasText: "Downloaded 2 conversations and 2 replies." })
          .waitFor();
      } finally {
        await held.restore();
      }
    },
  );

  await check(
    "signing out while an export waits prevents its late response from downloading private data",
    async () => {
      const held = await heldResponse();
      const before = downloads.length;
      try {
        await conversationButton().click();
        await held.started;
        await panel.getByRole("button", { name: "Sign out", exact: true }).click();
        await panel.getByLabel("Email or username", { exact: true }).waitFor();
        held.release();
        await held.done;
        await noNewDownload(before);
        assert.equal((await owner.request.get(endpoint)).status(), 401);
      } finally {
        held.release();
        await owner.unroute(routePattern, held.handler);
      }
    },
  );

  assert.deepEqual(errors, [], "Conversation exports produce no browser runtime errors");
  console.log(
    `Conversation export browser: ${checks} checks passed (real local account/message APIs; no external services).`,
  );
} finally {
  await Promise.all(contexts.map((value) => value.close()));
  await browser.close();
}
