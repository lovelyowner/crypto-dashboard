import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Deterministic browser coverage for workspace increments. Start the app first.
// TEST_BASE_URL and CHROMIUM_PATH can override this cloud environment's defaults.
const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";
const origin = new URL(baseURL).origin;
const A = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const B = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const C = "counterparty-QA-filter";
const hashes = { recent: "a".repeat(64), pending: "c".repeat(64), old: "b".repeat(64) };
const longLabel = "Кошелёк 🌌 日本語 / " + "очень-длинная-метка-".repeat(3);
const stamp = Math.floor(Date.now() / 1000);
const tx = (hash, address, amount, age, direction = "in", other = B) => ({
  txid: hash,
  status: { confirmed: age !== null, ...(age === null ? {} : { block_time: stamp - age }) },
  vin: [
    { prevout: { scriptpubkey_address: direction === "out" ? address : other, value: amount } },
  ],
  vout: [{ scriptpubkey_address: direction === "out" ? other : address, value: amount }],
});
const fixtures = {
  [A]: [tx(hashes.recent, A, 123456789, 120), tx(hashes.pending, A, 987654, null, "out", C)],
  [B]: [tx(hashes.old, B, 876543210, 10 * 24 * 3600, "out", C)],
};
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const errors = [];
let externalRequests = 0;
let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log(`PASS ${name}`);
}
async function instrument(context) {
  context.on("page", (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    // The browser-local build does not need an authentication backend to track addresses.
    if (url.origin === origin && url.pathname.startsWith("/api/auth/")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: url.pathname.endsWith("/config") ? JSON.stringify({ providers: [] }) : "null",
      });
    }
    if (url.origin === origin) return route.continue();
    externalRequests++;
    let body;
    if (url.hostname === "api.coingecko.com") body = { bitcoin: { usd: 65000 } };
    else if (url.hostname === "mempool.space" && url.pathname === "/api/v1/prices")
      body = { USD: 65000 };
    else if (url.hostname === "mempool.space") {
      const parts = url.pathname.split("/");
      const address = parts[3];
      if (!fixtures[address]) throw new Error(`Unexpected fixture address ${address}`);
      body =
        parts[4] === "txs"
          ? fixtures[address]
          : {
              chain_stats: {
                funded_txo_sum: address === A ? 123456789 : 987654321,
                spent_txo_sum: 0,
              },
              mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
            };
    } else throw new Error(`Unexpected external request ${url.hostname}`);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    });
  });
}
async function dismissToast(page) {
  const dismiss = page.getByRole("button", { name: "Dismiss notification" });
  if (await dismiss.count()) await dismiss.click();
}
async function labels(page) {
  return page.locator(".address-identity h3").allTextContents();
}
async function noOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}
async function rows(page, expected) {
  await page.waitForFunction((n) => document.querySelectorAll("tbody tr").length === n, expected);
}
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
await instrument(context);
const page = await context.newPage();
try {
  await mkdir("screenshots", { recursive: true });
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.locator(".address-empty").waitFor();
  await page.getByRole("button", { name: "Add address", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Bulk add", exact: true }).click();
  await dialog.getByLabel("Network", { exact: true }).selectOption("bitcoin");
  const batch = dialog.locator("textarea");
  await batch.fill(`${A}, Zeta address\n${B.slice(0, -1)}X, Invalid`);
  await dialog.getByRole("checkbox").check();
  await check("invalid bulk batch disables submission and adds nothing", async () => {
    assert.equal(
      await dialog.getByRole("button", { name: "Add addresses", exact: true }).isDisabled(),
      true,
    );
    assert.match(await dialog.locator(".validation-message").textContent(), /Line 2/);
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("fathom.ledger.v1") || '{"state":{"watched":[]}}'),
    );
    assert.equal(saved.state.watched.length, 0);
  });
  await batch.fill(`${A}, Zeta address\n${B}, Alpha address\n${A}, Duplicate address`);
  await dialog.getByRole("button", { name: "Add addresses", exact: true }).click();
  await page.locator(".address-card").first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".mini-tx").length === 3);
  await check("valid bulk batch deduplicates before saving", async () => {
    assert.equal(await page.locator(".address-card").count(), 2);
    assert.match(
      await page
        .getByRole("status")
        .filter({ hasText: /Added 2/ })
        .textContent(),
      /skipped 1/,
    );
  });
  await page.getByRole("combobox", { name: "Sort addresses" }).selectOption("label");
  await check("labels sort alphabetically", async () =>
    assert.deepEqual(await labels(page), ["Alpha address", "Zeta address"]),
  );
  await page.getByRole("combobox", { name: "Sort addresses" }).selectOption("balance");
  await check("balances sort by highest known USD", async () =>
    assert.equal((await labels(page))[0], "Alpha address"),
  );
  await page.getByRole("button", { name: "Edit label for Alpha address", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Label", { exact: true }).fill(longLabel);
  await page.getByRole("button", { name: "Save label", exact: true }).click();
  await check("Unicode labels update without changing address identity", async () => {
    assert.equal(await page.getByRole("heading", { name: longLabel, exact: true }).count(), 1);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("fathom.ledger.v1")));
    assert.equal(saved.state.watched.find((watch) => watch.address === B).label, longLabel);
  });
  await page.getByRole("button", { name: "Pin Zeta address", exact: true }).click();
  await check("pinned address precedes balance sorting", async () => {
    assert.equal((await labels(page))[0], "Zeta address");
    assert.equal(
      await page
        .getByRole("button", { name: "Unpin Zeta address", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".mini-tx").length === 3);
  await check("edited labels and pinned state survive reload", async () => {
    assert.equal((await labels(page))[0], "Zeta address");
    assert((await labels(page)).includes(longLabel));
  });
  await page.getByRole("button", { name: "Networks", exact: true }).click();
  await page
    .locator(".network-card")
    .filter({ has: page.getByRole("heading", { name: /Cosmos Hub/ }) })
    .getByRole("button", { name: "Watch an address" })
    .click();
  await check("network directory prefills selected network in address dialog", async () =>
    assert.equal(
      await page.getByRole("dialog").getByLabel("Network", { exact: true }).inputValue(),
      "cosmos",
    ),
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await rows(page, 3);
  await page
    .getByRole("combobox", { name: "Filter transactions by status" })
    .selectOption("pending");
  await check("status filter shows only pending row", async () => {
    await rows(page, 1);
    assert.match(await page.locator("tbody").textContent(), /Pending/);
    assert.equal(await page.locator("tbody time").getAttribute("datetime"), null);
  });
  await page.getByRole("button", { name: "Reset filters", exact: true }).click();
  await page.getByRole("combobox", { name: "Filter transactions by time" }).selectOption("24h");
  await check("time window excludes old and unconfirmed activity", async () => {
    await rows(page, 1);
    assert.match(await page.locator("tbody").textContent(), /1\.23456789/);
    assert.match(await page.locator(".tx-time-note").textContent(), /unconfirmed/);
  });
  await page.getByRole("button", { name: "Reset filters", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Filter transactions by watched address" })
    .selectOption(`bitcoin:${B}`);
  await check("watched-address filter selects its own transaction", async () => {
    await rows(page, 1);
    assert.match(await page.locator("tbody").textContent(), /8\.7654321/);
  });
  await page.getByRole("button", { name: "Reset filters", exact: true }).click();
  await page.getByRole("textbox", { name: "Search workspace" }).fill(C);
  await check("counterparty search includes matching public transactions", async () => {
    await rows(page, 2);
  });
  await page
    .getByRole("combobox", { name: "Filter transactions by status" })
    .selectOption("pending");
  await page.getByRole("button", { name: "Hide balances", exact: true }).click();
  await check("privacy mode removes actual table amounts from DOM", async () => {
    assert.equal(await page.locator('[aria-label="Amount hidden"]').count(), 1);
    assert(
      !(await page
        .locator("tbody")
        .textContent()
        .then((text) => text.includes("0.00987654"))),
    );
    assert.match(
      await page.locator(".tx-results-summary").textContent(),
      /CSV exports include actual amounts/,
    );
  });
  const [csv] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export CSV", exact: true }).click(),
  ]);
  const csvText = await readFile(await csv.path(), "utf8");
  await check("CSV contains exactly filtered rows and disclosed actual amount", async () => {
    assert.equal(csvText.split("\r\n").length, 2);
    assert(csvText.includes(hashes.pending));
    assert(!csvText.includes(hashes.recent));
    assert(csvText.includes('"0.00987654"'));
    assert(csvText.includes('"pending"'));
    assert(csvText.includes(C));
  });
  await page.getByRole("button", { name: "Reset filters", exact: true }).click();
  await rows(page, 3);
  await dismissToast(page);
  await page.screenshot({ path: "screenshots/workspace-desktop-transactions.png", fullPage: true });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await check(
    "privacy mode removes totals, address balances, and recent amounts from DOM",
    async () => {
      assert.equal(await page.locator(".balance-stat>strong").textContent(), "••••");
      for (const value of await page.locator(".address-balance").allTextContents())
        assert(!/1\.23456789|9\.87654321/.test(value));
      for (const value of await page.locator(".tx-value strong").allTextContents())
        assert.equal(value, "••••");
    },
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".mini-tx").length === 3);
  await check("hidden-balances preference persists across reload", async () => {
    assert.equal(
      await page
        .getByRole("button", { name: "Show balances", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await page.locator(".balance-stat>strong").textContent(), "••••");
  });
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await check("settings dialog keeps keyboard focus inside", async () => {
    for (let index = 0; index < 10; index++) {
      await page.keyboard.press("Tab");
      assert(
        await page
          .getByRole("dialog")
          .evaluate((dialog) => dialog.contains(document.activeElement)),
      );
    }
  });
  await page.getByRole("switch", { name: "Hide balances", exact: true }).uncheck();
  await page
    .getByRole("combobox", { name: "Workspace auto-refresh interval" })
    .selectOption("300000");
  await page.getByRole("switch", { name: "Pause network sync", exact: true }).check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await check("settings switches update privacy, interval, and pause banner", async () => {
    assert.equal(await page.getByRole("button", { name: "Hide balances", exact: true }).count(), 1);
    assert.equal(
      await page.getByRole("combobox", { name: "Auto-refresh interval" }).inputValue(),
      "300000",
    );
    assert.equal(
      await page.getByRole("button", { name: "Refresh balances", exact: true }).isDisabled(),
      true,
    );
    assert.equal(await page.getByRole("button", { name: "Resume sync", exact: true }).count(), 1);
  });
  const beforePausedReload = externalRequests;
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Resume sync", exact: true }).waitFor();
  await check("persisted pause blocks all initial external provider requests", async () => {
    assert.equal(externalRequests, beforePausedReload);
    assert.equal(
      await page.getByRole("button", { name: "Refresh balances", exact: true }).isDisabled(),
      true,
    );
  });
  await page.getByRole("button", { name: "Resume sync", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".mini-tx").length === 3);
  await check("resuming sync loads public provider data again", async () =>
    assert(externalRequests > beforePausedReload),
  );
  await context.setOffline(true);
  await check("offline state announces stale data and disables manual refresh", async () => {
    await page.locator(".workspace-state").filter({ hasText: "You are offline." }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Refresh balances", exact: true }).isDisabled(),
      true,
    );
    assert.equal(await page.locator(".address-card").count(), 2);
  });
  await context.setOffline(false);
  await page.waitForFunction(() => !document.querySelector(".workspace-state"));
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  const [watchExport] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export public watchlist", exact: true }).click(),
  ]);
  const watchData = JSON.parse(await readFile(await watchExport.path(), "utf8"));
  await check("settings watchlist export includes labels and pinned state", async () => {
    assert.equal(watchData.addresses.length, 2);
    assert(watchData.addresses.some((watch) => watch.pinned));
    assert(watchData.addresses.some((watch) => watch.label === longLabel));
  });
  await page.getByRole("button", { name: "Wallet backups", exact: true }).click();
  await check("settings wallet-backup link opens wallet manager", async () => {
    assert.equal(await page.getByRole("button", { name: "Import wallet", exact: true }).count(), 1);
  });
  await page.keyboard.press("Escape");
  await dismissToast(page);
  await page.screenshot({ path: "screenshots/workspace-desktop-overview.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
  );
  await check("mobile long-label address cards stay within viewport", async () =>
    assert(await noOverflow(page)),
  );
  await page.screenshot({ path: "screenshots/workspace-mobile-overview.png", fullPage: true });
  await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
  );
  await rows(page, 3);
  await check(
    "mobile advanced transaction filters and long labels do not overflow page",
    async () => assert(await noOverflow(page)),
  );
  await page.screenshot({ path: "screenshots/workspace-mobile-transactions.png", fullPage: true });
  await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await check("mobile settings dialog fits viewport and traps focus", async () => {
    const box = await page.getByRole("dialog").boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 390);
    await page.keyboard.press("Tab");
    assert(
      await page.getByRole("dialog").evaluate((dialog) => dialog.contains(document.activeElement)),
    );
    assert(await noOverflow(page));
  });
  await page.screenshot({ path: "screenshots/workspace-mobile-settings.png", fullPage: true });
  await page.keyboard.press("Escape");
  await check("Escape closes mobile settings", async () =>
    assert.equal(await page.getByRole("dialog").count(), 0),
  );
  const restoredContext = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  await instrument(restoredContext);
  await restoredContext.addInitScript(
    ({ origin }) => {
      if (location.origin === origin)
        localStorage.setItem(
          "fathom.preferences.v1",
          JSON.stringify({ version: 1, hideBalances: false, syncPaused: true, refreshInterval: 0 }),
        );
    },
    { origin },
  );
  const restoredPage = await restoredContext.newPage();
  const beforeRestore = externalRequests;
  await restoredPage.goto(baseURL, { waitUntil: "networkidle" });
  await restoredPage.locator(".address-empty").waitFor();
  await restoredPage
    .locator('.sidebar input[type="file"]')
    .setInputFiles({
      name: "fathom-watchlist.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(watchData)),
    });
  await restoredPage.waitForFunction(() => document.querySelectorAll(".address-card").length === 2);
  await check(
    "exported watchlist restores Unicode labels and pins in a fresh browser",
    async () => {
      const restored = await restoredPage.evaluate(
        () => JSON.parse(localStorage.getItem("fathom.ledger.v1")).state.watched,
      );
      const publicRows = (entries) =>
        entries
          .map(({ chain, address, label, pinned }) => ({
            chain,
            address,
            label,
            pinned: Boolean(pinned),
          }))
          .sort((a, b) => a.address.localeCompare(b.address));
      assert.deepEqual(publicRows(restored), publicRows(watchData.addresses));
      assert.equal((await labels(restoredPage))[0], "Zeta address");
    },
  );
  await check(
    "importing a watchlist while paused starts no external provider requests",
    async () => {
      assert.equal(externalRequests, beforeRestore);
      assert.equal(
        await restoredPage
          .getByRole("button", { name: "Refresh balances", exact: true })
          .isDisabled(),
        true,
      );
    },
  );
  await restoredContext.close();
  await check("workspace increment browser run has no runtime or console errors", async () =>
    assert.deepEqual(errors, []),
  );
  console.log(
    `Workspace browser: ${checks} checks passed. Public API fixtures only; no live provider or social OAuth claims.`,
  );
} catch (error) {
  await page.screenshot({ path: "screenshots/workspace-failure.png", fullPage: true });
  console.error("Failure screenshot: screenshots/workspace-failure.png; browser errors:", errors);
  throw error;
} finally {
  await browser.close();
}
