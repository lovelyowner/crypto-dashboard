import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { chromium } from "playwright";

const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";
const origin = new URL(baseURL).origin;
const BTC = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const BTC2 = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const ETH = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
function publicMoneroFixture() {
  const payload = Uint8Array.from([18, ...new Uint8Array(64).fill(17)]);
  const bytes = Uint8Array.from([...payload, ...keccak_256(payload).slice(0, 4)]);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const sizes = [0, 2, 3, 5, 6, 7, 9, 10, 11];
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 8) {
    const block = bytes.slice(offset, offset + 8);
    let value = 0n;
    let text = "";
    for (const byte of block) value = value * 256n + BigInt(byte);
    while (value > 0n) {
      text = alphabet[Number(value % 58n)] + text;
      value /= 58n;
    }
    encoded += text.padStart(sizes[block.length], "1");
  }
  return encoded;
}
const XMR = publicMoneroFixture();
const seedWatches = [
  {
    id: "seed-btc-wallet",
    chain: "bitcoin",
    address: BTC,
    label: "Pinned wallet 🌙",
    addedAt: 1000,
    pinned: true,
    walletId: "seed-wallet",
  },
  {
    id: "seed-btc-travel",
    chain: "bitcoin",
    address: BTC2,
    label: "Travel account",
    addedAt: 2000,
  },
  { id: "seed-eth", chain: "ethereum", address: ETH, label: "ETH provider test", addedAt: 3000 },
  { id: "seed-bnb", chain: "bnb", address: ETH, label: "BNB limited history", addedAt: 4000 },
  { id: "seed-xmr", chain: "monero", address: XMR, label: "Monero public watch", addedAt: 5000 },
];
const wallet = {
  id: "seed-wallet",
  label: "Seeded test metadata wallet",
  createdAt: 1000,
  custody: "device",
  addresses: { bitcoin: BTC, ethereum: ETH, solana: "11111111111111111111111111111111" },
  encrypted: {
    ciphertext: "TEST_CIPHERTEXT_NOT_A_REAL_WALLET",
    iv: "TEST_IV",
    salt: "TEST_SALT",
    iterations: 600000,
    kdf: "pbkdf2",
  },
};
const defaultView = {
  version: 1,
  tab: "Overview",
  sort: "recent",
  network: "all",
  direction: "all",
  status: "all",
  range: "all",
};
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync(chromium.executablePath()) ? chromium.executablePath() : "/usr/bin/chromium"),
  headless: true,
  args: ["--no-sandbox"],
});
const contexts = [];
const errors = [];
let checks = 0;
let externalRequests = 0;
let refreshGate = null;
let releaseRefresh = () => {};
async function check(name, fn) {
  await fn();
  checks++;
  console.log(`PASS ${name}`);
}
async function createContext(watches, paused) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  contexts.push(context);
  context.on("page", (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
  });
  await context.addInitScript(
    ({ origin, watches, wallet, paused, defaultView }) => {
      if (location.origin !== origin) return;
      if (localStorage.getItem("fathom.ledger.v1") === null)
        localStorage.setItem(
          "fathom.ledger.v1",
          JSON.stringify({ version: 0, state: { watched: watches, wallets: [wallet] } }),
        );
      if (localStorage.getItem("fathom.preferences.v1") === null)
        localStorage.setItem(
          "fathom.preferences.v1",
          JSON.stringify({
            version: 1,
            syncPaused: paused,
            hideBalances: false,
            refreshInterval: 0,
          }),
        );
      if (localStorage.getItem("fathom.view.v1") === null)
        localStorage.setItem("fathom.view.v1", JSON.stringify(defaultView));
    },
    { origin, watches, wallet, paused, defaultView },
  );
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname.startsWith("/api/auth/"))
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    if (url.origin === origin) return route.continue();
    externalRequests++;
    let body;
    if (url.hostname === "api.coingecko.com")
      body = { bitcoin: { usd: 65000 }, binancecoin: { usd: 700 } };
    else if (url.hostname === "mempool.space" && url.pathname === "/api/v1/prices")
      body = { USD: 65000 };
    else if (url.hostname === "mempool.space" && url.pathname.endsWith("/txs"))
      body = [
        {
          txid: "a".repeat(64),
          status: { confirmed: true, block_time: Math.floor(Date.now() / 1000) - 120 },
          vin: [{ prevout: { scriptpubkey_address: "counterparty", value: 12345678 } }],
          vout: [{ scriptpubkey_address: BTC, value: 12345678 }],
        },
      ];
    else if (url.hostname === "mempool.space" && url.pathname.startsWith("/api/address/")) {
      if (refreshGate) await refreshGate;
      body = {
        chain_stats: { funded_txo_sum: 123456789, spent_txo_sum: 0 },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
      };
    } else if (url.hostname === "eth.blockscout.com") body = {};
    else if (url.hostname === "ethereum-rpc.publicnode.com")
      body = { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "Provider rate limit 429" } };
    else if (url.hostname === "bsc-rpc.publicnode.com")
      body = { jsonrpc: "2.0", id: 1, result: "0x" + 2500000000000000000n.toString(16) };
    else throw new Error(`Unexpected external request: ${url.hostname}${url.pathname}`);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    });
  });
  return context;
}
async function saved(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("fathom.ledger.v1")));
}
async function noOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
}
async function dismissToast(page) {
  const dismiss = page.getByRole("button", { name: "Dismiss notification" });
  if (await dismiss.count()) await dismiss.click();
}
async function openSettings(page) {
  if ((await page.viewportSize()).width < 650)
    await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
}
const context = await createContext(seedWatches, true);
const page = await context.newPage();
try {
  await mkdir("screenshots", { recursive: true });
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".address-card").length === 5);
  await check("selection actions start disabled with no selected addresses", async () => {
    assert.equal(
      await page.getByRole("button", { name: "Export selected", exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole("button", { name: "Remove selected", exact: true }).isDisabled(),
      true,
    );
    assert.match(
      await page.locator(".address-selection-bar").textContent(),
      /0 selected across all filters/,
    );
  });
  await page.getByRole("checkbox", { name: "Select Pinned wallet 🌙", exact: true }).check();
  await check("partial visible selection reports an indeterminate select-all control", async () =>
    assert.equal(
      await page
        .getByRole("checkbox", { name: "Select visible addresses", exact: true })
        .evaluate((input) => input.indeterminate),
      true,
    ),
  );
  await page
    .getByRole("combobox", { name: "Filter by network", exact: true })
    .selectOption("ethereum");
  await check("selection stays active outside the current network filter", async () => {
    assert.equal(await page.locator(".address-card").count(), 1);
    assert.match(
      await page.locator(".address-selection-bar").textContent(),
      /1 selected across all filters/,
    );
    assert.equal(
      await page
        .getByRole("checkbox", { name: "Select visible addresses", exact: true })
        .isChecked(),
      false,
    );
  });
  await page.getByRole("checkbox", { name: "Select visible addresses", exact: true }).check();
  await check("select-visible adds only visible rows to the existing selection", async () => {
    assert.match(
      await page.locator(".address-selection-bar").textContent(),
      /2 selected across all filters/,
    );
  });
  await page
    .getByRole("combobox", { name: "Filter by network", exact: true })
    .selectOption("bitcoin");
  await check("select-visible state reflects selected and unselected Bitcoin rows", async () => {
    assert.equal(
      await page
        .getByRole("checkbox", { name: "Select Pinned wallet 🌙", exact: true })
        .isChecked(),
      true,
    );
    assert.equal(
      await page.getByRole("checkbox", { name: "Select Travel account", exact: true }).isChecked(),
      false,
    );
    assert.equal(
      await page
        .getByRole("checkbox", { name: "Select visible addresses", exact: true })
        .evaluate((input) => input.indeterminate),
      true,
    );
  });
  const [selectedDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export selected", exact: true }).click(),
  ]);
  const selectedRaw = await readFile(await selectedDownload.path(), "utf8");
  const selectedExport = JSON.parse(selectedRaw);
  await check("selected export contains exactly the chosen public entries", async () => {
    assert.equal(selectedDownload.suggestedFilename(), "fathom-selected-watchlist.json");
    assert.equal(selectedExport.addresses.length, 2);
    assert.deepEqual(selectedExport.addresses.map((row) => row.chain).sort(), [
      "bitcoin",
      "ethereum",
    ]);
    assert(!selectedRaw.includes(BTC2));
    assert(!selectedRaw.includes(XMR));
    assert(selectedExport.addresses.some((row) => row.pinned === true));
    for (const row of selectedExport.addresses)
      for (const key of Object.keys(row))
        assert(["chain", "address", "label", "pinned"].includes(key));
  });
  await check("selected export excludes private wallet data and local associations", async () => {
    for (const text of [
      "TEST_CIPHERTEXT",
      "TEST_IV",
      "TEST_SALT",
      "seed-wallet",
      "walletId",
      "encrypted",
      "ciphertext",
      "privateKey",
    ])
      assert(!selectedRaw.includes(text));
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Remove selected", exact: true }).click();
  await check("canceling bulk removal preserves watched entries and selection", async () => {
    assert.equal((await saved(page)).state.watched.length, 5);
    assert.match(
      await page.locator(".address-selection-bar").textContent(),
      /2 selected across all filters/,
    );
  });
  let confirmation = "";
  page.once("dialog", async (dialog) => {
    confirmation = dialog.message();
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Remove selected", exact: true }).click();
  await page.getByRole("button", { name: "Undo removal", exact: true }).waitFor();
  await check(
    "bulk removal confirms hidden selections and removes only selected entries",
    async () => {
      assert.match(confirmation, /outside the current filter/);
      const remaining = (await saved(page)).state.watched;
      assert.equal(remaining.length, 3);
      assert(!remaining.some((row) => ["seed-btc-wallet", "seed-eth"].includes(row.id)));
      assert.match(await page.locator(".removal-undo").textContent(), /2 addresses removed/);
      assert.match(
        await page.locator(".address-selection-bar").textContent(),
        /0 selected across all filters/,
      );
    },
  );
  await page.getByRole("button", { name: "Undo removal", exact: true }).click();
  await check(
    "undo restores exact IDs, Unicode labels, pins, timestamps, and wallet reference",
    async () => {
      const ledger = await saved(page);
      for (const id of ["seed-btc-wallet", "seed-eth"])
        assert.deepEqual(
          ledger.state.watched.find((row) => row.id === id),
          seedWatches.find((row) => row.id === id),
        );
      assert.deepEqual(ledger.state.wallets, [wallet]);
      assert.equal(
        await page.getByRole("button", { name: "Undo removal", exact: true }).count(),
        0,
      );
    },
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove Travel account", exact: true }).click();
  await page.getByRole("button", { name: "Undo removal", exact: true }).click();
  await check("single-address removal uses the same reversible action", async () =>
    assert.deepEqual(
      (await saved(page)).state.watched.find((row) => row.id === "seed-btc-travel"),
      seedWatches[1],
    ),
  );

  await page.getByRole("checkbox", { name: "Select Travel account", exact: true }).check();
  await page.getByRole("combobox", { name: "Sort addresses", exact: true }).selectOption("label");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Filter by direction", exact: true })
    .selectOption("out");
  await page
    .getByRole("combobox", { name: "Filter transactions by status", exact: true })
    .selectOption("pending");
  await page
    .getByRole("combobox", { name: "Filter transactions by time", exact: true })
    .selectOption("7d");
  await page
    .getByRole("combobox", { name: "Filter transactions by watched address", exact: true })
    .selectOption(`bitcoin:${BTC2}`);
  await page
    .getByRole("textbox", { name: "Search workspace", exact: true })
    .fill("DO_NOT_PERSIST_SEARCH_827");
  await check("remembered view stores only whitelisted display preferences", async () => {
    const raw = await page.evaluate(() => localStorage.getItem("fathom.view.v1"));
    const view = JSON.parse(raw);
    assert.deepEqual(
      Object.keys(view).sort(),
      ["version", "tab", "sort", "network", "direction", "status", "range"].sort(),
    );
    assert.deepEqual(view, {
      version: 1,
      tab: "Activity",
      sort: "label",
      network: "bitcoin",
      direction: "out",
      status: "pending",
      range: "7d",
    });
    assert(!raw.includes("DO_NOT_PERSIST_SEARCH_827"));
    assert(!raw.includes(BTC2));
    assert(!raw.includes("seed-btc-travel"));
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Activity", exact: true }).waitFor();
  await check("tab and transaction filter choices survive page reload", async () => {
    assert.equal(
      await page.getByRole("combobox", { name: "Filter by network", exact: true }).inputValue(),
      "bitcoin",
    );
    assert.equal(
      await page.getByRole("combobox", { name: "Filter by direction", exact: true }).inputValue(),
      "out",
    );
    assert.equal(
      await page
        .getByRole("combobox", { name: "Filter transactions by status", exact: true })
        .inputValue(),
      "pending",
    );
    assert.equal(
      await page
        .getByRole("combobox", { name: "Filter transactions by time", exact: true })
        .inputValue(),
      "7d",
    );
  });
  await check("search text and specific watched-address filter are not restored", async () => {
    assert.equal(
      await page.getByRole("textbox", { name: "Search workspace", exact: true }).inputValue(),
      "",
    );
    assert.equal(
      await page
        .getByRole("combobox", { name: "Filter transactions by watched address", exact: true })
        .inputValue(),
      "all",
    );
  });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await check("address sorting persists but selections do not persist", async () => {
    assert.equal(
      await page.getByRole("combobox", { name: "Sort addresses", exact: true }).inputValue(),
      "label",
    );
    assert.match(
      await page.locator(".address-selection-bar").textContent(),
      /0 selected across all filters/,
    );
  });
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await check("Reset view returns to Overview with default filters and sorting", async () => {
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    assert.equal(
      await page.getByRole("combobox", { name: "Filter by network", exact: true }).inputValue(),
      "all",
    );
    assert.equal(
      await page.getByRole("combobox", { name: "Sort addresses", exact: true }).inputValue(),
      "recent",
    );
    assert.deepEqual(
      await page.evaluate(() => JSON.parse(localStorage.getItem("fathom.view.v1"))),
      defaultView,
    );
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove Travel account", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove ETH provider test", exact: true }).click();
  await page.getByRole("button", { name: "Undo removal", exact: true }).click();
  await check("undo restores only the latest removal rather than an earlier batch", async () => {
    const watches = (await saved(page)).state.watched;
    assert(watches.some((row) => row.id === "seed-eth"));
    assert(!watches.some((row) => row.id === "seed-btc-travel"));
    assert.equal(watches.length, 4);
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove ETH provider test", exact: true }).click();
  await page.getByRole("button", { name: "Undo removal", exact: true }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".address-card").length === 3);
  await check(
    "removal persists across reload while the in-memory undo action expires",
    async () => {
      assert.equal(
        await page.getByRole("button", { name: "Undo removal", exact: true }).count(),
        0,
      );
      assert.equal((await saved(page)).state.watched.length, 3);
    },
  );
  await check("paused address actions perform no external provider requests", async () =>
    assert.equal(externalRequests, 0),
  );

  const healthContext = await createContext(
    seedWatches.filter((row) => row.id !== "seed-btc-travel"),
    false,
  );
  const healthPage = await healthContext.newPage();
  await healthPage.goto(baseURL, { waitUntil: "networkidle" });
  const health = healthPage.getByRole("region", { name: "Public data sync status", exact: true });
  await health
    .getByRole("heading", { name: "Some addresses are unavailable", exact: true })
    .waitFor();
  await check(
    "sync health distinguishes native coverage, limited history, provider failure, and private history",
    async () => {
      assert.match(
        await health.textContent(),
        /2 of 4 addresses have a native balance result · 1 with limited history · 1 unavailable · 1 private/,
      );
    },
  );
  await check("freshly fetched check timestamps are immediately available", async () => {
    assert.equal(await health.locator("time").count(), 1);
    assert.match(
      await health.locator(".sync-health-time").textContent(),
      /Oldest displayed balance check.*UTC/s,
    );
    assert(
      !(await health.textContent().then((text) => text.includes("check times are unavailable"))),
    );
  });
  await health.locator("summary").focus();
  await healthPage.keyboard.press("Enter");
  await check("keyboard expansion shows per-address public-data statuses", async () => {
    assert.equal(await health.locator(".sync-health-details li").count(), 4);
    const badges = await health.locator(".sync-health-badge").allTextContents();
    assert.deepEqual(
      badges.sort(),
      ["Balance and recent activity", "Balance only", "Private history", "Unavailable"].sort(),
    );
  });
  await check(
    "provider errors receive actionable explanations and Monero does not imply a readable balance",
    async () => {
      assert.match(await health.textContent(), /provider is rate limiting requests/);
      assert.match(
        await health.textContent(),
        /A public address cannot reveal this network’s private balance or transaction history/,
      );
      assert(!(await health.textContent().then((text) => text.includes("0 XMR"))));
    },
  );
  const beforeRetry = externalRequests;
  refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  await healthPage.getByRole("button", { name: "Refresh all", exact: true }).click();
  await health.getByRole("heading", { name: "Refreshing public data", exact: true }).waitFor();
  await check(
    "refreshing health retains completed results and prevents overlapping retries",
    async () => {
      assert.equal(
        await healthPage.getByRole("button", { name: "Refresh all", exact: true }).isDisabled(),
        true,
      );
      assert.match(await health.textContent(), /last completed results remain visible/);
      assert.match(
        await healthPage
          .locator(".address-card")
          .filter({ hasText: "Pinned wallet 🌙" })
          .textContent(),
        /1\.23456789/,
      );
    },
  );
  releaseRefresh();
  refreshGate = null;
  await health
    .getByRole("heading", { name: "Some addresses are unavailable", exact: true })
    .waitFor();
  await check("health retry bypasses cached results and queries the providers", async () =>
    assert(externalRequests > beforeRetry),
  );
  await healthPage.getByRole("button", { name: "Hide balances", exact: true }).click();
  await check("health panel has no amount values hidden in its rendered markup", async () => {
    const markup = await health.innerHTML();
    for (const value of ["1.23456789", "0.12345678", "2.5 BNB", "$80,247"])
      assert(!markup.includes(value));
    for (const value of await healthPage.locator(".address-balance").allTextContents())
      assert(value.includes("••••"));
  });
  await openSettings(healthPage);
  await healthPage.getByRole("switch", { name: "Pause network sync", exact: true }).check();
  await healthPage.getByRole("button", { name: "Done", exact: true }).click();
  await check(
    "paused health keeps coverage visible and offers no active retry action",
    async () => {
      await health.getByRole("heading", { name: "Sync is paused", exact: true }).waitFor();
      assert.equal(
        await health.getByRole("button", { name: "Refresh data", exact: true }).count(),
        0,
      );
      assert.equal(
        await healthPage.getByRole("button", { name: "Refresh all", exact: true }).isDisabled(),
        true,
      );
      assert.match(await health.textContent(), /2 of 4/);
    },
  );
  await healthContext.setOffline(true);
  await check("offline health retains local results and explains refresh limitations", async () => {
    await health.getByRole("heading", { name: "You are offline", exact: true }).waitFor();
    assert.match(
      await health.textContent(),
      /Displayed data will not refresh while the browser is offline/,
    );
    assert.equal(await healthPage.locator(".address-card").count(), 4);
  });
  await healthContext.setOffline(false);
  await health.getByRole("heading", { name: "Sync is paused", exact: true }).waitFor();
  await healthPage.getByRole("checkbox", { name: "Select visible addresses", exact: true }).check();
  await dismissToast(healthPage);
  await healthPage.evaluate(() => scrollTo(0, 0));
  await healthPage.screenshot({ path: "screenshots/actions-desktop-health.png", fullPage: true });
  await healthPage.setViewportSize({ width: 390, height: 844 });
  await healthPage.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
  );
  await check(
    "mobile selection toolbar and expanded health details fit 390px viewport",
    async () => {
      assert(await noOverflow(healthPage));
      assert(await health.evaluate((element) => element.scrollWidth <= element.clientWidth));
      assert(
        await healthPage
          .locator(".address-selection-bar")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      );
    },
  );
  await healthPage.screenshot({ path: "screenshots/actions-mobile-health.png", fullPage: true });
  await check(
    "all action and sync-health browser checks have no runtime or console errors",
    async () => assert.deepEqual(errors, []),
  );
  console.log(
    `Address actions/view/health browser: ${checks} checks passed. Public-provider fixtures only; no live API availability claims.`,
  );
} catch (error) {
  await page.screenshot({ path: "screenshots/actions-failure.png", fullPage: true });
  console.error("Browser errors:", errors);
  throw error;
} finally {
  releaseRefresh();
  await Promise.all(contexts.map((item) => item.close()));
  await browser.close();
}
