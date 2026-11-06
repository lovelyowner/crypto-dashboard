import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { chromium } from "playwright";

const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";
const origin = new URL(baseURL).origin;
const suffix = randomBytes(8).toString("hex");
const email = `ui-${suffix}@example.com`;
const username = `試験 @ 🌙 +${suffix}`;
const password = `🔐 ${randomBytes(24).toString("base64")} /# +`;
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  // Separate disposable local-test traffic from other auth integration runners.
  extraHTTPHeaders: { "x-forwarded-for": `192.0.2.${1 + (randomBytes(1)[0] % 254)}` },
});
const page = await context.newPage();
const errors = [];
const signInRequests = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  const path = new URL(request.url()).pathname;
  if (["/api/auth/sign-up/email", "/api/auth/sign-in/identifier"].includes(path))
    signInRequests.push({
      path,
      duration: request.headers()["x-fathom-session-duration"],
      identifier: request.postDataJSON()?.identifier,
    });
});
await context.route("**/*", (route) =>
  new URL(route.request().url()).origin === origin
    ? route.continue()
    : route.abort("blockedbyclient"),
);
let checks = 0;
async function check(name, run) {
  await run();
  checks += 1;
  console.log(`PASS ${name}`);
}
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(character);
    assert.ok(index >= 0, "Authenticator secret uses base32");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hash = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = hash.at(-1) & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
async function getSession() {
  const response = await context.request.get(`${origin}/api/auth/get-session`);
  assert.ok(response.ok(), "Session endpoint succeeds");
  return response.json();
}
const confirmMessages = [];
let rejectLateReplacement = false;
page.on("dialog", async (dialog) => {
  confirmMessages.push(dialog.message());
  if (rejectLateReplacement && /while the account backup was loading/.test(dialog.message()))
    await dialog.dismiss();
  else await dialog.accept();
});

