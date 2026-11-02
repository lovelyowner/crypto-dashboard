import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const page = await context.newPage();
const errors = [];
const requestBodies = [];
page.on("request", (request) => {
  if (request.postData()) requestBodies.push(request.postData());
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === new URL(baseURL).origin) return route.continue();
  let body = {};
  if (url.hostname === "api.coingecko.com")
    body = { bitcoin: { usd: 65000 }, ethereum: { usd: 3000 } };
  else if (url.hostname === "mempool.space" && url.pathname.endsWith("/txs"))
    body = [
      {
        txid: "b".repeat(64),
        status: { confirmed: true, block_time: Math.floor(Date.now() / 1000) - 60 },
        vin: [
          {
            prevout: {
              scriptpubkey_address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
              value: 100000000,
            },
          },
        ],
        vout: [{ scriptpubkey_address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", value: 100000000 }],
      },
    ];
  else if (url.hostname === "mempool.space")
    body = {
      chain_stats: { funded_txo_sum: 200000000, spent_txo_sum: 100000000 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
    };
  else return route.abort("blockedbyclient");
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
    headers: { "access-control-allow-origin": "*" },
  });
});
let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log(`PASS ${name}`);
}
try {
  await mkdir("screenshots", { recursive: true });
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.waitForSelector(".address-empty");
  await check("desktop dashboard renders empty local workspace", async () =>
    assert.equal(
      await page.getByRole("heading", { name: "Your crypto, in perspective." }).count(),
      1,
    ),
  );
  await page.screenshot({ path: "screenshots/new-desktop-empty.png", fullPage: true });
  await page.getByRole("button", { name: "Add address", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").selectOption("bitcoin");
  await dialog
    .getByLabel("Public address", { exact: true })
    .fill("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb");
  await dialog.getByRole("checkbox").check();
  await check("bad Bitcoin checksum prevents address submission", async () =>
    assert.equal(await dialog.getByRole("button", { name: "Add to workspace" }).isDisabled(), true),
  );
  await dialog
    .getByLabel("Public address", { exact: true })
    .fill("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
  await dialog.getByLabel("Label optional").fill("QA genesis");
  await dialog.getByRole("button", { name: "Add to workspace" }).click();
  await page.waitForSelector(".address-card");
  await page.getByText("1 BTC", { exact: true }).waitFor();
  await check("added address loads native balance from browser adapter", async () =>
    assert.match(await page.locator(".address-balance").textContent(), /1\s+BTC/),
  );
  await check("recent transaction rendered from provider data", async () =>
    assert.equal(await page.locator(".mini-tx").count(), 1),
  );
  await check("only public watchlist persisted", async () => {
    const raw = await page.evaluate(() => JSON.parse(localStorage.getItem("fathom.ledger.v1")));
    assert.equal(raw.state.watched[0].label, "QA genesis");
    assert.equal(raw.state.wallets.length, 0);
  });
  if (await page.getByRole("button", { name: "Dismiss notification" }).count())
    await page.getByRole("button", { name: "Dismiss notification" }).click();
  await page.screenshot({ path: "screenshots/new-desktop-populated.png", fullPage: true });
  await page.getByRole("textbox", { name: "Search workspace" }).fill("no matching address");
  await check("search filters unmatched address", async () => {
    await page.getByRole("heading", { name: "No matching addresses" }).waitFor();
  });
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByRole("combobox", { name: "Filter by network" }).selectOption("cosmos");
  await check("network filter excludes unrelated address", async () => {
    await page.getByRole("heading", { name: "No matching addresses" }).waitFor();
  });
  await page.getByRole("combobox", { name: "Filter by network" }).selectOption("all");
  await page.getByRole("button", { name: "Transactions 1", exact: true }).click();
  await page.getByRole("heading", { name: "Transaction history" }).waitFor();
  await check("activity table shows received transaction", async () =>
    assert.equal(await page.locator("tbody tr").count(), 1),
  );
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export CSV" }).click(),
  ]);
  await check("transaction CSV download available", async () =>
    assert.equal(download.suggestedFilename(), "fathom-transactions.csv"),
  );
  await page.getByRole("button", { name: "Networks", exact: true }).click();
  await check("network directory contains 22 networks", async () =>
    assert.equal(await page.locator(".network-card").count(), 22),
  );
  await check("Monero privacy limitation visible", async () =>
    assert.match(
      await page.locator(".network-card").filter({ hasText: "Monero" }).textContent(),
      /cannot be read from a public address/,
    ),
  );
  await page.getByRole("button", { name: "Wallets", exact: true }).click();
  await page.getByRole("button", { name: "Open wallet manager" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create a wallet", exact: true })
    .click();
  const words = await page
    .locator(".wallet-words li")
    .evaluateAll((items) => items.map((li) => li.textContent.replace(/^\d+/, "")));
  await check("wallet generation produces 24 recovery words", async () =>
    assert.equal(words.length, 24),
  );
  await page.getByRole("checkbox", { name: /I wrote down/ }).check();
  await page.getByRole("button", { name: "Verify my backup" }).click();
  for (const n of [3, 8, 24])
    await page.getByRole("textbox", { name: `Word ${n}`, exact: true }).fill(words[n - 1]);
  await page.getByLabel("Wallet name", { exact: true }).fill("QA local wallet");
  await page
    .getByLabel("Wallet passphrase", { exact: true })
    .fill("qa cryptographic passphrase ★ 2048");
  await page
    .getByLabel("Confirm wallet passphrase", { exact: true })
    .fill("qa cryptographic passphrase ★ 2048");
  await page.getByRole("button", { name: "Encrypt and save wallet" }).click();
  await page.getByRole("heading", { name: "QA local wallet", exact: true }).waitFor();
  await check("wallet is saved encrypted without plaintext recovery words", async () => {
    const raw = await page.evaluate(() => localStorage.getItem("fathom.ledger.v1"));
    assert(!raw.includes(words.join(" ")));
    assert(!raw.includes("qa cryptographic passphrase ★ 2048"));
    const wallet = JSON.parse(raw).state.wallets[0];
    assert.equal(wallet.encrypted.iterations, 600000);
    assert.equal(wallet.encrypted.kdf, "pbkdf2");
    assert.equal(wallet.encrypted.ciphertext.length > 100, true);
    assert.equal(await page.evaluate(() => localStorage.getItem("fathom.device-key.v1")), null);
  });
  await page.getByRole("button", { name: "Reveal recovery words" }).click();
  await page.getByLabel("Wallet passphrase", { exact: true }).fill("incorrect passphrase");
  await page.getByRole("button", { name: "Unlock locally" }).click();
  await check("wrong wallet passphrase rejects decryption", async () => {
    await page
      .getByRole("alert")
      .filter({ hasText: /passphrase|decrypt|could not/i })
      .waitFor();
    assert.equal(await page.locator(".wallet-words").count(), 0);
  });
  await page
    .getByLabel("Wallet passphrase", { exact: true })
    .fill("qa cryptographic passphrase ★ 2048");
  await page.getByRole("button", { name: "Unlock locally" }).click();
  await page.locator(".wallet-words").waitFor();
  await check("correct passphrase unlocks exact recovery words", async () =>
    assert.equal(await page.locator(".wallet-words li").count(), 24),
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await check("wallet recovery phrase and passphrase never sent in network bodies", async () => {
    assert(
      requestBodies.every(
        (body) =>
          !body.includes(words.join(" ")) && !body.includes("qa cryptographic passphrase ★ 2048"),
      ),
    );
  });
  await check("closing wallet manager clears sensitive DOM", async () =>
    assert.equal(await page.locator(".wallet-words").count(), 0),
  );
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove QA genesis", exact: true }).click();
  await check("remove watched address updates empty state", async () => {
    await page.locator(".address-empty").waitFor();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
  );
  if (await page.getByRole("button", { name: "Dismiss notification" }).count())
    await page.getByRole("button", { name: "Dismiss notification" }).click();
  await page.screenshot({ path: "screenshots/new-mobile.png", fullPage: true });
  await check("mobile page has no horizontal overflow", async () =>
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)),
  );
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByRole("button", { name: "Networks", exact: true }).click();
  await check("mobile sidebar navigates and closes", async () => {
    await page.getByRole("heading", { name: "Explore the networks." }).waitFor();
    assert.equal(await page.locator(".sidebar.is-open").count(), 0);
  });
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
  );
  await page.screenshot({ path: "screenshots/new-mobile-networks.png", fullPage: true });
  await check("mobile network directory has no horizontal overflow", async () =>
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)),
  );
  await check("no browser runtime errors", async () => assert.deepEqual(errors, []));
  console.log(
    `Browser smoke: ${checks} checks passed (mocked public APIs; no external OAuth or live chain availability claimed).`,
  );
} finally {
  await browser.close();
}
