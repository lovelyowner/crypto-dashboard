/** Full account UI with real local HTTP and a Chromium virtual authenticator.
 * Run against a disposable dev server whose BETTER_AUTH_URL matches TEST_BASE_URL.
 * Set CHROMIUM_PATH, use /usr/bin/chromium, or install Playwright Chromium.
 * No native device key or live OAuth provider is exercised. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { existsSync } from "node:fs";
const baseURL = process.env.TEST_BASE_URL || "http://localhost:8080";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : chromium.executablePath()),
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
const verificationRequests = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (request) => {
  if (new URL(request.url()).pathname === "/api/auth/passkey/verify-authentication")
    verificationRequests.push(request.headers()["x-fathom-session-duration"]);
});
page.on("dialog", (dialog) => dialog.accept());
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
try {
  await page.goto(new URL("/login", baseURL).href, { waitUntil: "networkidle" });
  const panel = page.locator(".account-panel");
  const configuration = await context.request
    .get(new URL("/api/auth/config", baseURL).href)
    .then((response) => response.json());
  assert.equal(configuration.passkeys, true, "A configured secure account server enables passkeys");
  assert.equal(
    configuration.passkeyOrigin,
    new URL(baseURL).origin,
    "Run the browser at the configured relying-party origin",
  );
  assert.equal(
    await panel.locator('.account-provider[data-provider-action="oauth"]').count(),
    5,
    "Implemented provider buttons remain direct actions independently of configuration flags",
  );
  assert.equal(await panel.locator(".account-provider-info").count(), 0);
  assert.equal(await panel.getByText("More services", { exact: true }).count(), 0);
  assert.equal(
    await panel
      .getByRole("heading")
      .evaluateAll((headings) =>
        headings.every((heading) => heading.classList.contains("sr-only")),
      ),
    true,
  );
  assert.equal(await panel.getByRole("combobox").count(), 0);
  await panel.getByRole("button", { name: "New here? Create an account", exact: true }).click();
  await panel
    .getByLabel("Email address", { exact: true })
    .fill(`passkey-ui-${Date.now()}@example.com`);
  await panel.locator('input[autocomplete="username"]').fill(`passkey-${Date.now()}`);
  await panel
    .locator('input[autocomplete="new-password"]')
    .fill("passkey-ui-disposable-password-2026!");
  await panel.getByRole("button", { name: "Create account", exact: true }).click();
  await panel.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  const security = panel.getByRole("region", { name: "Passkey security", exact: true });
  await security.getByText("No passkeys saved to this account.", { exact: true }).waitFor();
  await security.getByLabel("New passkey name", { exact: true }).fill("Virtual test laptop");
  await security.getByRole("button", { name: "Add passkey", exact: true }).click();
  await security
    .getByText("Passkey added. Your device will verify your identity when you sign in.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await security.getByLabel("Passkey name", { exact: true }).inputValue(),
    "Virtual test laptop",
  );
  await security.getByLabel("Passkey name", { exact: true }).fill("Renamed virtual device");
  await security.getByRole("button", { name: "Save name", exact: true }).click();
  await security.getByText("Passkey renamed.", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Sign out", exact: true }).click();
  await panel
    .getByRole("button", { name: "Already have an account? Sign in", exact: true })
    .click();
  await panel.getByRole("button", { name: "Sign in with a passkey", exact: true }).waitFor();
  assert.equal(await panel.getByRole("combobox").count(), 0);
  await panel.getByRole("button", { name: "Sign in with a passkey", exact: true }).click();
  await panel.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  const session = await context.request
    .get(new URL("/api/auth/get-session", baseURL).href)
    .then((response) => response.json());
  const remaining = Date.parse(session.session.expiresAt) - Date.now();
  const exported = await context.request.get(new URL("/api/account/export", baseURL).href);
  assert.equal(exported.status(), 200);
  assert.match(exported.headers()["cache-control"], /no-store/);
  const accountData = await exported.json();
  assert.equal(accountData.scope, "account-profile");
  assert.equal(accountData.account.id, session.user.id);
  assert.equal(accountData.complete, false);
  assert.ok(!("token" in accountData.account));
  assert.ok(
    remaining > 86_370_000 && remaining <= 86_400_000,
    "Passkey sign-in uses the default one-day session duration",
  );
  assert.deepEqual(verificationRequests, ["1d"]);
  await security.getByRole("button", { name: "Remove passkey", exact: true }).click();
  await security.getByText("No passkeys saved to this account.", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS real UI native virtual-authenticator enrollment, list, rename, sign out, passkey sign-in, default one-day duration and remove; five implemented OAuth choices.",
  );
} finally {
  await browser.close();
}
