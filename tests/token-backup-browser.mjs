/** Public token-watch JSON round trips use local storage and public-RPC fixtures only. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { base58 } from "@scure/base";
import { chromium } from "playwright";

const origin = new URL(process.env.TEST_BASE_URL || "http://127.0.0.1:8080").origin;
const STORAGE = "fathom.token-watch.v1";
const ETH_OWNER = "0x1111111111111111111111111111111111111111";
const ETH_TOKEN = "0x2222222222222222222222222222222222222222";
const NEW_TOKEN = "0x3333333333333333333333333333333333333333";
const SOL_OWNER = base58.encode(new Uint8Array(32).fill(1));
const SOL_MINT = base58.encode(new Uint8Array(32).fill(2));
const PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const initial = [
  {
    id: "current-token-id",
    ownerId: "current-eth",
    chain: "ethereum",
    ownerAddress: ETH_OWNER,
    tokenAddress: ETH_TOKEN,
    label: "Existing ERC label",
  },
];
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const contexts = [];
const errors = [];
const unexpected = [];
let checks = 0;

async function check(name, run) {
  await run();
  checks += 1;
  console.log(`PASS ${name}`);
}
function backup(entries) {
  return { version: 1, kind: "fathom-public-token-watches", entries };
}
function entry(chain, ownerAddress, tokenAddress, label) {
  return { chain, ownerAddress, tokenAddress, label };
}
function word(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}
async function fixtureContext(prefix = "current", entries = initial) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  contexts.push(context);
  const requests = [];
  await context.addInitScript(
    ({ origin, prefix, entries }) => {
      if (location.origin !== origin || localStorage.getItem("fathom.ledger.v1") !== null) return;
      const owners = [
        {
          id: `${prefix}-eth`,
          chain: "ethereum",
          address: "0x1111111111111111111111111111111111111111",
          label: "Public Ethereum owner",
          addedAt: 1,
        },
        {
          id: `${prefix}-sol`,
          chain: "solana",
          address: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
          label: "Public Solana owner",
          addedAt: 2,
        },
      ];
      localStorage.setItem(
        "fathom.ledger.v1",
        JSON.stringify({ version: 0, state: { watched: owners, wallets: [] } }),
      );
      localStorage.setItem("fathom.token-watch.v1", JSON.stringify({ version: 1, entries }));
      localStorage.setItem(
        "fathom.preferences.v1",
        JSON.stringify({ version: 1, hideBalances: false, syncPaused: false, refreshInterval: 0 }),
      );
      localStorage.setItem("backup-test-private-marker", "Never export private fixture data");
    },
    { origin, prefix, entries },
  );
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    const fulfill = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(body),
      });
    if (url.hostname === "api.coingecko.com")
      return fulfill({ bitcoin: { usd: 65000 }, ethereum: { usd: 3000 }, solana: { usd: 150 } });
    if (url.hostname === "eth.blockscout.com")
      return fulfill(
        url.pathname.endsWith("/transactions")
          ? { items: [], next_page_params: null }
          : { coin_balance: "0", exchange_rate: "3000" },
      );
    if (["ethereum-rpc.publicnode.com", "solana-rpc.publicnode.com"].includes(url.hostname)) {
      if (request.method() === "OPTIONS")
        return route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "content-type",
            "access-control-allow-methods": "POST",
          },
        });
      assert.equal(request.method(), "POST");
      const rpc = request.postDataJSON();
      const answer = (result) => fulfill({ jsonrpc: "2.0", id: rpc.id, result });
      if (rpc.method === "eth_getBalance") return answer("0x0");
      if (rpc.method === "getBalance") return answer({ value: 0 });
      if (rpc.method === "getSignaturesForAddress") return answer([]);
      requests.push(rpc);
      if (rpc.method === "eth_chainId") return answer("0x1");
      if (rpc.method === "eth_call") {
        const call = rpc.params[0];
        assert.ok([ETH_TOKEN, NEW_TOKEN].includes(call.to));
        if (call.data === `0x70a08231${ETH_OWNER.slice(2).padStart(64, "0")}`)
          return answer(word(1000000));
        if (call.data === "0x313ce567") return answer(word(6));
        if (["0x95d89b41", "0x06fdde03"].includes(call.data))
          return answer(`0x${Buffer.from("TOK").toString("hex").padEnd(64, "0")}`);
        throw new Error(`Unexpected token call ${call.data}`);
      }
      if (rpc.method === "getAccountInfo") {
        assert.equal(rpc.params[0], SOL_MINT);
        return answer({
          value: {
            owner: PROGRAM,
            executable: false,
            data: {
              program: "spl-token",
              parsed: {
                type: "mint",
                info: { isInitialized: true, decimals: 6, supply: "10000000" },
              },
            },
          },
        });
      }
      assert.equal(rpc.method, "getTokenAccountsByOwner");
      assert.equal(rpc.params[0], SOL_OWNER);
      assert.deepEqual(rpc.params[1], { mint: SOL_MINT });
      return answer({
        value: [
          {
            pubkey: base58.encode(new Uint8Array(32).fill(3)),
            account: {
              owner: PROGRAM,
              executable: false,
              data: {
                program: "spl-token",
                parsed: {
                  type: "account",
                  info: {
                    owner: SOL_OWNER,
                    mint: SOL_MINT,
                    state: "initialized",
                    tokenAmount: { amount: "2500000", decimals: 6 },
                  },
                },
              },
            },
          },
        ],
      });
    }
    unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  const region = page.getByRole("region", { name: "Read-only token balances", exact: true });
  await region.waitFor();
  await page.waitForFunction(() => {
    const input = document.querySelector('.token-backups input[type="file"]');
    return input && !input.disabled;
  });
  if (entries.length) {
    await region.getByText("1 TOK", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Refresh all", exact: true }).waitFor();
  }
  const controls = region.locator("details.token-backups");
  await controls.locator("summary").click();
  return { page, region, controls, requests };
}
async function saved(page) {
  return page.evaluate((key) => localStorage.getItem(key), STORAGE);
}
async function upload(controls, value, name = "Fathom-public-token-watch-backup.json") {
  await controls.getByLabel("Import token-watch JSON", { exact: true }).setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
  });
}
async function exported(page, controls) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    controls.getByRole("button", { name: "Export token watches", exact: true }).click(),
  ]);
  assert.equal(download.suggestedFilename(), "fathom-public-token-watches.json");
  return JSON.parse(await readFile(await download.path(), "utf8"));
}
async function palette(root) {
  const violations = await root.evaluate((element) => {
    const text = new Set(["rgb(153, 153, 153)", "rgb(102, 102, 102)", "rgb(51, 51, 51)"]);
    const bad = [];
    for (const node of [element, ...element.querySelectorAll("*")]) {
      if (!node.getClientRects().length) continue;
      const style = getComputedStyle(node);
      if (!text.has(style.color)) bad.push(`${node.tagName}:color:${style.color}`);
      if (
        !["rgba(0, 0, 0, 0)", "transparent", "rgb(255, 255, 255)"].includes(style.backgroundColor)
      )
        bad.push(`${node.tagName}:background:${style.backgroundColor}`);
      for (const edge of ["Top", "Right", "Bottom", "Left"]) {
        if (
          style[`border${edge}Style`] !== "none" &&
          parseFloat(style[`border${edge}Width`]) > 0 &&
          style[`border${edge}Color`] !== "rgb(204, 204, 204)"
        )
          bad.push(`${node.tagName}:border:${style[`border${edge}Color`]}`);
      }
      if (
        style.outlineStyle !== "none" &&
        parseFloat(style.outlineWidth) > 0 &&
        style.outlineColor !== "rgb(204, 204, 204)"
      )
        bad.push(`${node.tagName}:outline:${style.outlineColor}`);
    }
    return [...new Set(bad)];
  });
  assert.deepEqual(violations, []);
}

try {
  const { page, region, controls, requests } = await fixtureContext();
  const before = await saved(page);
  await check(
    "JSON export contains only public configuration and excludes local identifiers and balances",
    async () => {
      const value = await exported(page, controls);
      assert.deepEqual(Object.keys(value).sort(), ["entries", "kind", "version"]);
      assert.equal(value.version, 1);
      assert.equal(value.kind, "fathom-public-token-watches");
      assert.deepEqual(value.entries, [
        entry("ethereum", ETH_OWNER, ETH_TOKEN, "Existing ERC label"),
      ]);
      for (const row of value.entries)
        assert.deepEqual(Object.keys(row).sort(), [
          "chain",
          "label",
          "ownerAddress",
          "tokenAddress",
        ]);
      assert.ok(!JSON.stringify(value).includes("current-token-id"));
      assert.ok(!JSON.stringify(value).includes("current-eth"));
      assert.ok(!JSON.stringify(value).includes("Never export private fixture data"));
    },
  );
  const mixed = backup([
    entry("ethereum", ETH_OWNER, ETH_TOKEN, "Do not overwrite existing label"),
    entry("ethereum", ETH_OWNER, NEW_TOKEN, "Imported ERC 🌙"),
    entry("ethereum", ETH_OWNER, NEW_TOKEN, "Duplicate new token"),
    entry("solana", SOL_OWNER, SOL_MINT, "Imported SPL 🪐"),
    entry(
      "ethereum",
      "0x4444444444444444444444444444444444444444",
      "0x5555555555555555555555555555555555555555",
      "Unmatched public owner",
    ),
  ]);
  const preview = controls.getByLabel("Token import preview", { exact: true });
  await check(
    "choosing a file previews duplicate and unmatched counts without saving or reading RPC",
    async () => {
      const count = requests.length;
      await upload(controls, mixed);
      await preview
        .getByText("2 new watches · 2 duplicates · 1 unmatched owners", { exact: true })
        .waitFor();
      assert.equal(await saved(page), before);
      assert.equal(await region.locator("tbody tr").count(), 1);
      await page.waitForTimeout(150);
      assert.equal(requests.length, count);
    },
  );
  await check(
    "token import preview fits desktop and mobile and preserves the exact palette",
    async () => {
      await palette(controls);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForFunction(() => window.scrollY === 0);
      await page.screenshot({
        path: "/workspace/shared/downloads/Fathom-dashboard-desktop.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(
        () => document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
      );
      await preview.getByRole("button", { name: "Merge 2 token watches", exact: true }).focus();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await palette(controls);
      await page.screenshot({
        path: "/workspace/shared/downloads/Fathom-dashboard-mobile.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
    },
  );
  await check("canceling a preview leaves the watch configuration unchanged", async () => {
    const count = requests.length;
    await preview.getByRole("button", { name: "Cancel import", exact: true }).click();
    assert.equal(await preview.count(), 0);
    assert.equal(await saved(page), before);
    assert.equal(requests.length, count);
  });
  await check(
    "a rejected local-storage write preserves the existing configuration and retryable preview",
    async () => {
      await upload(controls, mixed);
      await preview.getByRole("button", { name: "Merge 2 token watches", exact: true }).waitFor();
      await page.evaluate((key) => {
        const original = Storage.prototype.setItem;
        window.__rejectTokenBackupWrite = true;
        Storage.prototype.setItem = function (name, value) {
          if (name === key && window.__rejectTokenBackupWrite)
            throw new DOMException("Fixture storage quota", "QuotaExceededError");
          return original.call(this, name, value);
        };
      }, STORAGE);
      const count = requests.length;
      await preview.getByRole("button", { name: "Merge 2 token watches", exact: true }).click();
      await region
        .getByRole("alert")
        .filter({ hasText: "Could not save token configuration" })
        .waitFor();
      assert.equal(await saved(page), before);
      assert.equal(await preview.count(), 1);
      assert.equal(await region.locator("tbody tr").count(), 1);
      assert.equal(requests.length, count);
      await page.evaluate(() => {
        window.__rejectTokenBackupWrite = false;
      });
    },
  );
  await check(
    "confirmation merges Ethereum and Solana watches using current public owner identities",
    async () => {
      await preview.getByRole("button", { name: "Merge 2 token watches", exact: true }).click();
      await controls.getByText("Imported 2 token watches.", { exact: true }).waitFor();
      const value = JSON.parse(await saved(page));
      assert.equal(value.entries.length, 3);
      assert.deepEqual(value.entries[0], initial[0]);
      assert.equal(
        value.entries.find((row) => row.tokenAddress === NEW_TOKEN).ownerId,
        "current-eth",
      );
      assert.equal(
        value.entries.find((row) => row.tokenAddress === SOL_MINT).ownerId,
        "current-sol",
      );
      assert.ok(
        value.entries.every(
          (row) => row.ownerAddress !== "0x4444444444444444444444444444444444444444",
        ),
      );
      await page.getByRole("button", { name: "Refresh all", exact: true }).waitFor();
      await region
        .locator("tbody tr")
        .filter({ hasText: "Imported SPL 🪐" })
        .getByText("2.5", { exact: true })
        .waitFor();
    },
  );
  const merged = await saved(page);
  await check(
    "one unknown field rejects the whole backup including otherwise valid new rows",
    async () => {
      const count = requests.length;
      await upload(
        controls,
        backup([
          entry(
            "ethereum",
            ETH_OWNER,
            "0x6666666666666666666666666666666666666666",
            "Must not partially import",
          ),
          { ...entry("ethereum", ETH_OWNER, ETH_TOKEN, "Forged duplicate"), balance: "999999" },
        ]),
        "invalid-mixed-backup.json",
      );
      await controls
        .getByRole("alert")
        .filter({ hasText: "may contain only the network" })
        .waitFor();
      assert.equal(await preview.count(), 0);
      assert.equal(await saved(page), merged);
      assert.equal(requests.length, count);
    },
  );
  await check(
    "files above the byte limit are rejected without a preview or partial writes",
    async () => {
      const count = requests.length;
      await upload(controls, " ".repeat(65537), "oversized-token-backup.json");
      await controls.getByRole("alert").filter({ hasText: "no larger than 64 KiB" }).waitFor();
      assert.equal(await preview.count(), 0);
      assert.equal(await saved(page), merged);
      assert.equal(requests.length, count);
    },
  );
  await check(
    "exported watches restore in another browser with different local owner IDs",
    async () => {
      const portable = await exported(page, controls);
      const restored = await fixtureContext("restored", []);
      await upload(restored.controls, portable, "restored-public-token-watches.json");
      const restoredPreview = restored.controls.getByLabel("Token import preview", { exact: true });
      await restoredPreview
        .getByText("3 new watches · 0 duplicates · 0 unmatched owners", { exact: true })
        .waitFor();
      await restoredPreview
        .getByRole("button", { name: "Merge 3 token watches", exact: true })
        .click();
      await restored.controls.getByText("Imported 3 token watches.", { exact: true }).waitFor();
      const entries = JSON.parse(await saved(restored.page)).entries;
      assert.equal(entries.length, 3);
      assert.ok(
        entries.every(
          (row) => row.ownerId === (row.chain === "ethereum" ? "restored-eth" : "restored-sol"),
        ),
      );
      assert.ok(entries.every((row) => !row.id.startsWith("current")));
    },
  );
  await check("backup flows have no runtime errors or unexpected external requests", async () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
  });
  console.log(
    `Token backup browser: ${checks} checks passed. Public JSON and RPC fixtures only; no wallet keys, payments, or deployment.`,
  );
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
