import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright";

const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";
const origin = new URL(baseURL).origin;
const storageKey = "fathom.creator-profile.v1";
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
const publicProfileWrites = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/api/profile" && request.method() !== "GET")
    publicProfileWrites.push(request.method());
});
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  return url.origin === origin ? route.continue() : route.abort("blockedbyclient");
});
let checks = 0;
const check = async (name, run) => {
  await run();
  checks++;
  console.log(`PASS ${name}`);
};
try {
  await mkdir("screenshots", { recursive: true });
  await page.goto(`${baseURL}/?token=do-not-share`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  const editor = page.locator(".creator-editor");
  const preview = page.locator(".creator-public-card");
  await page.getByLabel("Display name", { exact: true }).fill("Мира 🌙");
  await page
    .getByLabel("Bio", { exact: true })
    .fill("I create music, art, and open source.\nСпасибо за поддержку!");
  await page.getByRole("button", { name: "Add link", exact: true }).click();
  await editor.getByLabel("Link label", { exact: true }).nth(0).fill("My work");
  await editor
    .getByLabel("Link URL", { exact: true })
    .nth(0)
    .fill("https://creator.example.org/portfolio");
  await page.getByRole("button", { name: "Add link", exact: true }).click();
  await editor.getByLabel("Link label", { exact: true }).nth(1).fill("Community");
  await editor
    .getByLabel("Link URL", { exact: true })
    .nth(1)
    .fill("https://discord.com/invite/mira");
  await page.getByRole("button", { name: "Move link 2 up", exact: true }).click();
  await check("custom profile links reorder and render safe external destinations", async () => {
    assert.equal(
      await editor.getByLabel("Link label", { exact: true }).nth(0).inputValue(),
      "Community",
    );
    assert.equal(
      await preview.getByRole("link", { name: "Community", exact: true }).getAttribute("href"),
      "https://discord.com/invite/mira",
    );
    assert.equal(
      await preview.getByRole("link", { name: "My work", exact: true }).getAttribute("rel"),
      "noopener noreferrer nofollow",
    );
  });
  await page.getByRole("button", { name: "Add wishlist item", exact: true }).click();
  await editor.getByLabel("Item title", { exact: true }).fill("Camera for music videos");
  await editor.getByLabel("Item URL", { exact: true }).fill("https://shop.example.org/camera");
  await editor.getByLabel("Price (optional)", { exact: true }).fill("149.99");
  await editor.getByLabel("Currency", { exact: true }).fill("EUR");
  await editor
    .getByLabel("Bank / hosted payment link", { exact: true })
    .fill("https://buy.stripe.com/test_mira");
  await page.getByRole("button", { name: /Add crypto address/ }).click();
  await editor
    .getByLabel("Public receiving address", { exact: true })
    .fill("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  await editor.getByLabel("Address label (optional)", { exact: true }).fill("Support my work");
  await editor
    .getByLabel("AllMyLinks profile", { exact: true })
    .fill("https://allmylinks.com/mira");
  await editor.getByLabel("Throne wishlist", { exact: true }).fill("https://throne.com/mira");
  await editor
    .getByLabel("NOWPayments checkout", { exact: true })
    .fill("https://nowpayments.io/donation/mira");
  await editor
    .getByLabel("Bluesky profile", { exact: true })
    .fill("https://bsky.app/profile/mira.bsky.social");
  await check(
    "wishlist, hosted bank checkout, crypto address and personal service pages preview together",
    async () => {
      assert.equal(
        await preview.getByRole("link", { name: /Camera for music videos/ }).getAttribute("href"),
        "https://shop.example.org/camera",
      );
      assert.match(
        await preview.getByRole("link", { name: /Camera for music videos/ }).innerText(),
        /149\.99 EUR/,
      );
      assert.equal(
        await preview
          .getByRole("link", { name: "Bank / payment checkout", exact: true })
          .getAttribute("href"),
        "https://buy.stripe.com/test_mira",
      );
      assert.equal(
        await preview
          .getByRole("link", { name: "Crypto checkout via NOWPayments", exact: true })
          .getAttribute("href"),
        "https://nowpayments.io/donation/mira",
      );
      assert.match(
        await preview.locator("code").innerText(),
        /^0xd8da6bf26964af9d7eed9e03e53415d37aa96045$/,
      );
      assert.equal(
        await preview
          .getByRole("link", { name: "Bluesky profile", exact: true })
          .getAttribute("href"),
        "https://bsky.app/profile/mira.bsky.social",
      );
    },
  );
  await page.getByRole("button", { name: "Save local draft", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Public profile saved in this browser" })
    .waitFor();
  const saved = await page.evaluate((key) => localStorage.getItem(key), storageKey);
  const savedProfile = JSON.parse(saved);
  await check(
    "local save and public JSON export preserve Unicode, ordered links and donation data",
    async () => {
      assert.equal(savedProfile.displayName, "Мира 🌙");
      assert.deepEqual(
        savedProfile.links.map((link) => link.label),
        ["Community", "My work"],
      );
      assert.equal(savedProfile.donations.crypto[0].chain, "ethereum");
      const downloaded = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export JSON", exact: true }).click();
      const download = await downloaded;
      assert.deepEqual(JSON.parse(await readFile(await download.path(), "utf8")), savedProfile);
    },
  );
  await page.reload({ waitUntil: "networkidle" });
  await check("saved local profile restores after reload", async () => {
    assert.equal(await page.getByLabel("Display name", { exact: true }).inputValue(), "Мира 🌙");
    assert.equal(
      await editor.getByLabel("Item title", { exact: true }).inputValue(),
      "Camera for music videos",
    );
  });
  await page
    .getByLabel("Bio", { exact: true })
    .fill("Unsaved profile snapshot — not private credentials.");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await check("unsaved edits survive dashboard tab navigation", async () => {
    assert.equal(
      await page.getByLabel("Bio", { exact: true }).inputValue(),
      "Unsaved profile snapshot — not private credentials.",
    );
  });
  const unsafeImport = structuredClone(savedProfile);
  unsafeImport.links[0].url = "javascript:alert('unsafe')";
  await page.locator('input[type="file"][aria-label="Import creator profile JSON"]').setInputFiles({
    name: "unsafe.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(unsafeImport)),
  });
  await check(
    "unsafe profile import is rejected without replacing unsaved or persisted data",
    async () => {
      await page.getByRole("alert").filter({ hasText: /HTTPS/ }).waitFor();
      assert.equal(
        await page.getByLabel("Bio", { exact: true }).inputValue(),
        "Unsaved profile snapshot — not private credentials.",
      );
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), storageKey), saved);
    },
  );
  await page.getByRole("button", { name: "Create share link", exact: true }).click();
  const shareUrl = await page.getByLabel("Public share link", { exact: true }).inputValue();
  await check(
    "explicit sharing creates a public snapshot without sign-in query parameters or server writes",
    async () => {
      assert.equal(new URL(shareUrl).search, "");
      assert.ok(new URL(shareUrl).hash.startsWith("#profile="));
      assert.deepEqual(publicProfileWrites, []);
    },
  );
  await page.screenshot({ path: "screenshots/profile-desktop.png", fullPage: true });
  const publicContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const privateProfile = {
    ...savedProfile,
    displayName: "Existing local profile",
    bio: "Keep my local draft",
  };
  await publicContext.addInitScript(
    ({ key, profile }) => localStorage.setItem(key, JSON.stringify(profile)),
    { key: storageKey, profile: privateProfile },
  );
  await publicContext.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort("blockedbyclient"),
  );
  const publicPage = await publicContext.newPage();
  publicPage.on("pageerror", (error) => errors.push(error.message));
  await publicPage.goto(shareUrl, { waitUntil: "networkidle" });
  await check(
    "public share opens a read-only snapshot and leaves the recipient's local profile untouched",
    async () => {
      assert.equal(
        await publicPage.getByRole("heading", { name: "Мира 🌙", exact: true }).count(),
        1,
      );
      assert.match(
        await publicPage.locator(".creator-public-bio").innerText(),
        /Unsaved profile snapshot/,
      );
      assert.equal(await publicPage.getByLabel("Display name", { exact: true }).count(), 0);
      assert.equal(
        await publicPage.getByRole("button", { name: "Save local draft", exact: true }).count(),
        0,
      );
      assert.equal(
        JSON.parse(await publicPage.evaluate((key) => localStorage.getItem(key), storageKey))
          .displayName,
        "Existing local profile",
      );
    },
  );
  await check(
    "shared mobile profile stays within the viewport and uses the requested white/gray palette",
    async () => {
      assert.ok(
        await publicPage.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      );
      const allowedColors = new Set([
        "rgb(255, 255, 255)",
        "rgb(204, 204, 204)",
        "rgb(153, 153, 153)",
        "rgb(102, 102, 102)",
        "rgb(51, 51, 51)",
        "rgba(0, 0, 0, 0)",
      ]);
      const colors = await publicPage.locator(".creator-page").evaluate((root) =>
        [...root.querySelectorAll("*")].flatMap((element) => {
          const style = getComputedStyle(element);
          return [style.color, style.backgroundColor];
        }),
      );
      assert.deepEqual(
        [...new Set(colors)].filter((color) => !allowedColors.has(color)),
        [],
      );
    },
  );
  await publicPage.screenshot({ path: "screenshots/profile-shared-mobile.png", fullPage: true });
  await publicPage.getByRole("button", { name: "Back to my draft", exact: true }).click();
  await check("returning from shared view restores the recipient's draft", async () => {
    assert.equal(
      await publicPage.getByLabel("Display name", { exact: true }).inputValue(),
      "Existing local profile",
    );
  });
  await publicPage.goto(shareUrl, { waitUntil: "networkidle" });
  await publicPage.getByRole("button", { name: "Use as local draft", exact: true }).click();
  await check(
    "copying a shared profile into the editor requires a separate local save",
    async () => {
      assert.equal(
        await publicPage.getByLabel("Display name", { exact: true }).inputValue(),
        "Мира 🌙",
      );
      assert.equal(
        JSON.parse(await publicPage.evaluate((key) => localStorage.getItem(key), storageKey))
          .displayName,
        "Existing local profile",
      );
      await publicPage.getByRole("button", { name: "Save local draft", exact: true }).click();
      assert.equal(
        JSON.parse(await publicPage.evaluate((key) => localStorage.getItem(key), storageKey))
          .displayName,
        "Мира 🌙",
      );
    },
  );
  await check("mobile editor has no horizontal overflow or browser errors", async () => {
    assert.ok(
      await publicPage.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    );
    assert.deepEqual(errors, []);
  });
  await publicPage.screenshot({ path: "screenshots/profile-editor-mobile.png", fullPage: true });
  await publicContext.close();
  console.log(`Profile browser checks passed: ${checks}`);
} finally {
  await context.close();
  await browser.close();
}
