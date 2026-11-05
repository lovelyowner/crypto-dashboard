/** Explicit ERC20/SPL reads use bounded public-RPC fixtures only.
 * No real balances, token transfers, approvals, signing, or external requests are sent.
 */
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { chromium } from "playwright";

const origin = new URL(process.env.TEST_BASE_URL || "http://127.0.0.1:8080").origin;
const ETH_OWNER = "0x1111111111111111111111111111111111111111";
const ETH_TOKEN = "0x2222222222222222222222222222222222222222";
const SOL_OWNER = base58.encode(new Uint8Array(32).fill(1));
const SOL_MINT = base58.encode(new Uint8Array(32).fill(2));
const SPL_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ETH_RAW = "9007199254740993123456789012345678";
const ETH_EXACT = "9007199254740993.123456789012345678";
const SOL_EXACT = "18014398.509481987";
const owners = [
  { id: "owner-eth", chain: "ethereum", address: ETH_OWNER, label: "Ethereum owner", addedAt: 1 },
  { id: "owner-sol", chain: "solana", address: SOL_OWNER, label: "Solana owner", addedAt: 2 },
];
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const errors = [];
const unexpected = [];
const tokenRequests = [];
page.on("pageerror", (error) => errors.push(error.message));
let ethereumState = "ready";
let checks = 0;

function word(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}
function textWord(value) {
  return `0x${Buffer.from(value).toString("hex").padEnd(64, "0")}`;
}
async function fulfill(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  });
}
async function check(name, run) {
  await run();
  checks += 1;
  console.log(`PASS ${name}`);
}
async function configuration() {
  return page.evaluate(() => JSON.parse(localStorage.getItem("fathom.token-watch.v1")));
}
async function addToken(region, owner, address, label) {
  const toggle = region.getByRole("button", { name: "Watch token", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await region.getByLabel("Watched public owner").selectOption(owner);
  await region
    .getByLabel(owner === "owner-sol" ? "SPL mint address" : "ERC20 contract or SPL mint address", {
      exact: true,
    })
    .fill(address);
  await region.getByLabel("Token label (optional)", { exact: true }).fill(label);
  await region.getByRole("button", { name: "Save token watch", exact: true }).click();
}
async function refresh() {
  await page.getByRole("button", { name: "Refresh all", exact: true }).click();
}
async function palette(region) {
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

await context.addInitScript(
  ({ origin, owners }) => {
    if (location.origin !== origin || localStorage.getItem("fathom.ledger.v1") !== null) return;
    localStorage.setItem(
      "fathom.ledger.v1",
      JSON.stringify({ version: 0, state: { watched: owners, wallets: [] } }),
    );
    localStorage.setItem(
      "fathom.preferences.v1",
      JSON.stringify({ version: 1, hideBalances: false, syncPaused: false, refreshInterval: 0 }),
    );
  },
  { origin, owners },
);
await context.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === origin) return route.continue();
  if (url.hostname === "api.coingecko.com")
    return fulfill(route, {
      bitcoin: { usd: 65000 },
      ethereum: { usd: 3000 },
      solana: { usd: 150 },
    });
  if (url.hostname === "eth.blockscout.com") {
    if (url.pathname.endsWith("/transactions"))
      return fulfill(route, { items: [], next_page_params: null });
    return fulfill(route, { coin_balance: "0", exchange_rate: "3000" });
  }
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
    assert.equal(rpc.jsonrpc, "2.0");
    const answer = (result) => fulfill(route, { jsonrpc: "2.0", id: rpc.id, result });
    if (rpc.method === "eth_getBalance") return answer("0x0");
    if (rpc.method === "getBalance") return answer({ value: 0 });
    if (rpc.method === "getSignaturesForAddress") return answer([]);
    tokenRequests.push({ host: url.hostname, ...rpc });
    if (url.hostname === "ethereum-rpc.publicnode.com") {
      if (ethereumState === "unavailable")
        return fulfill(route, { message: "Fixture public RPC outage" }, 503);
      if (rpc.method === "eth_chainId") {
        assert.deepEqual(rpc.params, []);
        return answer(ethereumState === "wrong-chain" ? "0x2" : "0x1");
      }
      assert.equal(rpc.method, "eth_call");
      assert.equal(rpc.params[1], "latest");
      const call = rpc.params[0];
      assert.equal(call.to, ETH_TOKEN);
      if (call.data === `0x70a08231${ETH_OWNER.slice(2).padStart(64, "0")}`)
        return answer(word(ETH_RAW));
      if (call.data === "0x313ce567") return answer(word(18));
      if (call.data === "0x95d89b41")
        return answer(ethereumState === "metadata" ? "0x" : textWord("HUGE"));
      if (call.data === "0x06fdde03")
        return answer(ethereumState === "metadata" ? "0x" : textWord("Exact fixture token"));
      throw new Error(`Unexpected read selector ${call.data}`);
    }
    if (rpc.method === "getAccountInfo") {
      assert.deepEqual(rpc.params, [SOL_MINT, { encoding: "jsonParsed", commitment: "finalized" }]);
      return answer({
        value: {
          owner: SPL_PROGRAM,
          executable: false,
          data: {
            program: "spl-token",
            parsed: {
              type: "mint",
              info: { isInitialized: true, decimals: 9, supply: "18446744073709551615" },
            },
          },
        },
      });
    }
    assert.equal(rpc.method, "getTokenAccountsByOwner");
    assert.deepEqual(rpc.params, [
      SOL_OWNER,
      { mint: SOL_MINT },
      { encoding: "jsonParsed", commitment: "finalized" },
    ]);
    return answer({
      value: ["9007199254740993", "9007199254740994"].map((amount, index) => ({
        pubkey: base58.encode(new Uint8Array(32).fill(index + 3)),
        account: {
          owner: SPL_PROGRAM,
          executable: false,
          data: {
            program: "spl-token",
            parsed: {
              type: "account",
              info: {
                owner: SOL_OWNER,
                mint: SOL_MINT,
                state: "initialized",
                tokenAmount: { amount, decimals: 9, uiAmount: 1 },
              },
            },
          },
        },
      })),
    });
  }
  unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
  return route.abort("blockedbyclient");
});

