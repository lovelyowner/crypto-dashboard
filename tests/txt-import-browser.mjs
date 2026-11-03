import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { bech32 } from "@scure/base";
import { chromium } from "playwright";

const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";
const origin = new URL(baseURL).origin;
const BTC = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ETH = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SOL = "11111111111111111111111111111111";
const XRP = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const COSMOS = bech32.encode("cosmos", bech32.toWords(new Uint8Array(20).fill(17)));
const hash = "b".repeat(64);
const date = "2026-01-01T23:59:59.000Z";
const fixture = {
  txid: hash,
  status: { confirmed: true, block_time: Date.parse(date) / 1000 },
  vin: [{ prevout: { scriptpubkey_address: "counterparty", value: 12345678 } }],
  vout: [{ scriptpubkey_address: BTC, value: 12345678 }],
};
const mixed = `\uFEFF# public watchlist\r\n\r\n${BTC}, Genesis 🌙\r\nalice.near, NEAR named\r\n${ETH}, Main ETH\r\nbase:${ETH}, Explicit Base\r\n${SOL}, SOL system\r\n${COSMOS}, Cosmos treasury\r\n${XRP}, XRP genesis\r\n${BTC}, Duplicate Genesis`;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync(chromium.executablePath()) ? chromium.executablePath() : "/usr/bin/chromium"),
  headless: true,
  args: ["--no-sandbox"],
});
let checks = 0;
const errors = [];
let externalRequests = 0;
const postBodies = [];
const contexts = [];
async function check(name, fn) {
  await fn();
  checks++;
  console.log(`PASS ${name}`);
}
async function createContext(paused, timezoneId = "UTC") {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    timezoneId,
  });
  contexts.push(context);
  context.on("page", (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("request", (request) => {
      if (request.postData()) postBodies.push(request.postData());
    });
  });
  await context.addInitScript(
    ({ origin, paused }) => {
      if (location.origin !== origin) return;
      if (localStorage.getItem("fathom.preferences.v1") === null)
        localStorage.setItem(
          "fathom.preferences.v1",
          JSON.stringify({
            version: 1,
            hideBalances: false,
            syncPaused: paused,
            refreshInterval: 0,
          }),
        );
    },
    { origin, paused },
  );
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname.startsWith("/api/auth/"))
      return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    if (url.origin === origin) return route.continue();
    externalRequests++;
    let body;
    if (url.hostname === "api.coingecko.com") body = { bitcoin: { usd: 65000 } };
    else if (url.hostname === "mempool.space" && url.pathname === "/api/v1/prices")
      body = { USD: 65000 };
    else if (url.hostname === "mempool.space" && url.pathname === `/api/address/${BTC}/txs`)
      body = [fixture];
    else if (url.hostname === "mempool.space" && url.pathname === `/api/address/${BTC}`)
      body = {
        chain_stats: { funded_txo_sum: 12345678, spent_txo_sum: 0 },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
      };
    else throw new Error(`Unexpected provider request: ${url.hostname}${url.pathname}`);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    });
  });
  return context;
}
async function countSaved(page) {
  return page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("fathom.ledger.v1") || '{"state":{"watched":[]}}').state
        .watched.length,
  );
}
async function upload(page, text, name = "addresses.txt") {
  await page
    .getByLabel("Upload addresses TXT file", { exact: true })
    .setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: typeof text === "string" ? Buffer.from(text) : text,
    });
}
async function openFileImport(page) {
  await page.getByRole("button", { name: "Import TXT addresses", exact: true }).click();
  await page.getByRole("heading", { name: "Import addresses from TXT", exact: true }).waitFor();
}
async function dismissToast(page) {
  if (await page.getByRole("button", { name: "Dismiss notification" }).count())
    await page.getByRole("button", { name: "Dismiss notification" }).click();
}
const context = await createContext(true);
const page = await context.newPage();
try {
  await mkdir("screenshots", { recursive: true });
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.locator(".address-empty").waitFor();
  await openFileImport(page);
  await check("sidebar opens TXT file mode directly", async () =>
    assert.equal(await page.getByLabel("Upload addresses TXT file", { exact: true }).count(), 1),
  );
  await upload(page, `${BTC}\nnot a public address`);
  await page.locator(".txt-import-rows li").nth(1).waitFor();
  await page.getByRole("dialog").getByRole("checkbox").check();
  await check("one invalid TXT row blocks the complete batch", async () => {
    assert.equal(
      await page
        .getByRole("button", { name: "Import detected addresses", exact: true })
        .isDisabled(),
      true,
    );
    assert.match(await page.locator(".txt-import-invalid").textContent(), /Line 2/);
    assert.equal(await countSaved(page), 0);
  });
  await upload(page, Buffer.alloc(200001, 32));
  await check("oversized TXT file clears preview and is rejected", async () => {
    await page
      .getByRole("alert")
      .filter({ hasText: /200 KB/ })
      .waitFor();
    assert.equal(await page.locator(".txt-import-rows li").count(), 0);
    assert.equal(await countSaved(page), 0);
  });
  await upload(page, Buffer.from([0xc3, 0x28]));
  await check("invalid UTF-8 file is rejected without adding rows", async () => {
    await page.getByRole("alert").filter({ hasText: /UTF-8/ }).waitFor();
    assert.equal(await countSaved(page), 0);
  });
  await upload(page, "\uFEFF# comments only\r\n\r\n");
  await check("empty or comment-only TXT file is rejected", async () => {
    await page
      .getByRole("alert")
      .filter({ hasText: /does not contain any public addresses/ })
      .waitFor();
    assert.equal(await countSaved(page), 0);
  });
  await upload(page, BTC, "addresses.json");
  await check("non-TXT extension is rejected", async () => {
    await page
      .getByRole("alert")
      .filter({ hasText: /Choose a .txt file/ })
      .waitFor();
  });
  await upload(page, "a".repeat(64));
  await page.getByLabel("Network for line 1", { exact: true }).waitFor();
  await check("bare 64-digit hexadecimal value is never auto-confirmed as NEAR", async () => {
    assert.equal(await page.getByLabel("Network for line 1", { exact: true }).inputValue(), "");
    assert.match(await page.locator(".txt-row-warning").textContent(), /never a private key/);
    assert.equal(
      await page
        .getByRole("button", { name: "Import detected addresses", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(await countSaved(page), 0);
  });
  await upload(page, mixed);
  await page.waitForFunction(() => document.querySelectorAll(".txt-import-rows li").length === 8);
  await check(
    "UTF-8 BOM and CRLF mixed file preserves rows and auto-detects unique formats",
    async () => {
      assert.match(
        await page.locator(".txt-import-rows li").nth(0).textContent(),
        /Line 3.*Genesis 🌙.*Bitcoin/s,
      );
      assert.match(
        await page.locator(".txt-import-rows li").nth(1).textContent(),
        /NEAR.*detected/s,
      );
      assert.match(
        await page.locator(".txt-import-rows li").nth(4).textContent(),
        /Solana.*detected/s,
      );
      assert.match(
        await page.locator(".txt-import-rows li").nth(5).textContent(),
        /Cosmos.*detected/s,
      );
      assert.match(
        await page.locator(".txt-import-rows li").nth(6).textContent(),
        /XRP.*detected/s,
      );
    },
  );
  await check(
    "plain EVM address remains unresolved and file preview does not mutate storage",
    async () => {
      assert.equal(await page.getByLabel("EVM import network", { exact: true }).inputValue(), "");
      assert.equal(await page.getByLabel("Network for line 5", { exact: true }).inputValue(), "");
      assert.equal(
        await page
          .getByRole("button", { name: "Import detected addresses", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(await countSaved(page), 0);
      assert.equal(externalRequests, 0);
    },
  );
  await page.getByLabel("EVM import network", { exact: true }).selectOption("ethereum");
  await check(
    "shared Ethereum selection resolves unassigned EVM and preserves explicit Base hint",
    async () => {
      assert.equal(
        await page.getByLabel("Network for line 5", { exact: true }).inputValue(),
        "ethereum",
      );
      assert.match(
        await page.locator(".txt-import-rows li").nth(3).textContent(),
        /Explicit Base.*Base.*detected/s,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Import detected addresses", exact: true })
          .isEnabled(),
        true,
      );
    },
  );
  await page.getByLabel("Network for line 5", { exact: true }).selectOption("bnb");
  await check("per-row compatible network choice overrides shared EVM choice", async () =>
    assert.equal(await page.getByLabel("Network for line 5", { exact: true }).inputValue(), "bnb"),
  );
  await page.getByLabel("Network for line 5", { exact: true }).selectOption("");
  await check("clearing a per-row override restores the shared network", async () =>
    assert.equal(
      await page.getByLabel("Network for line 5", { exact: true }).inputValue(),
      "ethereum",
    ),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await check("mixed TXT preview and network controls fit 390px viewport", async () => {
    const box = await page.getByRole("dialog").boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 390);
    assert(
      await page.getByRole("dialog").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
    );
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
  await page.screenshot({ path: "screenshots/txt-mobile-preview.png" });
  await page.keyboard.press("Escape");
  await check("closing TXT preview discards it without adding addresses", async () => {
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await countSaved(page), 0);
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Add address", exact: true }).click();
  await page.getByRole("button", { name: "Upload TXT", exact: true }).click();
  await check("Add address mode selector also opens the TXT importer", async () =>
    assert.equal(
      await page.getByRole("heading", { name: "Import addresses from TXT", exact: true }).count(),
      1,
    ),
  );
  await upload(page, mixed);
  await page.getByLabel("EVM import network", { exact: true }).selectOption("ethereum");
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Import detected addresses", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".address-card").length === 7);
  await check(
    "resolved mixed TXT import saves seven distinct chain-address pairs atomically",
    async () => {
      const saved = await page.evaluate(
        () => JSON.parse(localStorage.getItem("fathom.ledger.v1")).state.watched,
      );
      assert.deepEqual(saved.map((watch) => watch.chain).sort(), [
        "base",
        "bitcoin",
        "cosmos",
        "ethereum",
        "near",
        "solana",
        "xrp",
      ]);
      assert.equal(saved.find((watch) => watch.chain === "ethereum").address, ETH.toLowerCase());
      assert.equal(saved.find((watch) => watch.chain === "base").address, ETH.toLowerCase());
      assert.equal(saved.find((watch) => watch.chain === "bitcoin").label, "Genesis 🌙");
      assert.match(
        await page
          .getByRole("status")
          .filter({ hasText: /Imported 7/ })
          .textContent(),
        /skipped 1 duplicates/,
      );
    },
  );
  await check(
    "imported watch cards and network dropdown use explicit asset-standard labels",
    async () => {
      assert.match(
        await page.locator(".address-card").filter({ hasText: "Main ETH" }).textContent(),
        /Ethereum · ETH \(ERC20\)/,
      );
      assert.match(
        await page
          .getByLabel("Filter by network", { exact: true })
          .locator('option[value="ethereum"]')
          .textContent(),
        /ETH \(ERC20\)/,
      );
      assert.match(
        await page
          .getByLabel("Filter by network", { exact: true })
          .locator('option[value="bnb"]')
          .textContent(),
        /BNB \(BEP20\)/,
      );
      assert.match(
        await page
          .getByLabel("Filter by network", { exact: true })
          .locator('option[value="solana"]')
          .textContent(),
        /SOL \(SPL\)/,
      );
    },
  );
  await check(
    "paused TXT importing never starts provider requests or uploads file data",
    async () => {
      assert.equal(externalRequests, 0);
      assert(
        postBodies.every((body) => !body.includes("alice.near") && !body.includes("Genesis 🌙")),
      );
    },
  );
  await dismissToast(page);
  await page.screenshot({ path: "screenshots/txt-desktop-imported.png", fullPage: true });

  // Date rendering is verified in a distant browser timezone to catch accidental local dates.
  const datesContext = await createContext(false, "Pacific/Auckland");
  const dates = await datesContext.newPage();
  await dates.goto(baseURL, { waitUntil: "networkidle" });
  await dates.getByRole("button", { name: "Add address", exact: true }).click();
  await dates.getByRole("dialog").getByLabel("Public address", { exact: true }).fill(BTC);
  await dates.getByRole("dialog").getByRole("checkbox").check();
  await dates.getByRole("button", { name: "Add to workspace", exact: true }).click();
  await dates.locator(".mini-tx").waitFor();
  await check("mini transaction feed displays fixed dd.mm.yy UTC date", async () => {
    assert.match(await dates.locator(".mini-tx").textContent(), /01\.01\.26/);
    assert(!/ago|02\.01\.26/.test(await dates.locator(".mini-tx").textContent()));
  });
  await dates.getByRole("button", { name: "Activity", exact: true }).click();
  await dates.locator("tbody tr").waitFor();
  await check(
    "transaction table displays dd.mm.yy while preserving exact ISO timestamp",
    async () => {
      assert.equal(await dates.locator("tbody time").textContent(), "01.01.26");
      assert.equal(await dates.locator("tbody time").getAttribute("datetime"), date);
      assert.match(await dates.locator("tbody td").nth(1).textContent(), /Bitcoin · BTC/);
    },
  );
  const [download] = await Promise.all([
    dates.waitForEvent("download"),
    dates.getByRole("button", { name: "Export CSV", exact: true }).click(),
  ]);
  const csv = await readFile(await download.path(), "utf8");
  await check("CSV preserves full timestamp and includes requested calendar date", async () => {
    assert(csv.includes(date));
    assert(csv.includes("01.01.26"));
    assert(csv.includes(hash));
    assert(csv.includes("0.12345678"));
  });
  await dismissToast(dates);
  await dates.screenshot({ path: "screenshots/txt-date-format.png", fullPage: true });
  await check("TXT/date browser suite has no runtime or console errors", async () =>
    assert.deepEqual(errors, []),
  );
  console.log(
    `TXT/date browser: ${checks} checks passed. Public-provider requests are mocked; TXT files are uploaded only to the browser file input.`,
  );
} catch (error) {
  await page.screenshot({ path: "screenshots/txt-failure.png", fullPage: true });
  console.error("Browser errors:", errors);
  throw error;
} finally {
  await Promise.all(contexts.map((item) => item.close()));
  await browser.close();
}
