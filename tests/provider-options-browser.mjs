/** UI fixtures exercise actual SDK requests and mocked authorization navigation, never live accounts. */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";
const origin = new URL(baseURL).origin;
const supported = [
  ["google", "Google"],
  ["discord", "Discord"],
  ["twitter", "Twitter / X"],
  ["github", "GitHub"],
  ["twitch", "Twitch"],
];
const unsupported = ["Bluesky", "Fluxer", "Stoat", "hey.xyz", "Mastodon"];
const authorizations = {
  google:
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=google-fixture&response_type=code&state=google-fixture-state",
  discord:
    "https://discord.com/oauth2/authorize?client_id=discord-fixture&response_type=code&state=discord-fixture-state",
  twitter:
    "https://x.com/i/oauth2/authorize?client_id=twitter-fixture&response_type=code&state=twitter-fixture-state",
  github:
    "https://github.com/login/oauth/authorize?client_id=github-fixture&response_type=code&state=github-fixture-state",
  twitch:
    "https://id.twitch.tv/oauth2/authorize?client_id=twitch-fixture&response_type=code&state=twitch-fixture-state",
};
const allProviders = Object.fromEntries(supported.map(([id]) => [id, true]));
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const errors = [];
const unexpectedAuthRequests = [];
const providerRequests = [];
const unexpectedExternalRequests = [];
const authorizationNavigations = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());
let checks = 0;
let configuration = {
  configured: false,
  emailRecovery: false,
  providers: {},
  production: false,
  passkeys: false,
};
let configurationMode = "pending";
let oauthMode = "stay";
let deployment = { preview: false };
const pendingOAuth = new Map();
async function releaseOAuth() {
  const pending = [...pendingOAuth.entries()];
  for (const [release] of pending) release();
  await Promise.all(pending.map(([, done]) => done));
}
let releaseNavigation = null;
let navigationStarted = null;
const pendingConfigurations = new Map();
async function releaseConfiguration(value) {
  const pending = [...pendingConfigurations.entries()];
  for (const [resolve] of pending) resolve(value);
  await Promise.all(pending.map(([, completed]) => completed));
}
let session = null;
let holdSession = false;
const pendingSessions = new Set();
async function releaseSessions() {
  for (const resolve of pendingSessions) resolve();
  pendingSessions.clear();
}
let accounts = [];
const now = new Date().toISOString();
const expiry = new Date(Date.now() + 86_400_000).toISOString();
const signedInSession = {
  session: {
    id: "provider-fixture-session",
    token: "fixture-session-token",
    userId: "provider-fixture-user",
    createdAt: now,
    updatedAt: now,
    expiresAt: expiry,
    userAgent: "Fixture browser",
  },
  user: {
    id: "provider-fixture-user",
    name: "Provider fixture",
    email: "provider-fixture@example.com",
    emailVerified: true,
    username: "provider fixture",
    twoFactorEnabled: false,
    createdAt: now,
    updatedAt: now,
  },
};
function linked(providerId) {
  return { id: `account-${providerId}`, providerId, accountId: `provider-account-${providerId}` };
}
async function json(route, data, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
}
await context.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== origin) {
    if (
      ["redirect", "redirect-gated"].includes(oauthMode) &&
      Object.values(authorizations).includes(url.href) &&
      request.isNavigationRequest()
    ) {
      authorizationNavigations.push(url.href);
      if (oauthMode === "redirect-gated") {
        navigationStarted?.();
        await new Promise((resolve) => {
          releaseNavigation = resolve;
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: '<!doctype html><title>Authorization fixture</title><link rel="icon" href="data:,"><h1>Authorization fixture</h1>',
      });
    }
    unexpectedExternalRequests.push(url.href);
    return route.abort("blockedbyclient");
  }
  if (url.pathname === "/api/deployment") return json(route, deployment);
  if (url.pathname === "/fixture-embed")
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><title>Embedded sign-in fixture</title><link rel="icon" href="data:,"><iframe title="Embedded sign-in" src="${origin}/login" style="width:100%;height:100vh;border:0"></iframe>`,
    });
  if (!url.pathname.startsWith("/api/auth/")) return route.continue();
  const path = url.pathname.slice("/api/auth/".length);
  if (path === "config") {
    if (configurationMode === "http-error") return json(route, { message: "Fixture failure" }, 500);
    if (configurationMode === "invalid-json")
      return route.fulfill({ status: 200, contentType: "application/json", body: "{not-json" });
    if (configurationMode === "invalid-schema")
      return json(route, { ...configuration, providers: { ...allProviders, twitter: "true" } });
    if (configurationMode === "pending") {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let complete;
      const completed = new Promise((resolve) => {
        complete = resolve;
      });
      pendingConfigurations.set(release, completed);
      try {
        await json(route, await gate).catch(() => undefined);
      } finally {
        pendingConfigurations.delete(release);
        complete();
      }
      return;
    }
    return json(route, configuration);
  }
  if (path === "get-session") {
    if (holdSession) await new Promise((resolve) => pendingSessions.add(resolve));
    return json(route, session);
  }
  if (path === "list-accounts") return json(route, accounts);
  if (path === "list-sessions") return json(route, session ? [session.session] : []);
  if (path === "passkey/list-user-passkeys") return json(route, []);
  if (["sign-in/social", "link-social", "unlink-account"].includes(path)) {
    const body = request.postDataJSON();
    providerRequests.push({
      path,
      body,
      duration: request.headers()["x-fathom-session-duration"],
      remember: request.headers()["x-fathom-remember-me"],
    });
    if (path === "unlink-account") {
      accounts = accounts.filter((account) => account.providerId !== body.providerId);
      return json(route, { status: true });
    }
    if (oauthMode === "provider-error")
      return json(route, { code: "PROVIDER_NOT_FOUND", message: "provider-secret" }, 404);
    if (oauthMode === "account-error")
      return json(
        route,
        { code: "ACCOUNT_SETUP_REQUIRED", message: "Account sign-in needs website setup." },
        503,
      );
    if (oauthMode === "hang") {
      let release;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      let complete;
      const done = new Promise((resolve) => {
        complete = resolve;
      });
      pendingOAuth.set(release, done);
      try {
        await wait;
        await json(route, { url: authorizations[body.provider], redirect: false }).catch(
          () => undefined,
        );
      } finally {
        pendingOAuth.delete(release);
        complete();
      }
      return;
    }
    if (oauthMode === "html")
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Unexpected sign-in page</title>",
      });
    if (oauthMode === "malformed-json")
      return route.fulfill({ status: 200, contentType: "application/json", body: "{invalid-json" });
    if (oauthMode === "empty")
      return route.fulfill({ status: 200, contentType: "application/json", body: "" });
    if (oauthMode === "missing-url") return json(route, {});
    if (oauthMode === "unsafe-url")
      return json(route, {
        url: "https://attacker.invalid/authorize?state=unsafe-fixture",
        redirect: false,
      });
    if (["redirect", "redirect-gated"].includes(oauthMode))
      return json(route, { url: authorizations[body.provider], redirect: false });
    // Initiation-only checks deliberately return an explicit error, never a fake successful URL.
    return json(
      route,
      { code: "FIXTURE_STAY", message: "Authorization fixture kept this page open." },
      503,
    );
  }
  unexpectedAuthRequests.push(`${request.method()} ${path}`);
  return json(route, { message: "Unexpected provider UI fixture request." }, 404);
});
async function check(name, run) {
  await run();
  checks++;
  console.log(`PASS ${name}`);
}
async function readyConfiguration() {
  await page.locator(".account-provider-options[data-availability='ready']").waitFor();
}
async function openLogin(path = "/login", waitForReady = true) {
  // A client settings request starts after hydration; SSR text alone is not an interaction gate.
  const settingsRequested = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/auth/config",
  );
  await page.goto(new URL(path, origin).href, { waitUntil: "domcontentloaded" });
  await page.locator(".account-panel").waitFor();
  await settingsRequested;
  if (waitForReady) await readyConfiguration();
}
async function enabledChoices() {
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".account-provider").length === 5 &&
      !document.querySelector(".account-provider:disabled"),
  );
}
async function assertDirectChoices() {
  await enabledChoices();
  assert.equal(await page.locator(".account-provider[data-provider-action='oauth']").count(), 5);
  assert.equal(
    await page
      .locator(
        ".account-provider[data-provider-action='check'], .account-provider[data-provider-action='setup']",
      )
      .count(),
    0,
  );
  assert.deepEqual(
    await page
      .locator(".account-provider")
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    supported.map(([, label]) => `Continue with ${label}`),
  );
  assert.equal(await page.locator(".account-setup-details").count(), 0);
}
async function assertMinimalSignIn() {
  const panel = page.locator(".account-panel");
  await panel.locator(".account-form").waitFor();
  assert.equal(
    await panel
      .getByRole("heading")
      .evaluateAll((headings) =>
        headings.every((heading) => heading.classList.contains("sr-only")),
      ),
    true,
  );
  assert.equal(
    await panel
      .locator(
        ".account-heading:visible, .account-icon:visible, .account-eyebrow:visible, .account-intro:visible, .account-divider:visible, .account-footnote:visible",
      )
      .count(),
    0,
  );
  assert.equal(await panel.getByRole("combobox").count(), 0);
  assert.equal(await panel.getByText("Sign in again after", { exact: true }).count(), 0);
  assert.equal(
    await panel.getByRole("checkbox", { name: "Remember me in this browser", exact: true }).count(),
    1,
  );
  assert.doesNotMatch(
    await panel.innerText(),
    /selected server deadline|server ends this session|browser-session cookie|NFKC normalization|NFC normalization|12–256 characters/i,
  );
  assert.equal(
    await panel.evaluate((root) => {
      const form = root.querySelector(".account-form"),
        links = root.querySelector(".account-form-links"),
        choices = root.querySelector(".account-provider-options");
      return Boolean(
        form &&
        links &&
        choices &&
        form.compareDocumentPosition(links) & Node.DOCUMENT_POSITION_FOLLOWING &&
        links.compareDocumentPosition(choices) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }),
    true,
    "Social choices remain below the form and account links",
  );
}
const loadingOptions = () => page.locator(".account-provider-options[data-availability='loading']");
const failedOptions = () =>
  page
    .getByRole("alert")
    .filter({ hasText: /^Sign-in options could not be loaded\. Try again\.$/ });
function callbackPath(request) {
  const callback = new URL(request.body.callbackURL, origin);
  assert.equal(callback.origin, origin);
  assert.equal(callback.pathname, "/login");
  assert.equal(request.body.errorCallbackURL, request.body.callbackURL);
  return callback;
}
async function initiate(providerId, label, linking = false) {
  const path = linking ? "/api/auth/link-social" : "/api/auth/sign-in/social";
  const response = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path &&
      response.request().postDataJSON()?.provider === providerId,
  );
  const button = page.getByRole("button", {
    name: `${linking ? "Connect" : "Continue with"} ${label}`,
    exact: true,
  });
  assert.equal(await button.getAttribute("data-provider-action"), "oauth");
  await button.click();
  await response;
  await page.waitForFunction(() => !document.querySelector(".account-provider[disabled]"));
  const recorded = providerRequests.at(-1);
  assert.equal(
    recorded.body.disableRedirect,
    true,
    "The app owns validated authorization navigation",
  );
  return recorded;
}
async function setupHelp() {
  const before = providerRequests.length;
  const button = page.getByRole("button", { name: "Website sign-in setup", exact: true });
  await button.click();
  const details = page.locator(".account-setup-details");
  await details.waitFor();
  assert.equal(await button.getAttribute("aria-expanded"), "true");
  assert.equal(await details.getAttribute("open"), "");
  assert.equal(providerRequests.length, before, "Explicit setup help never starts OAuth");
  return details;
}
async function assertUnsupportedRemoved() {
  const panel = page.locator(".account-panel");
  assert.equal(await panel.getByText("More services", { exact: true }).count(), 0);
  assert.equal(
    await panel.locator(".account-provider-info, .account-provider-explanation").count(),
    0,
  );
  for (const label of unsupported)
    assert.equal(await panel.getByText(label, { exact: true }).count(), 0);
}
async function assertNoProviderActions() {
  assert.equal(await page.locator(".account-provider-options").count(), 0);
  assert.equal(await page.locator(".account-provider").count(), 0);
  await assertUnsupportedRemoved();
}
try {
  await openLogin("/login", false);
  await loadingOptions().waitFor();
  await check(
    "all five buttons initiate SDK authentication while configuration is still loading",
    async () => {
      await assertDirectChoices();
      await assertMinimalSignIn();
      for (const [id, label] of supported) {
        const request = await initiate(id, label);
        assert.equal(request.path, "sign-in/social");
        assert.equal(request.body.provider, id);
        callbackPath(request);
        assert.equal(request.duration, "1d");
        assert.equal(request.remember, "false");
      }
    },
  );
  configurationMode = "ready";
  await releaseConfiguration(configuration);
  await readyConfiguration();
  await check(
    "unconfigured metadata does not replace login actions with help; server errors explain missing setup",
    async () => {
      await assertDirectChoices();
      oauthMode = "account-error";
      const request = await initiate("google", "Google");
      assert.equal(request.path, "sign-in/social");
      await page.locator(".account-error[role='alert']").waitFor();
      assert.match(
        await page.locator(".account-error[role='alert']").innerText(),
        /account.*sign.in.*setup|website.*setup|not.*configured/i,
      );
      assert.equal(new URL(page.url()).origin, origin);
      assert.equal(await page.locator(".account-setup-details").count(), 0);
      oauthMode = "stay";
    },
  );

  for (const [mode, description] of [
    ["http-error", "HTTP errors"],
    ["invalid-json", "invalid JSON"],
    ["invalid-schema", "invalid metadata flags"],
  ]) {
    configurationMode = mode;
    await openLogin("/login", false);
    await failedOptions().waitFor();
    await check(
      `${description} leave direct Google and Discord authentication available`,
      async () => {
        await assertDirectChoices();
        for (const [id, label] of supported.slice(0, 2))
          assert.equal((await initiate(id, label)).body.provider, id);
      },
    );
  }
  await check(
    "explicit setup diagnostics report unknown settings without hijacking login buttons",
    async () => {
      const details = await setupHelp();
      assert.equal(await details.getByText("Unknown", { exact: true }).count(), 3);
      assert.equal(await details.getByText("Needs setup", { exact: true }).count(), 0);
      await page.evaluate(() =>
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text) => {
              window.unknownChecklist = text;
            },
          },
        }),
      );
      await details.getByRole("button", { name: "Copy setup checklist", exact: true }).click();
      await details.getByRole("status").filter({ hasText: "Setup checklist copied" }).waitFor();
      const report = await page.evaluate(() => window.unknownChecklist);
      assert.match(report, /Unknown environment/);
      assert.match(report, /DATABASE_URL \/ PREVIEW_DATABASE_URL: Unknown/);
      assert.doesNotMatch(report, /: needed|: not enabled|: configured/);
      await initiate("google", "Google");
      assert.equal(
        await page.locator(".account-setup-details").count(),
        0,
        "An OAuth action closes owner diagnostics",
      );
    },
  );
  configuration = { ...configuration, configured: true, providers: allProviders };
  configurationMode = "pending";
  await page.getByRole("button", { name: "Retry sign-in options", exact: true }).click();
  await loadingOptions().waitFor();
  await check(
    "retrying metadata never automatically authenticates and direct actions remain available",
    async () => {
      const before = providerRequests.length;
      await assertDirectChoices();
      configurationMode = "ready";
      await releaseConfiguration(configuration);
      await readyConfiguration();
      assert.equal(providerRequests.length, before);
      await assertDirectChoices();
    },
  );
  configurationMode = "pending";
  await openLogin("/login", false);
  await failedOptions().waitFor({ timeout: 12_000 });
  await check("a timed-out metadata request cannot block a deliberate sign-in", async () => {
    await assertDirectChoices();
    assert.equal((await initiate("google", "Google")).body.provider, "google");
    await releaseConfiguration(configuration);
    assert.equal(
      await page.locator(".account-provider-options[data-availability='unavailable']").count(),
      1,
      "A late metadata response stays unavailable while the actual OAuth error remains visible",
    );
    configurationMode = "ready";
    await page.getByRole("button", { name: "Retry sign-in options", exact: true }).click();
    await readyConfiguration();
  });
  await check(
    "an unconfigured provider error is clear and does not redirect or echo provider detail",
    async () => {
      oauthMode = "provider-error";
      const before = authorizationNavigations.length;
      await initiate("google", "Google");
      await page
        .getByRole("alert")
        .filter({
          hasText:
            /Google.*(?:not.*enabled|not.*configured|setup|application)|website.*(?:setup|enable)/i,
        })
        .waitFor();
      assert.equal(new URL(page.url()).origin, origin);
      assert.equal(authorizationNavigations.length, before);
      assert.doesNotMatch(
        await page.locator(".account-panel").innerText(),
        /provider-secret|PROVIDER_NOT_FOUND/,
      );
      oauthMode = "stay";
    },
  );

  for (const [mode, description] of [
    ["html", "HTML"],
    ["malformed-json", "malformed JSON"],
    ["empty", "an empty body"],
    ["missing-url", "a missing authorization URL"],
    ["unsafe-url", "an unsafe authorization URL"],
  ]) {
    await check(
      `${description} produces visible feedback instead of a silent sign-in`,
      async () => {
        oauthMode = mode;
        const before = authorizationNavigations.length;
        const request = await initiate("google", "Google");
        assert.equal(request.body.provider, "google");
        const feedback = page.locator(".account-error[role='alert']");
        await feedback.waitFor();
        assert.ok((await feedback.innerText()).trim().length > 0);
        if (mode === "unsafe-url")
          assert.doesNotMatch(await feedback.innerText(), /attacker\.invalid|unsafe-fixture/);
        await page.waitForFunction(
          () => document.querySelector(".account-error[role='alert']") === document.activeElement,
        );
        assert.equal(new URL(page.url()).origin, origin);
        assert.equal(authorizationNavigations.length, before);
        assert.equal(await page.locator(".account-social-continue").count(), 0);
        await enabledChoices();
        oauthMode = "stay";
      },
    );
  }
  await check(
    "a stalled authorization request times out, ignores late success, and permits retry",
    async () => {
      oauthMode = "hang";
      const before = providerRequests.length;
      const navigationsBefore = authorizationNavigations.length;
      const started = page.waitForRequest(
        (request) => new URL(request.url()).pathname === "/api/auth/sign-in/social",
      );
      await page.getByRole("button", { name: "Continue with Google", exact: true }).click();
      await started;
      await page.getByRole("button", { name: "Cancel sign-in", exact: true }).waitFor();
      assert.equal(await page.locator(".account-provider:disabled").count(), 5);
      const opening = page.getByRole("button", { name: "Continue with Google", exact: true });
      assert.equal(await opening.getAttribute("aria-busy"), "true");
      assert.match(await opening.innerText(), /Opening Google/);
      const feedback = page.locator(".account-error[role='alert']");
      await feedback.waitFor({ timeout: 18_000 });
      assert.match(await feedback.innerText(), /timed out|too long|try again/i);
      await page.waitForFunction(
        () => document.querySelector(".account-error[role='alert']") === document.activeElement,
      );
      await enabledChoices();
      assert.equal(
        providerRequests.length,
        before + 1,
        "The hung operation is not automatically retried",
      );
      await releaseOAuth();
      assert.equal(authorizationNavigations.length, navigationsBefore);
      assert.equal(await page.locator(".account-social-continue").count(), 0);
      oauthMode = "stay";
      await initiate("google", "Google");
      assert.equal(
        providerRequests.length,
        before + 2,
        "A deliberate retry can start a fresh request",
      );
    },
  );
  await check("cancel releases a pending sign-in and a late response cannot navigate", async () => {
    oauthMode = "hang";
    const before = authorizationNavigations.length;
    const started = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/auth/sign-in/social",
    );
    await page.getByRole("button", { name: "Continue with Discord", exact: true }).click();
    await started;
    await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
    await enabledChoices();
    await releaseOAuth();
    assert.equal(authorizationNavigations.length, before);
    assert.equal(await page.locator(".account-social-continue").count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "Cancel sign-in", exact: true }).count(),
      0,
    );
    oauthMode = "stay";
  });

  for (const [id, label] of supported.slice(0, 2)) {
    await openLogin("/login?next=%2Fprovider-fixture");
    await check(`${label} opens the actual SDK-returned provider authorization page`, async () => {
      oauthMode = "redirect";
      const before = providerRequests.length;
      await Promise.all([
        page.waitForURL(authorizations[id]),
        page.getByRole("button", { name: `Continue with ${label}`, exact: true }).click(),
      ]);
      await page.getByRole("heading", { name: "Authorization fixture", exact: true }).waitFor();
      assert.equal(page.url(), authorizations[id]);
      assert.equal(providerRequests.length, before + 1);
      const request = providerRequests.at(-1);
      assert.equal(request.path, "sign-in/social");
      assert.equal(request.body.provider, id);
      assert.equal(callbackPath(request).searchParams.get("next"), "/provider-fixture");
      assert.equal(request.duration, "1d");
      assert.equal(request.remember, "false");
      assert.equal(request.body.disableRedirect, true);
      oauthMode = "stay";
    });
  }

  await openLogin("/login?next=%2Fprovider-fixture");
  await check(
    "a validated provider link remains available while automatic navigation is pending",
    async () => {
      oauthMode = "redirect-gated";
      const started = new Promise((resolve) => {
        navigationStarted = resolve;
      });
      let reportFallback;
      const fallbackReady = new Promise((resolve) => {
        reportFallback = resolve;
      });
      await page.exposeFunction("reportSocialFallback", (snapshot) => reportFallback(snapshot));
      await page.evaluate(() => {
        let reported = false;
        const capture = () => {
          const provider = document.querySelector(".account-social-continue");
          const freshTab = [...document.querySelectorAll("a")].find(
            (link) => link.textContent === "Open sign-in page in a new tab",
          );
          if (reported || !provider || !freshTab) return;
          reported = true;
          void window.reportSocialFallback({
            provider: {
              href: provider.href,
              target: provider.target,
              rel: provider.rel,
              text: provider.textContent,
            },
            freshTab: { href: freshTab.href, target: freshTab.target, rel: freshTab.rel },
            persistedState: [localStorage, sessionStorage].some((storage) =>
              Object.values(storage).some((value) => value.includes("google-fixture-state")),
            ),
          });
          observer.disconnect();
        };
        const observer = new MutationObserver(capture);
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener("beforeunload", capture, { once: true });
        capture();
      });
      await page
        .getByRole("button", { name: "Continue with Google", exact: true })
        .click({ noWaitAfter: true });
      await started;
      let fallbackDeadline;
      const fallback = await Promise.race([
        fallbackReady,
        new Promise((_, reject) => {
          fallbackDeadline = setTimeout(
            () => reject(new Error("Fallback link was not committed before navigation")),
            8_000,
          );
        }),
      ]).finally(() => clearTimeout(fallbackDeadline));
      assert.equal(fallback.provider?.href, authorizations.google);
      assert.equal(fallback.provider?.target, "_blank");
      assert.match(fallback.provider?.rel ?? "", /noopener/);
      assert.match(fallback.provider?.rel ?? "", /noreferrer/);
      assert.equal(fallback.provider?.text, "Continue to Google");
      assert.equal(new URL(fallback.freshTab.href).origin, origin);
      assert.equal(new URL(fallback.freshTab.href).pathname, "/login");
      assert.equal(new URL(fallback.freshTab.href).searchParams.has("state"), false);
      assert.equal(fallback.freshTab.target, "_blank");
      assert.equal(
        fallback.persistedState,
        false,
        "Authorization state must remain in memory only",
      );
      releaseNavigation();
      releaseNavigation = null;
      navigationStarted = null;
      await page.waitForURL(authorizations.google);
      await page.getByRole("heading", { name: "Authorization fixture", exact: true }).waitFor();
      oauthMode = "stay";
    },
  );

  await check(
    "an embedded app keeps its sign-in page and offers a fresh top-level login",
    async () => {
      oauthMode = "redirect";
      const before = authorizationNavigations.length;
      const settingsRequested = page.waitForRequest(
        (request) =>
          new URL(request.url()).pathname === "/api/auth/config" &&
          request.frame() !== page.mainFrame(),
      );
      await page.goto(`${origin}/fixture-embed`, { waitUntil: "domcontentloaded" });
      await settingsRequested;
      const frame = page.frameLocator('iframe[title="Embedded sign-in"]');
      const google = frame.getByRole("button", { name: "Continue with Google", exact: true });
      await google.waitFor();
      await page.waitForFunction(() => {
        const document = window.frames[0]?.document;
        return (
          document &&
          document.querySelectorAll(".account-provider").length === 5 &&
          !document.querySelector(".account-provider:disabled")
        );
      });
      const started = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/auth/sign-in/social",
      );
      await google.click();
      await started;
      const freshTab = frame.getByRole("link", {
        name: "Open sign-in page in a new tab",
        exact: true,
      });
      await freshTab.waitFor();
      const destination = new URL(await freshTab.getAttribute("href"), origin);
      assert.equal(destination.origin, origin);
      assert.equal(destination.pathname, "/login");
      assert.equal(destination.searchParams.has("state"), false);
      assert.equal(destination.searchParams.has("provider"), false);
      assert.equal(await freshTab.getAttribute("target"), "_blank");
      assert.match(await freshTab.getAttribute("rel"), /noopener/);
      assert.equal(await frame.locator(".account-social-continue").count(), 0);
      assert.equal(page.url(), `${origin}/fixture-embed`);
      assert.equal(
        page
          .frames()
          .find((entry) => entry !== page.mainFrame())
          .url(),
        `${origin}/login`,
      );
      assert.equal(
        authorizationNavigations.length,
        before,
        "An embedded app never navigates its frame to the provider",
      );
      oauthMode = "stay";
    },
  );

  await openLogin("/login?next=%2Fprovider-fixture");
  await check(
    "all five login actions preserve safe callbacks, duration, and Remember policy",
    async () => {
      await assertDirectChoices();
      for (const [id, label] of supported) {
        const request = await initiate(id, label);
        assert.equal(request.body.provider, id);
        assert.equal(callbackPath(request).searchParams.get("next"), "/provider-fixture");
        assert.equal(request.duration, "1d");
        assert.equal(request.remember, "false");
      }
      await page
        .getByRole("checkbox", { name: "Remember me in this browser", exact: true })
        .check();
      assert.equal((await initiate("google", "Google")).remember, "true");
      await page
        .getByRole("checkbox", { name: "Remember me in this browser", exact: true })
        .uncheck();
    },
  );
  await page.getByRole("button", { name: "New here? Create an account", exact: true }).click();
  await check(
    "signup provides the same five direct actions below the registration form",
    async () => {
      await assertMinimalSignIn();
      assert.equal(
        await page.getByRole("button", { name: "Create account", exact: true }).count(),
        1,
      );
      for (const [id, label] of supported) {
        const request = await initiate(id, label);
        assert.equal(callbackPath(request).searchParams.get("next"), "/provider-fixture");
        assert.equal(request.body.provider, id);
        assert.equal(request.duration, "1d");
      }
    },
  );
  await check(
    "unsupported platforms are absent even when metadata claims they are enabled",
    async () => {
      configuration = {
        ...configuration,
        providers: {
          ...allProviders,
          bluesky: true,
          fluxer: true,
          stoat: true,
          hey: true,
          mastodon: true,
        },
      };
      await openLogin();
      await assertUnsupportedRemoved();
      await assertDirectChoices();
      await initiate("google", "Google");
    },
  );

  holdSession = true;
  await openLogin("/login", false);
  await readyConfiguration();
  await check(
    "session discovery blocks every OAuth action while owner help remains available",
    async () => {
      const before = providerRequests.length;
      assert.equal(await page.locator(".account-provider:disabled").count(), 5);
      for (const [, label] of supported)
        await page
          .getByRole("button", { name: `Continue with ${label}`, exact: true })
          .dispatchEvent("click");
      assert.equal(providerRequests.length, before);
      await setupHelp();
      await assertUnsupportedRemoved();
      assert.equal(providerRequests.length, before);
      holdSession = false;
      await releaseSessions();
      await enabledChoices();
      await initiate("google", "Google");
    },
  );

  await check("recovery, reset, and two-factor forms hide social actions", async () => {
    await page.getByRole("button", { name: "Forgot password?", exact: true }).click();
    await page.getByRole("heading", { name: "Recover access", exact: true }).waitFor();
    await assertNoProviderActions();
    await openLogin("/login?reset=1&token=provider-fixture-reset", false);
    await page.getByRole("button", { name: "Set new password", exact: true }).waitFor();
    await assertNoProviderActions();
    await openLogin("/login?twoFactor=1&next=%2Fprovider-fixture", false);
    await page.getByLabel("Authenticator code", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Use a backup code", exact: true }).click();
    await page.getByLabel("Single-use backup code", { exact: true }).waitFor();
    await assertNoProviderActions();
  });

  session = signedInSession;
  accounts = [linked("credential"), linked("github")];
  await openLogin();
  await check(
    "signed-in Connect actions link accounts while preserving independent recovery",
    async () => {
      await page.getByText("GitHub connected", { exact: true }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Connect GitHub", exact: true }).count(),
        0,
      );
      await page.getByRole("heading", { name: "Change password", exact: true }).waitFor();
      const request = await initiate("google", "Google", true);
      assert.equal(request.path, "link-social");
      callbackPath(request);
    },
  );
  await check(
    "existing linked services remain connected even when their metadata flag is false",
    async () => {
      configuration = { ...configuration, providers: { ...allProviders, github: false } };
      await openLogin();
      await page.getByText("GitHub connected", { exact: true }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Connect GitHub", exact: true }).count(),
        0,
      );
    },
  );
  await page
    .locator(".account-linked")
    .filter({ hasText: "GitHub" })
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await page.getByRole("status").filter({ hasText: "Provider disconnected." }).waitFor();
  await check(
    "disconnecting uses the linked identity and keeps password access available",
    async () => {
      const request = providerRequests.findLast((request) => request.path === "unlink-account");
      assert.equal(request.body.providerId, "github");
      assert.equal(request.body.accountId, "provider-account-github");
      assert.equal(
        await page.getByRole("button", { name: "Connect GitHub", exact: true }).count(),
        1,
      );
      assert.deepEqual(
        accounts.map((account) => account.providerId),
        ["credential"],
      );
    },
  );
  accounts = [linked("twitch")];
  await openLogin();
  await check(
    "the last sign-in method cannot be removed and password recovery remains discoverable",
    async () => {
      await page.getByText("Twitch connected", { exact: true }).waitFor();
      assert.equal(
        await page
          .locator(".account-linked")
          .getByRole("button", { name: "Disconnect", exact: true })
          .isDisabled(),
        true,
      );
      await page.getByRole("heading", { name: "Add password recovery", exact: true }).waitFor();
      assert.match(
        await page
          .getByRole("region", { name: "Independent access readiness", exact: true })
          .innerText(),
        /One social provider is linked/,
      );
    },
  );

  session = null;
  accounts = [];
  configuration = {
    configured: true,
    emailRecovery: false,
    providers: allProviders,
    production: false,
    passkeys: false,
  };
  await check(
    "OAuth error returns use safe copy and remove untrusted provider descriptions",
    async () => {
      await openLogin(
        "/login?error=access_denied&error_description=provider-secret&next=%2Fprovider-fixture",
      );
      await page.getByRole("alert").filter({ hasText: "Social sign-in was cancelled" }).waitFor();
      assert.doesNotMatch(await page.locator(".account-panel").innerText(), /provider-secret/);
      assert.equal(new URL(page.url()).searchParams.has("error"), false);
    },
  );
  await check("known canonical origins keep OAuth state on the configured website", async () => {
    for (const [production, canonical] of [
      [true, "https://canonical.example"],
      [false, "http://localhost:9998"],
    ]) {
      configuration = { ...configuration, production, signInOrigin: canonical };
      await openLogin("/login?next=%2Fprovider-fixture", false);
      const link = page.getByRole("link", {
        name: "Open the configured sign-in website",
        exact: true,
      });
      await link.waitFor();
      assert.equal(await link.getAttribute("href"), `${canonical}/login?next=%2Fprovider-fixture`);
      assert.equal(await page.locator(".account-provider").count(), 0);
      assert.equal(
        await page.getByRole("button", { name: "Sign in", exact: true }).isDisabled(),
        true,
      );
    }
  });
  await check("preview links use platform metadata rather than a guessed domain", async () => {
    deployment = {
      preview: true,
      branchUrl: "https://app-git-preview-team.vercel.app",
      deploymentUrl: "https://app-build-team.vercel.app",
      commit: "a".repeat(40),
      branch: "preview",
    };
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.getByText("Preview build aaaaaaa", { exact: true }).click();
    assert.equal(
      await page
        .getByRole("link", { name: "Open latest preview", exact: true })
        .getAttribute("href"),
      deployment.branchUrl,
    );
    deployment = { preview: false };
  });
  configuration = {
    configured: false,
    emailRecovery: false,
    providers: {},
    production: true,
    passkeys: false,
    setup: { environment: "preview", database: true, secret: false, origin: false },
  };
  await openLogin();
  await check(
    "owner setup remains an explicit separate action and exposes no credential values",
    async () => {
      const details = await setupHelp();
      const rows = details.locator(".account-service-statuses li");
      assert.equal(await rows.count(), 3);
      assert.equal(await details.getByText("Needs setup", { exact: true }).count(), 2);
      await page.evaluate(() =>
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text) => {
              window.setupChecklist = text;
            },
          },
        }),
      );
      await details.getByRole("button", { name: "Copy setup checklist", exact: true }).click();
      await details.getByRole("status").filter({ hasText: "Setup checklist copied" }).waitFor();
      const report = await page.evaluate(() => window.setupChecklist);
      assert.match(report, /PREVIEW_DATABASE_URL: configured/);
      assert.match(report, /PREVIEW_BETTER_AUTH_SECRET: needed/);
      assert.match(report, /GOOGLE_CLIENT_ID \/ GOOGLE_CLIENT_SECRET: not enabled/);
      await details.getByRole("button", { name: "Close setup help", exact: true }).click();
      assert.equal(await page.locator(".account-setup-details").count(), 0);
      assert.equal(
        await page
          .getByRole("button", { name: "Website sign-in setup", exact: true })
          .getAttribute("aria-expanded"),
        "false",
      );
    },
  );
  configuration = {
    configured: true,
    emailRecovery: false,
    providers: allProviders,
    production: false,
    passkeys: false,
  };
  await openLogin();
  await page.setViewportSize({ width: 390, height: 844 });
  await check(
    "mobile choices fit the white/gray UI and only implemented providers make requests",
    async () => {
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      );
      const allowed = new Set([
        "rgb(255, 255, 255)",
        "rgb(204, 204, 204)",
        "rgb(153, 153, 153)",
        "rgb(102, 102, 102)",
        "rgb(51, 51, 51)",
        "rgba(0, 0, 0, 0)",
      ]);
      const colors = await page.locator(".account-provider-options").evaluate((root) =>
        [root, ...root.querySelectorAll("*")].flatMap((element) => {
          const style = getComputedStyle(element);
          return [
            style.color,
            style.backgroundColor,
            ...["Top", "Right", "Bottom", "Left"].flatMap((side) =>
              Number.parseFloat(style[`border${side}Width`]) ? [style[`border${side}Color`]] : [],
            ),
          ];
        }),
      );
      assert.deepEqual(
        [...new Set(colors)].filter((color) => !allowed.has(color)),
        [],
      );
      assert.deepEqual(unexpectedAuthRequests, []);
      assert.deepEqual(unexpectedExternalRequests, []);
      assert.deepEqual(authorizationNavigations, [
        authorizations.google,
        authorizations.discord,
        authorizations.google,
      ]);
      assert.ok(
        providerRequests.every((request) =>
          supported.some(([id]) => id === (request.body.provider ?? request.body.providerId)),
        ),
      );
      assert.deepEqual(errors, []);
    },
  );
  console.log(
    `Provider options browser: ${checks} checks passed (mocked provider authorization pages and SDK; no live OAuth claimed).`,
  );
} finally {
  holdSession = false;
  await releaseSessions();
  await releaseConfiguration(configuration);
  await releaseOAuth();
  releaseNavigation?.();
  await context.close();
  await browser.close();
}
