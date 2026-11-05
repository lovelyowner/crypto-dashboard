/** Browser-only wallet-to-profile selection; all wallet data is a disposable public fixture. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";
const origin = new URL(baseURL).origin;
const ETH = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const BTC = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ledger = {
  version: 0,
  state: {
    wallets: [
      {
        id: "private-wallet-association-fixture",
        label: "Мой кошелёк 🌙",
        createdAt: 1,
        custody: "device",
        addresses: { bitcoin: BTC, ethereum: ETH, solana: "11111111111111111111111111111111" },
        encrypted: {
          ciphertext: "TEST_CIPHERTEXT_NEVER_COPY",
          iv: "TEST_IV",
          salt: "TEST_SALT",
          kdf: "pbkdf2",
          iterations: 600000,
        },
        vaultId: "PRIVATE_VAULT_NEVER_COPY",
      },
    ],
    watched: [
      {
        id: "duplicate-eth",
        chain: "ethereum",
        address: ETH,
        label: "Watched duplicate",
        addedAt: 1,
      },
      {
        id: "same-address-base",
        chain: "base",
        address: ETH,
        label: "Base receiving account",
        addedAt: 2,
      },
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `other-eth-${index}`,
        chain: "ethereum",
        address: `0x${String(index + 1).padStart(40, "0")}`,
        label: `Receiving address ${index + 1}`,
        addedAt: index + 3,
      })),
    ],
  },
};
const originalProfile = {
  version: 1,
  displayName: "Wallet creator 🌙",
  bio: "",
  links: [],
  wishlist: [],
  serviceLinks: { allmylinks: "", throne: "", nowpayments: "", bluesky: "" },
  donations: {
    bankLink: "",
    crypto: [{ id: "existing-eth", chain: "ethereum", address: ETH, label: "Already in profile" }],
  },
};
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
const writes = [];
let externalRequests = 0;
let checks = 0;
const check = async (name, action) => {
  await action();
  checks++;
  console.log(`PASS ${name}`);
};
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (
    new URL(request.url()).pathname.startsWith("/api/") &&
    !["GET", "HEAD"].includes(request.method())
  )
    writes.push(request.postData() || request.method());
});
await context.addInitScript(
  ({ origin, ledger, originalProfile }) => {
    if (location.origin !== origin) return;
    if (!localStorage.getItem("fathom.ledger.v1"))
      localStorage.setItem("fathom.ledger.v1", JSON.stringify(ledger));
    if (!localStorage.getItem("fathom.creator-profile.v1"))
      localStorage.setItem("fathom.creator-profile.v1", JSON.stringify(originalProfile));
    localStorage.setItem(
      "fathom.preferences.v1",
      JSON.stringify({ version: 1, syncPaused: true, hideBalances: false, refreshInterval: 0 }),
    );
  },
  { origin, ledger, originalProfile },
);
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (url.origin === origin && url.pathname.startsWith("/api/auth/"))
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: url.pathname.endsWith("/config")
        ? JSON.stringify({
            configured: false,
            production: false,
            emailRecovery: false,
            providers: {},
          })
        : "null",
    });
  if (url.origin === origin) return route.continue();
  externalRequests++;
  return route.abort("blockedbyclient");
});
try {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  // The server-rendered navigation is visible before the saved ledger hydrates.
  await page.locator(".address-card").first().waitFor();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("heading", { name: "Profile", exact: true }).waitFor();
  const picker = page.locator(".profile-wallet-picker");
  await picker.locator("summary").click();
  await picker.locator(".profile-wallet-option").first().waitFor();
  await check(
    "saved wallets and watchlist addresses deduplicate while explicit networks remain distinct",
    async () => {
      assert.equal(await picker.locator(".profile-wallet-option").count(), 13);
      const duplicate = picker
        .locator(".profile-wallet-option")
        .filter({ hasText: "Local wallet and watchlist" });
      assert.equal(await duplicate.count(), 1);
      assert.ok(await duplicate.getByRole("checkbox").isChecked());
      assert.ok(await duplicate.getByRole("checkbox").isDisabled());
      assert.match(await duplicate.innerText(), /Мой кошелёк 🌙/);
      assert.equal(
        await picker
          .locator(".profile-wallet-option")
          .filter({ hasText: "Base receiving account" })
          .count(),
        1,
      );
    },
  );
  const bitcoin = picker
    .locator(".profile-wallet-option")
    .filter({ hasText: "Bitcoin" })
    .getByRole("checkbox");
  const base = picker
    .locator(".profile-wallet-option")
    .filter({ hasText: "Base receiving account" })
    .getByRole("checkbox");
  const consent = picker.getByRole("checkbox", {
    name: "I control the selected receiving addresses and want to add them to my profile.",
    exact: true,
  });
  const add = picker.getByRole("button", { name: "Add selected receiving addresses", exact: true });
  await bitcoin.check();
  await check(
    "adding requires a receiving-address ownership acknowledgement and resets it when selection changes",
    async () => {
      assert.ok(await add.isDisabled());
      await consent.check();
      assert.ok(await add.isEnabled());
      await base.check();
      assert.ok(!(await consent.isChecked()));
      assert.ok(await add.isDisabled());
    },
  );
  await consent.check();
  const ledgerBefore = await page.evaluate(() => localStorage.getItem("fathom.ledger.v1"));
  await add.click();
  await check("selected public addresses change only the unsaved profile draft", async () => {
    assert.equal(await page.getByLabel("Public receiving address", { exact: true }).count(), 3);
    assert.deepEqual(
      JSON.parse(await page.evaluate(() => localStorage.getItem("fathom.creator-profile.v1"))),
      originalProfile,
    );
    assert.equal(await page.evaluate(() => localStorage.getItem("fathom.ledger.v1")), ledgerBefore);
    assert.deepEqual(writes, []);
  });
  await page.getByRole("button", { name: "Save local draft", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export JSON", exact: true }).click(),
  ]);
  const exported = await readFile(await download.path(), "utf8");
  await check(
    "profile export contains public addresses and Unicode labels without encrypted wallet data or associations",
    async () => {
      const profile = JSON.parse(exported);
      assert.equal(profile.donations.crypto.length, 3);
      assert.ok(
        profile.donations.crypto.some(
          (row) => row.chain === "bitcoin" && row.address === BTC && row.label === "Мой кошелёк 🌙",
        ),
      );
      assert.ok(
        profile.donations.crypto.some((row) => row.chain === "base" && row.address === ETH),
      );
      assert.doesNotMatch(
        exported,
        /TEST_CIPHERTEXT|TEST_IV|TEST_SALT|PRIVATE_VAULT|private-wallet-association-fixture|walletId|encrypted|custody/,
      );
      assert.doesNotMatch(
        await page.locator(".creator-page").innerText(),
        /TEST_CIPHERTEXT|PRIVATE_VAULT/,
      );
    },
  );
  const remaining = picker.locator(".profile-wallet-option input:not(:disabled)");
  for (let index = 0; index < 8; index++) await remaining.nth(index).check();
  await consent.check();
  await check("over-capacity selection blocks the complete addition", async () => {
    assert.ok(await add.isDisabled());
    assert.match(
      await picker.locator(".profile-wallet-capacity").innerText(),
      /8 selected.*7 free.*Choose fewer/,
    );
    assert.equal(await page.getByLabel("Public receiving address", { exact: true }).count(), 3);
  });
  await remaining.nth(0).uncheck();
  await consent.check();
  await add.click();
  await check("a valid capacity-sized selection adds all seven addresses atomically", async () => {
    assert.equal(await page.getByLabel("Public receiving address", { exact: true }).count(), 10);
    assert.match(
      await picker.locator(".profile-wallet-capacity").innerText(),
      /0 selected.*0 free/,
    );
  });
  await page.getByRole("button", { name: "Save local draft", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await check(
    "wallet selection fits a mobile viewport and performs no external requests or server writes",
    async () => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.equal(externalRequests, 0);
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
    },
  );
  console.log(`Wallet/profile browser checks passed: ${checks}`);
} finally {
  await context.close();
  await browser.close();
}