try {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  const region = page.getByRole("region", { name: "Read-only token balances", exact: true });
  await region.waitFor();
  await check(
    "an explicit Ethereum watch displays exact large units separately from native totals",
    async () => {
      await addToken(region, "owner-eth", ETH_TOKEN, "Huge exact token 🪐");
      await region.getByText(`${ETH_EXACT} HUGE`, { exact: true }).waitFor();
      assert.equal(await region.locator("tbody tr").count(), 1);
      const stored = await configuration();
      assert.equal(stored.entries[0].ownerId, "owner-eth");
      assert.equal(stored.entries[0].tokenAddress, ETH_TOKEN);
      assert.deepEqual(
        Object.keys(stored.entries[0]).sort(),
        ["chain", "id", "label", "ownerAddress", "ownerId", "tokenAddress"].sort(),
      );
      assert.ok(!(await page.locator(".balance-stat").innerText()).includes(ETH_EXACT));
      assert.match(await region.innerText(), /No token prices, transfers, or approvals are used/);
    },
  );
  const ethRow = region.locator("tbody tr").filter({ hasText: "Huge exact token 🪐" });
  await check(
    "duplicate owner/contract configuration is skipped without overwriting its label",
    async () => {
      await addToken(region, "owner-eth", ETH_TOKEN, "Do not replace original");
      await region
        .getByText("This owner and token are already being watched.", { exact: true })
        .waitFor();
      assert.equal((await configuration()).entries.length, 1);
      assert.equal((await configuration()).entries[0].label, "Huge exact token 🪐");
      await region.getByRole("button", { name: "Watch token", exact: true }).click();
    },
  );
  await check("SPL sums raw account units instead of imprecise uiAmount values", async () => {
    await addToken(region, "owner-sol", SOL_MINT, "Summed SPL fixture");
    await region.getByText(SOL_EXACT, { exact: true }).waitFor();
    const row = region.locator("tbody tr").filter({ hasText: "Summed SPL fixture" });
    assert.match(await row.innerText(), /9 decimals · 2 token accounts/);
    assert.match(await row.innerText(), /Solana\/SPL · mainnet · SPL Token/);
    assert.match(await row.innerText(), /Token metadata unavailable/);
    assert.equal((await configuration()).entries.length, 2);
  });
  await check(
    "balance hiding removes exact token amounts from the rendered DOM and survives reload",
    async () => {
      await page.getByRole("button", { name: "Hide balances", exact: true }).click();
      for (const value of await region.locator(".token-balance-value strong").allTextContents())
        assert.equal(value, "••••••");
      assert.ok(!(await region.innerText()).includes(ETH_EXACT));
      assert.ok(!(await region.innerText()).includes(SOL_EXACT));
      await page.reload({ waitUntil: "domcontentloaded" });
      await region.locator(".token-balance-value strong").first().waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Show balances", exact: true }).count(),
        1,
      );
      await page.getByRole("button", { name: "Refresh all", exact: true }).waitFor();
      for (const value of await region.locator(".token-balance-value strong").allTextContents())
        assert.equal(value, "••••••");
      await page.getByRole("button", { name: "Show balances", exact: true }).click();
      await region.getByText(`${ETH_EXACT} HUGE`, { exact: true }).waitFor();
    },
  );
  await check(
    "public RPC failures and a wrong chain replace old amounts with explicit failure states",
    async () => {
      ethereumState = "unavailable";
      await refresh();
      await ethRow.getByText("Unavailable", { exact: true }).waitFor();
      assert.match(await ethRow.innerText(), /Public RPC unavailable/);
      assert.ok(!(await ethRow.innerText()).includes(ETH_EXACT));
      ethereumState = "wrong-chain";
      await refresh();
      await ethRow.getByText("Unsupported", { exact: true }).waitFor();
      assert.match(await ethRow.innerText(), /not on Ethereum mainnet/);
      ethereumState = "metadata";
      await refresh();
      await ethRow.getByText(ETH_EXACT, { exact: true }).waitFor();
      assert.match(await ethRow.innerText(), /Token metadata unavailable/);
      ethereumState = "ready";
      await refresh();
      await ethRow.getByText(`${ETH_EXACT} HUGE`, { exact: true }).waitFor();
    },
  );
  await check(
    "search narrows public token watches without changing the saved configuration",
    async () => {
      await region.getByLabel("Search token watches", { exact: true }).fill("summed SPL");
      assert.equal(await region.locator("tbody tr").count(), 1);
      assert.match(await region.locator("tbody").innerText(), /Summed SPL fixture/);
      assert.equal((await configuration()).entries.length, 2);
      await region
        .getByLabel("Search token watches", { exact: true })
        .fill("No matching token fixture");
      await region.getByText("No token watches match this search.", { exact: true }).waitFor();
      await region.getByLabel("Search token watches", { exact: true }).fill("");
    },
  );
  await check("pause and offline state stop token reads and disable manual refresh", async () => {
    await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
    await page.getByRole("switch", { name: "Pause network sync", exact: true }).check();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await region.getByText("Token reads paused", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Refresh all", exact: true }).isDisabled(),
      true,
    );
    const before = tokenRequests.length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(150);
    assert.equal(tokenRequests.length, before);
    await page.getByRole("button", { name: "Resume sync", exact: true }).click();
    await page.getByRole("button", { name: "Refresh all", exact: true }).waitFor();
    await context.setOffline(true);
    await region.getByText("Offline · reads stopped", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Refresh all", exact: true }).isDisabled(),
      true,
    );
    await context.setOffline(false);
    await page.getByRole("button", { name: "Refresh all", exact: true }).waitFor();
  });
  await check(
    "removing an owner stops its reads but retains its removable token configuration",
    async () => {
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "Remove Ethereum owner", exact: true }).click();
      await ethRow.getByText("Reads stopped", { exact: true }).waitFor();
      assert.match(await ethRow.innerText(), /Owner no longer watched/);
      const before = tokenRequests.filter(
        (request) => request.host === "ethereum-rpc.publicnode.com",
      ).length;
      await refresh();
      await page.getByRole("button", { name: "Refresh all", exact: true }).waitFor();
      assert.equal(
        tokenRequests.filter((request) => request.host === "ethereum-rpc.publicnode.com").length,
        before,
      );
      assert.equal((await configuration()).entries.length, 2);
      await page.getByRole("button", { name: "Add address", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Network", { exact: true }).selectOption("ethereum");
      await dialog.getByLabel("Public address", { exact: true }).fill(ETH_OWNER);
      await dialog.locator('input[maxlength="80"]').fill("Ethereum owner");
      await dialog.getByRole("checkbox").check();
      await dialog.getByRole("button", { name: "Add to workspace", exact: true }).click();
      await ethRow.getByRole("button", { name: "Review owner", exact: true }).click();
      await ethRow.getByText("Reads stopped", { exact: true }).waitFor();
      const beforeReview = tokenRequests.filter(
        (request) => request.host === "ethereum-rpc.publicnode.com",
      ).length;
      await page.evaluate(() => {
        window.originalTokenSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === "fathom.token-watch.v1")
            throw new DOMException("Fixture quota", "QuotaExceededError");
          return window.originalTokenSetItem.call(this, key, value);
        };
      });
      await ethRow.getByRole("button", { name: "Confirm reattachment", exact: true }).click();
      await region
        .getByRole("alert")
        .filter({ hasText: "Could not save token configuration" })
        .waitFor();
      assert.equal(
        (await configuration()).entries.find((entry) => entry.chain === "ethereum").ownerId,
        "owner-eth",
      );
      assert.equal(
        tokenRequests.filter((request) => request.host === "ethereum-rpc.publicnode.com").length,
        beforeReview,
      );
      await page.evaluate(() => {
        Storage.prototype.setItem = window.originalTokenSetItem;
      });
      await ethRow.getByRole("button", { name: "Confirm reattachment", exact: true }).click();
      await region
        .getByText("Token owner reattached. Public reads can resume.", { exact: true })
        .waitFor();
      await ethRow.getByText(`${ETH_EXACT} HUGE`, { exact: true }).waitFor();
      assert.notEqual(
        (await configuration()).entries.find((entry) => entry.chain === "ethereum").ownerId,
        "owner-eth",
      );
      page.once("dialog", (value) => value.accept());
      await page.getByRole("button", { name: "Remove Ethereum owner", exact: true }).click();
      await ethRow.getByText("Reads stopped", { exact: true }).waitFor();
      await ethRow
        .getByRole("button", { name: "Remove token watch Huge exact token 🪐", exact: true })
        .click();
      await region.getByText("Token watch removed.", { exact: true }).waitFor();
      assert.equal((await configuration()).entries.length, 1);
      assert.equal((await configuration()).entries[0].chain, "solana");
    },
  );
  await check("token form and table fit mobile with the requested white/gray palette", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await region.getByRole("button", { name: "Watch token", exact: true }).click();
    await region.getByLabel("Watched public owner").selectOption("owner-sol");
    await region.getByLabel("SPL mint address", { exact: true }).focus();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await palette(region);
  });
  await check(
    "unreadable saved configuration offers an explicit reset without changing public owners",
    async () => {
      await page.evaluate(() => localStorage.setItem("fathom.token-watch.v1", "{broken fixture"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await region
        .getByRole("alert")
        .filter({ hasText: "The token configuration could not be read" })
        .waitFor();
      assert.equal(
        await region.getByRole("button", { name: "Watch token", exact: true }).isDisabled(),
        true,
      );
      await region.getByRole("button", { name: "Reset token configuration", exact: true }).click();
      await region
        .getByText("Token configuration reset in this browser.", { exact: true })
        .waitFor();
      assert.deepEqual(await configuration(), { version: 1, entries: [] });
      const watched = await page.evaluate(
        () => JSON.parse(localStorage.getItem("fathom.ledger.v1")).state.watched,
      );
      assert.equal(watched.length, 1);
      assert.equal(watched[0].address, SOL_OWNER);
    },
  );
  await check("browser uses only fixture read methods and has no runtime errors", async () => {
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    assert.ok(tokenRequests.some((request) => request.method === "eth_call"));
    assert.ok(tokenRequests.some((request) => request.method === "getTokenAccountsByOwner"));
    assert.ok(
      tokenRequests.every((request) =>
        ["eth_chainId", "eth_call", "getAccountInfo", "getTokenAccountsByOwner"].includes(
          request.method,
        ),
      ),
    );
  });
  console.log(
    `Token browser: ${checks} checks passed. Explicit public-RPC fixtures only; no token transactions, approvals, or deployment.`,
  );
} catch (error) {
  console.error(
    "Token browser layout diagnostics:",
    await page
      .evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        overflowing: [...document.querySelectorAll("body *")]
          .map((element) => {
            const box = element.getBoundingClientRect();
            return {
              tag: element.tagName,
              className: element.getAttribute("class"),
              left: Math.round(box.left),
              right: Math.round(box.right),
              width: Math.round(box.width),
            };
          })
          .filter((box) => box.left >= 0 && box.right > innerWidth + 1)
          .slice(0, 15),
      }))
      .catch(() => null),
  );
  await page
    .screenshot({ path: "/tmp/fathom-token-browser-failure.png", fullPage: true })
    .catch(() => undefined);
  throw error;
} finally {
  await context.close();
  await browser.close();
}