try {
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open account", exact: true }).click();
  const panel = page.locator(".account-panel");
  await panel.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(
    await panel
      .getByRole("heading")
      .evaluateAll((headings) =>
        headings.every((heading) => heading.classList.contains("sr-only")),
      ),
    true,
  );
  assert.equal(await panel.getByRole("combobox").count(), 0);
  assert.equal(
    await panel.getByRole("checkbox", { name: "Remember me in this browser", exact: true }).count(),
    1,
  );
  const identifierField = panel.getByLabel("Email or username", { exact: true });
  assert.equal(await identifierField.getAttribute("type"), "text");
  assert.equal(await identifierField.getAttribute("autocomplete"), "username");
  assert.equal(await panel.locator(".account-segment").count(), 0);
  assert.equal(await panel.getByRole("button", { name: "Email", exact: true }).count(), 0);
  assert.equal(await panel.getByRole("button", { name: "Username", exact: true }).count(), 0);
  await panel.getByRole("button", { name: "New here? Create an account", exact: true }).click();
  assert.equal(
    await panel
      .getByRole("heading")
      .evaluateAll((headings) =>
        headings.every((heading) => heading.classList.contains("sr-only")),
      ),
    true,
  );
  assert.equal(await panel.getByRole("combobox").count(), 0);
  await panel.locator('input[autocomplete="email"]').fill(email);
  await panel.locator('input[autocomplete="username"]').fill(username);
  await panel.locator('input[autocomplete="new-password"]').fill(password);
  await panel.getByRole("button", { name: "Create account", exact: true }).click();
  await panel.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await check(
    "Unicode signup updates the signed-in account UI and actual default one-day session",
    async () => {
      assert.equal(await panel.locator(".account-identity strong").innerText(), username);
      const session = await getSession();
      const remaining = new Date(session.session.expiresAt).getTime() - Date.now();
      assert.ok(remaining > 86_370_000 && remaining <= 86_400_000);
      assert.equal(
        signInRequests.find((request) => request.path === "/api/auth/sign-up/email")?.duration,
        "1d",
      );
      assert.equal(session.user.username, username.normalize("NFC"));
      await panel.getByRole("heading", { name: "Account & security", exact: true }).waitFor();
    },
  );
  await panel.getByRole("button", { name: "Sign out", exact: true }).click();
  await panel
    .getByRole("button", { name: "Already have an account? Sign in", exact: true })
    .click();
  await panel.getByLabel("Email or username", { exact: true }).fill(email.toUpperCase());
  await panel.locator('input[autocomplete="current-password"]').fill(password);
  await panel.getByRole("button", { name: "Sign in", exact: true }).click();
  await panel.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await check(
    "the merged identifier field signs in using an email without changing modes",
    async () => {
      const session = await getSession();
      assert.equal(session.user.username, username.normalize("NFC"));
      const login = signInRequests.findLast(
        (request) => request.path === "/api/auth/sign-in/identifier",
      );
      assert.equal(login.identifier, email.toUpperCase());
      assert.equal(login.duration, "1d");
      const remaining = new Date(session.session.expiresAt).getTime() - Date.now();
      assert.ok(remaining > 86_370_000 && remaining <= 86_400_000);
    },
  );
  await panel.locator('input[autocomplete="current-password"]').fill(password);
  await panel.getByRole("button", { name: "Set up authenticator", exact: true }).click();
  await panel.locator(".account-setup code").waitFor();
  const secret = await panel.locator(".account-setup code").innerText();
  await panel.getByLabel("Authenticator code", { exact: true }).fill(totp(secret));
  await panel.getByRole("button", { name: "Verify & activate 2FA", exact: true }).click();
  await panel.getByText("Account 2FA on", { exact: true }).waitFor();
  await check(
    "authenticator enrollment verifies a real app code and presents single-use recovery codes",
    async () => {
      const codes = (await panel.locator(".account-backup pre").innerText()).split("\n");
      assert.ok(
        codes.length === 10 && codes.every((code) => code.replaceAll("-", "").length === 16),
      );
      const session = await getSession();
      assert.equal(session.user.twoFactorEnabled, true);
      await panel.getByRole("button", { name: "I saved them — hide", exact: true }).click();
      assert.equal(await panel.locator(".account-backup pre").count(), 0);
    },
  );
  await panel.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill("Account creator 🌙");
  await page
    .getByLabel("Bio", { exact: true })
    .fill("Private account draft for browser integration.");
  await page.getByRole("button", { name: "Save to account", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "saved to your account" }).waitFor();
  const savedResponse = await context.request.get(`${origin}/api/profile`);
  assert.ok(savedResponse.ok(), "Signed-in profile read succeeds");
  const saved = await savedResponse.json();
  await check(
    "profile UI saves a private account draft without publishing or writing a local draft",
    async () => {
      assert.equal(saved.profile.displayName, "Account creator 🌙");
      assert.equal(new URL(page.url()).hash, "");
      assert.equal(
        await page.evaluate(() => localStorage.getItem("fathom.creator-profile.v1")),
        null,
      );
    },
  );
  await page.getByLabel("Display name", { exact: true }).fill("Unsaved replacement");
  await page.getByRole("button", { name: "Load account profile", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Account profile loaded for editing" })
    .waitFor();
  await check(
    "loading the account profile explicitly replaces the editor after confirmation",
    async () => {
      assert.equal(
        await page.getByLabel("Display name", { exact: true }).inputValue(),
        "Account creator 🌙",
      );
      assert.ok(
        confirmMessages.some((message) => /Replace your unsaved profile edits/.test(message)),
      );
    },
  );
  await page.getByRole("button", { name: "Save local draft", exact: true }).click();

  let releaseAccountLoad;
  let markAccountLoadStarted;
  const accountLoadStarted = new Promise((resolve) => {
    markAccountLoadStarted = resolve;
  });
  const accountLoadRelease = new Promise((resolve) => {
    releaseAccountLoad = resolve;
  });
  const delayProfile = async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    markAccountLoadStarted();
    await accountLoadRelease;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(saved),
    });
  };
  await context.route("**/api/profile", delayProfile);
  await page.getByRole("button", { name: "Load account profile", exact: true }).click();
  await accountLoadStarted;
  const imported = { ...saved.profile, displayName: "Imported while account loads 🌟" };
  await page.locator('input[type="file"][aria-label="Import creator profile JSON"]').setInputFiles({
    name: "imported-draft.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await page
    .getByRole("status")
    .filter({ hasText: "Public profile imported for editing" })
    .waitFor();
  rejectLateReplacement = true;
  releaseAccountLoad();
  await page.getByRole("button", { name: "Load account profile", exact: true }).waitFor();
  await check(
    "a late account load asks before replacing an imported draft and preserves it when declined",
    async () => {
      assert.ok(
        confirmMessages.some((message) => /while the account backup was loading/.test(message)),
      );
      assert.equal(
        await page.getByLabel("Display name", { exact: true }).inputValue(),
        imported.displayName,
      );
      assert.equal(
        JSON.parse(await page.evaluate(() => localStorage.getItem("fathom.creator-profile.v1")))
          .displayName,
        "Account creator 🌙",
      );
    },
  );
  await context.unroute("**/api/profile", delayProfile);
  await page.getByRole("button", { name: "Save local draft", exact: true }).click();
  await page.getByRole("button", { name: "Open account", exact: true }).click();
  await panel.getByRole("button", { name: "Sign out", exact: true }).click();
  await panel.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await check("sign-out removes the actual server session", async () => {
    assert.ok(!(await getSession())?.user);
  });
  await panel.getByLabel("Email or username", { exact: true }).fill(username);
  await panel.locator('input[autocomplete="current-password"]').fill(password);
  assert.equal(await panel.getByRole("combobox").count(), 0);
  await panel.getByRole("button", { name: "Sign in", exact: true }).click();
  await panel.getByLabel("Authenticator code", { exact: true }).waitFor();
  await check(
    "the same merged identifier field signs in with a Unicode username and waits for 2FA",
    async () => {
      assert.ok(!(await getSession())?.user);
      await panel.getByRole("heading", { name: "Verify it’s you", exact: true }).waitFor();
      assert.equal(await panel.locator(".account-provider-options").count(), 0);
      assert.equal(
        signInRequests.findLast(
          (request) =>
            request.path === "/api/auth/sign-in/identifier" && request.identifier === username,
        )?.duration,
        "1d",
      );
      assert.equal(
        await panel.getByRole("button", { name: "Verify & sign in", exact: true }).count(),
        1,
      );
    },
  );
  await panel.getByLabel("Authenticator code", { exact: true }).fill(totp(secret));
  await panel.getByRole("button", { name: "Verify & sign in", exact: true }).click();
  await panel.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  await check(
    "authenticator login restores the intended account and default one-day session deadline",
    async () => {
      const session = await getSession();
      assert.equal(session.user.username, username.normalize("NFC"));
      const remaining = new Date(session.session.expiresAt).getTime() - Date.now();
      assert.ok(remaining > 86_370_000 && remaining <= 86_400_000);
      assert.deepEqual(errors, []);
    },
  );
  await panel.getByRole("button", { name: "Sign out", exact: true }).click();
  await panel.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  console.log(
    `Account browser checks passed: ${checks} (real local sessions and authenticator; no external OAuth).`,
  );
} finally {
  await context.close();
  await browser.close();
}
