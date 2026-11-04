/** Real local account publishing and anonymous creator-page checks. Never logs account secrets. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";
const origin = new URL(baseURL).origin;
const suffix = randomBytes(8).toString("hex");
const handle = `creator-${suffix}`;
const email = `publication-ui-${suffix}@example.com`;
const password = `🔐 ${randomBytes(24).toString("base64")} /# +`;
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const owner = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${1 + (randomBytes(1)[0] % 254)}` },
});
const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await owner.newPage();
const publicPage = await visitor.newPage();
const errors = [];
const visitorRequests = [];
let checks = 0;
async function check(name, run) {
  await run();
  checks += 1;
  console.log(`PASS ${name}`);
}
for (const context of [owner, visitor]) {
  context.on("page", (opened) => opened.on("pageerror", (error) => errors.push(error.message)));
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort("blockedbyclient"),
  );
}
page.on("pageerror", (error) => errors.push(error.message));
publicPage.on("pageerror", (error) => errors.push(error.message));
publicPage.on("request", (request) => visitorRequests.push(request.url()));
page.on("dialog", (dialog) => dialog.accept());
await visitor.addInitScript(() => {
  const key = "fathom.creator-profile.v1";
  if (!localStorage.getItem(key)) localStorage.setItem(key, "visitor-draft-kept-private");
  // A public-page visitor may already have a watchlist. It must stay local and
  // must never trigger provider activity when opening another creator's page.
  if (!localStorage.getItem("fathom.ledger.v1"))
    localStorage.setItem(
      "fathom.ledger.v1",
      JSON.stringify({
        version: 0,
        state: {
          watched: [
            {
              id: "visitor-watch",
              chain: "bitcoin",
              address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
              label: "Visitor only",
              addedAt: 1,
            },
          ],
          wallets: [],
        },
      }),
    );
  window.__publicProfileStorageWrites = [];
  const write = Storage.prototype.setItem;
  Storage.prototype.setItem = function (name, value) {
    window.__publicProfileStorageWrites.push(name);
    return write.call(this, name, value);
  };
});

try {
  const signup = await owner.request.post(`${origin}/api/auth/sign-up/email`, {
    headers: { origin },
    data: { email, password, name: "Publication browser account", username: `page_${suffix}` },
  });
  assert.ok(signup.ok(), "Disposable local account signs up successfully");
  const ownerId = (await signup.json()).user.id;
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill("Creator Мира 🌙");
  await page.getByLabel("Bio", { exact: true }).fill("Music, open source, and creative projects.");
  await page.getByRole("button", { name: "Add link", exact: true }).click();
  await page.getByLabel("Link label", { exact: true }).fill("My work");
  await page.getByLabel("Link URL", { exact: true }).fill("https://creator.example.org/work");
  await page.getByRole("button", { name: "Add wishlist item", exact: true }).click();
  await page.getByLabel("Item title", { exact: true }).fill("Microphone for music");
  await page.getByLabel("Item URL", { exact: true }).fill("https://shop.example.org/microphone");
  await page.getByLabel("Price (optional)", { exact: true }).fill("120.00");
  await page.getByLabel("Currency", { exact: true }).fill("EUR");
  await page.getByRole("button", { name: /Add crypto address/ }).click();
  await page
    .getByLabel("Public receiving address", { exact: true })
    .fill("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  await page.getByLabel("Address label (optional)", { exact: true }).fill("Music support");
  await page.getByRole("button", { name: "Save local draft", exact: true }).click();
  await page.getByRole("button", { name: "Save to account", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "saved to your account" }).waitFor();
  const publication = page.getByRole("region", { name: "Your public page", exact: true });
  const consent = publication.getByRole("checkbox", {
    name: "I want to publish the current preview and its public links and donation details.",
    exact: true,
  });
  await publication.getByLabel("Public handle", { exact: true }).fill(handle);
  await check("local and private account saves do not publish the profile", async () => {
    const missing = await visitor.request.get(`${origin}/api/public-profiles/${handle}`);
    assert.equal(missing.status(), 404);
    assert.equal(
      await publication
        .getByRole("button", { name: "Publish public page", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(await publication.getByText("Private draft", { exact: true }).count(), 1);
  });
  await consent.check();
  await publication.getByRole("button", { name: "Publish public page", exact: true }).click();
  await publication
    .getByRole("status")
    .filter({ hasText: "profile snapshot is published" })
    .waitFor();
  const publicURL = `${origin}/u/${handle}`;
  await check(
    "explicit consent publishes the current preview at a stable reserved URL",
    async () => {
      assert.equal(
        await publication.getByLabel("Public page link", { exact: true }).inputValue(),
        publicURL,
      );
      assert.equal(
        await publication
          .getByRole("link", { name: "Open page", exact: true })
          .getAttribute("href"),
        publicURL,
      );
      assert.equal(
        await publication.getByLabel("Public handle", { exact: true }).getAttribute("readonly"),
        "",
      );
      const response = await visitor.request.get(`${origin}/api/public-profiles/${handle}`);
      assert.equal(response.status(), 200);
      assert.match(response.headers()["cache-control"], /no-store/);
      assert.equal(response.headers()["set-cookie"], undefined);
      const data = await response.json();
      assert.deepEqual(Object.keys(data).sort(), ["handle", "profile", "updatedAt"]);
      const publicData = JSON.stringify(data);
      for (const secret of [email, password, ownerId])
        assert.equal(publicData.includes(secret), false);
    },
  );
  await owner.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await publication.getByRole("button", { name: "Copy link", exact: true }).click();
  await check("the stable page link copies without account or query credentials", async () => {
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), publicURL);
    assert.equal(new URL(publicURL).search, "");
    assert.equal(new URL(publicURL).hash, "");
  });

  await publicPage.goto(publicURL, { waitUntil: "domcontentloaded" });
  const published = publicPage.getByRole("article", {
    name: "Published creator profile",
    exact: true,
  });
  await published.getByRole("heading", { name: "Creator Мира 🌙", exact: true }).waitFor();
  await check(
    "an anonymous visitor sees the published links, wishlist and donation address",
    async () => {
      assert.equal(
        await published.getByRole("link", { name: "My work", exact: true }).getAttribute("href"),
        "https://creator.example.org/work",
      );
      assert.match(await published.textContent(), /Microphone for music/);
      assert.match(await published.textContent(), /120\.00 EUR/);
      assert.match(await published.textContent(), /0xd8da6bf26964af9d7eed9e03e53415d37aa96045/);
      assert.equal(await publicPage.locator(".sidebar").count(), 0);
      assert.equal(await publicPage.getByLabel("Display name", { exact: true }).count(), 0);
      assert.equal(
        await publicPage.getByRole("button", { name: "Publish public page", exact: true }).count(),
        0,
      );
      assert.equal(await publicPage.title(), "Creator Мира 🌙 · Fathom");
    },
  );
  await check(
    "public visits do not query sessions, watchlist providers, or alter the visitor's local data",
    async () => {
      const apiPaths = visitorRequests
        .map((url) => new URL(url))
        .filter((url) => url.pathname.startsWith("/api/"));
      assert.ok(apiPaths.length > 0);
      assert.ok(
        apiPaths.every(
          (url) => url.origin === origin && url.pathname === `/api/public-profiles/${handle}`,
        ),
      );
      assert.ok(visitorRequests.every((url) => new URL(url).origin === origin));
      assert.equal(
        await publicPage.evaluate(() => localStorage.getItem("fathom.creator-profile.v1")),
        "visitor-draft-kept-private",
      );
      assert.deepEqual(await publicPage.evaluate(() => window.__publicProfileStorageWrites), []);
    },
  );
  await check(
    "the mobile public page fits the viewport and uses only the white and gray palette",
    async () => {
      assert.equal(
        await publicPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      const palette = await publicPage.locator(".public-creator-page").evaluate((element) => {
        const styles = getComputedStyle(element);
        return [
          styles.backgroundColor,
          styles.getPropertyValue("--ui-border").trim(),
          styles.getPropertyValue("--ui-text-1").trim(),
          styles.getPropertyValue("--ui-text-2").trim(),
          styles.getPropertyValue("--ui-text-3").trim(),
        ];
      });
      assert.deepEqual(palette, ["rgb(255, 255, 255)", "#ccc", "#999", "#666", "#333"]);
    },
  );
  await mkdir("screenshots", { recursive: true });
  await publicPage.screenshot({ path: "screenshots/public-creator-mobile.png", fullPage: true });
  await publicPage.setViewportSize({ width: 1440, height: 1000 });
  await publicPage.screenshot({ path: "screenshots/public-creator-desktop.png", fullPage: true });
  await publicPage.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Display name", { exact: true }).fill("Updated creator 🎵");
  await page.getByRole("button", { name: "Save local draft", exact: true }).click();
  await publicPage.reload({ waitUntil: "domcontentloaded" });
  await published.getByRole("heading", { name: "Creator Мира 🌙", exact: true }).waitFor();
  await check(
    "editing and saving a draft leaves the live page unchanged until an explicit update",
    async () => {
      assert.equal(await consent.isChecked(), false);
      assert.equal(
        await publication.getByRole("button", { name: "Publish update", exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await published.getByRole("heading", { name: "Updated creator 🎵", exact: true }).count(),
        0,
      );
    },
  );
  await consent.check();
  await publication.getByRole("button", { name: "Publish update", exact: true }).click();
  await publication
    .getByRole("status")
    .filter({ hasText: "profile snapshot is published" })
    .waitFor();
  await publicPage.reload({ waitUntil: "domcontentloaded" });
  await published.getByRole("heading", { name: "Updated creator 🎵", exact: true }).waitFor();
  await check("publishing an update changes the existing public URL", async () => {
    assert.equal(
      await publication.getByLabel("Public page link", { exact: true }).inputValue(),
      publicURL,
    );
    assert.equal(await publicPage.title(), "Updated creator 🎵 · Fathom");
  });
  await publication.getByRole("button", { name: "Unpublish page", exact: true }).click();
  await publication
    .getByRole("status")
    .filter({ hasText: "hosted profile is unpublished" })
    .waitFor();
  await publicPage.reload({ waitUntil: "domcontentloaded" });
  await publicPage.getByRole("heading", { name: "Profile unavailable", exact: true }).waitFor();
  await check(
    "unpublishing removes the public page while preserving the draft and handle reservation",
    async () => {
      const response = await visitor.request.get(`${origin}/api/public-profiles/${handle}`);
      assert.equal(response.status(), 404);
      assert.equal(
        await publication.getByLabel("Reserved page link", { exact: true }).inputValue(),
        publicURL,
      );
      assert.equal(
        await publication.getByLabel("Public handle", { exact: true }).inputValue(),
        handle,
      );
      assert.equal(
        await page.getByLabel("Display name", { exact: true }).inputValue(),
        "Updated creator 🎵",
      );
      assert.equal(await publicPage.locator(".creator-public-card").count(), 0);
    },
  );
  await consent.check();
  await publication.getByRole("button", { name: "Republish page", exact: true }).click();
  await publication
    .getByRole("status")
    .filter({ hasText: "profile snapshot is published" })
    .waitFor();
  await publicPage.goto(`${publicURL}/`, { waitUntil: "domcontentloaded" });
  await published.getByRole("heading", { name: "Updated creator 🎵", exact: true }).waitFor();
  await check(
    "republishing restores the same page and trailing-slash URL without browser errors",
    async () => {
      assert.equal(
        await publication.getByLabel("Public page link", { exact: true }).inputValue(),
        publicURL,
      );
      assert.equal(
        await publicPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      assert.deepEqual(await publicPage.evaluate(() => window.__publicProfileStorageWrites), []);
      assert.deepEqual(errors, []);
    },
  );
  console.log(
    `Publication browser: ${checks} checks passed (real local publishing; no external payment or identity calls).`,
  );
} finally {
  await owner.request
    .delete(`${origin}/api/profile/publication`, { headers: { origin } })
    .catch(() => undefined);
  await owner.request
    .post(`${origin}/api/auth/sign-out`, { headers: { origin }, data: {} })
    .catch(() => undefined);
  await owner.close();
  await visitor.close();
  await browser.close();
}
