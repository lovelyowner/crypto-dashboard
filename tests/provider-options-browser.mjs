/** UI fixtures verify provider choices and SDK requests; they never contact identity services. */
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
const externalRequests = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());
let checks = 0;
let configuration = {
  configured: false,
  emailRecovery: false,
  providers: allProviders,
  production: false,
  passkeys: false,
};
let configurationMode = "pending";
let deployment = { preview: false };
const pendingConfigurations = new Map();
async function releaseConfiguration(value) {
  const pending = [...pendingConfigurations.entries()];
  for (const [resolve] of pending) resolve(value);
  await Promise.all(pending.map(([, completed]) => completed));
}
let session = null;
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
    externalRequests.push(url.hostname);
    return route.abort("blockedbyclient");
  }
  if (url.pathname === "/api/deployment") return json(route, deployment);
  if (!url.pathname.startsWith("/api/auth/")) return route.continue();
  const path = url.pathname.slice("/api/auth/".length);
  if (path === "config") {
    if (configurationMode === "http-error") return json(route, { message: "Fixture failure" }, 500);
    if (configurationMode === "invalid-json")
      return route.fulfill({ status: 200, contentType: "application/json", body: "{not-json" });
    if (configurationMode === "invalid-schema")
      return json(route, {
        ...configuration,
        configured: true,
        providers: { ...allProviders, twitter: "true" },
      });
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
        const value = await gate;
        // An intentionally timed-out fetch may already have been cancelled by the application.
        await json(route, value).catch(() => undefined);
      } finally {
        pendingConfigurations.delete(release);
        complete();
      }
      return;
    }
    return json(route, configuration);
  }
  if (path === "get-session") return json(route, session);
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
    // Keep this UI fixture on the page. The real OAuth protocol has separate server tests.
    return json(route, { url: `${origin}/fixture-authorize`, redirect: false });
  }
  unexpectedAuthRequests.push(`${request.method()} ${path}`);
  return json(route, { message: "Unexpected provider UI fixture request." }, 404);
});
async function check(name, run) {
  await run();
  checks += 1;
  console.log(`PASS ${name}`);
}
async function readyConfiguration() {
  await page.locator(".account-provider-options[data-availability='ready']").waitFor();
}
async function openLogin(path = "/login", waitForReady = true) {
  await page.goto(new URL(path, origin).href, { waitUntil: "domcontentloaded" });
  await page.locator(".account-panel").waitFor();
  if (waitForReady) await readyConfiguration();
}
async function assertNoProviderActions() {
  assert.equal(await page.locator(".account-provider").count(), 0);
  assert.equal(await page.getByText("Checking availability…", { exact: true }).count(), 0);
  for (const name of unsupported)
    assert.equal(await page.getByText(name, { exact: true }).count(), 0);
}
async function assertPendingChoices() {
  assert.equal(await page.locator(".account-provider[data-provider-action='pending']").count(), 5);
  assert.equal(await page.locator(".account-provider:disabled").count(), 5);
  assert.equal(await page.locator(".account-provider[data-provider-action='oauth']").count(), 0);
  assert.equal(await page.locator(".account-provider[data-provider-action='setup']").count(), 0);
  assert.deepEqual(
    await page
      .locator(".account-provider")
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    supported.map(([, label]) => `${label} sign-in`),
  );
  for (const [, label] of supported) {
    const button = page.getByRole("button", { name: `${label} sign-in`, exact: true });
    assert.equal(await button.isVisible(), true);
    await button.dispatchEvent("click");
  }
  for (const name of unsupported)
    assert.equal(await page.getByText(name, { exact: true }).count(), 0);
}
async function assertChoicesBeforeCredentials() {
  assert.equal(
    await page.locator(".account-provider-options").evaluate((choices) => {
      const form = document.querySelector(".account-form");
      return Boolean(
        form && choices.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }),
    true,
    "Social sign-in choices appear before the credential form",
  );
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
  await assertChoicesBeforeCredentials();
  assert.equal(
    await panel.evaluate((root) => {
      const grid = root.querySelector(".account-providers");
      if (!grid) return false;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue;
        const element = node.parentElement;
        if (!element || !element.getClientRects().length || element.closest(".sr-only")) continue;
        return grid.contains(element);
      }
      return false;
    }),
    true,
    "Provider buttons are the first visible text in the ordinary sign-in panel",
  );
}
async function assertFeedbackBelowChoices(feedback) {
  assert.equal(
    await feedback.evaluate((element) => {
      const grid = document.querySelector(".account-providers");
      return Boolean(
        grid && grid.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }),
    true,
    "Availability and setup feedback follows the provider buttons",
  );
}
async function setupHelp(label) {
  const requestsBefore = providerRequests.length;
  const button = page.getByRole("button", { name: `${label} sign-in setup`, exact: true });
  assert.equal(await button.isEnabled(), true);
  assert.equal(await button.getAttribute("data-provider-action"), "setup");
  assert.equal(await button.locator("small").innerText(), "Setup needed");
  await button.click();
  await page
    .getByRole("status")
    .filter({ hasText: /website owner/i })
    .waitFor();
  await assertFeedbackBelowChoices(page.getByRole("status").filter({ hasText: /website owner/i }));
  assert.equal(providerRequests.length, requestsBefore, "Setup help never calls the OAuth SDK");
}
const loadingOptions = () =>
  page.getByRole("status").filter({ hasText: /^Checking sign-in services…$/ });
const failedOptions = () =>
  page
    .getByRole("alert")
    .filter({ hasText: /^Sign-in options could not be loaded\. Try again\.$/ });
function callbackPath(request) {
  const callback = new URL(request.body.callbackURL, origin);
  assert.equal(callback.origin, origin, "Provider callbacks remain on this application origin");
  assert.equal(callback.pathname, "/login");
  return callback;
}
async function initiate(providerId, label, linking = false) {
  const path = linking ? "/api/auth/link-social" : "/api/auth/sign-in/social";
  const response = page.waitForResponse((response) => {
    const request = response.request();
    return (
      new URL(response.url()).pathname === path && request.postDataJSON()?.provider === providerId
    );
  });
  const button = page.getByRole("button", {
    name: `${linking ? "Connect" : "Continue with"} ${label}`,
    exact: true,
  });
  assert.equal(await button.getAttribute("data-provider-action"), "oauth");
  await button.click();
  await response;
  await page.waitForFunction(() => !document.querySelector(".account-provider[disabled]"));
  if (!linking) assert.equal(providerRequests.at(-1).remember, "false");
  return providerRequests.at(-1);
}
try {
  await openLogin("/login", false);
  await loadingOptions().waitFor();
  await check(
    "a pending availability check keeps five disabled choices above one compact status",
    async () => {
      const requestsBefore = providerRequests.length;
      assert.equal(await loadingOptions().count(), 1);
      await assertPendingChoices();
      assert.equal(providerRequests.length, requestsBefore);
      await assertMinimalSignIn();
      await assertFeedbackBelowChoices(loadingOptions());
      assert.equal(await page.locator(".account-setup-details").count(), 0);
      assert.equal(await page.locator(".account-service-statuses li").count(), 0);
    },
  );
  configurationMode = "ready";
  await releaseConfiguration(configuration);
  await readyConfiguration();
  await check(
    "unconfigured account service exposes five active setup choices without OAuth requests",
    async () => {
      assert.equal(
        await page.locator(".account-provider[data-provider-action='setup']").count(),
        5,
      );
      assert.equal(
        await page.locator(".account-provider[data-provider-action='oauth']").count(),
        0,
      );
      for (const [, label] of supported) await setupHelp(label);
      assert.equal(await page.getByText("Sign-in services", { exact: true }).count(), 0);
      assert.equal(await page.locator(".account-service-statuses li").count(), 0);
      for (const label of unsupported)
        assert.equal(await page.getByText(label, { exact: true }).count(), 0);
      await assertMinimalSignIn();
      assert.equal(await loadingOptions().count(), 0);
    },
  );

  configuration = {
    ...configuration,
    configured: true,
    providers: {
      google: true,
      discord: false,
      twitter: false,
      github: true,
      twitch: false,
      bluesky: true,
      mastodon: true,
    },
  };
  await openLogin();
  await check(
    "partial configuration keeps supported OAuth and setup choices visible with distinct actions",
    async () => {
      assert.deepEqual(
        await page
          .locator(".account-provider")
          .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
        [
          "Continue with Google",
          "Discord sign-in setup",
          "Twitter / X sign-in setup",
          "Continue with GitHub",
          "Twitch sign-in setup",
        ],
      );
      assert.equal(await page.locator(".account-provider:disabled").count(), 0);
      assert.equal(
        await page.locator(".account-provider[data-provider-action='oauth']").count(),
        2,
      );
      assert.equal(
        await page.locator(".account-provider[data-provider-action='setup']").count(),
        3,
      );
      await setupHelp("Discord");
      assert.equal(await page.getByText("Sign-in services", { exact: true }).count(), 0);
      for (const label of unsupported)
        assert.equal(await page.getByText(label, { exact: true }).count(), 0);
    },
  );

  for (const [mode, description] of [
    ["http-error", "HTTP failures"],
    ["invalid-json", "malformed JSON"],
    ["invalid-schema", "malformed availability flags"],
  ]) {
    configurationMode = mode;
    await openLogin("/login", false);
    await failedOptions().waitFor();
    await check(
      `${description} retain disabled choices and offer a compact retry below them`,
      async () => {
        const requestsBefore = providerRequests.length;
        assert.equal(await failedOptions().count(), 1);
        assert.equal(await loadingOptions().count(), 0);
        await assertPendingChoices();
        assert.equal(providerRequests.length, requestsBefore);
        await assertMinimalSignIn();
        await assertFeedbackBelowChoices(failedOptions());
        assert.equal(
          await page
            .getByRole("button", { name: "Retry sign-in options", exact: true })
            .isEnabled(),
          true,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "Retry sign-in options", exact: true })
            .innerText(),
          "Retry",
        );
        await assertFeedbackBelowChoices(
          page.getByRole("button", { name: "Retry sign-in options", exact: true }),
        );
      },
    );
  }

  configuration = { ...configuration, providers: allProviders };
  configurationMode = "pending";
  await page.getByRole("button", { name: "Retry sign-in options", exact: true }).click();
  await loadingOptions().waitFor();
  await check(
    "retry clears failure and keeps actions unavailable until a valid response arrives",
    async () => {
      assert.equal(await failedOptions().count(), 0);
      assert.equal(await loadingOptions().count(), 1);
      const requestsBefore = providerRequests.length;
      await assertPendingChoices();
      assert.equal(providerRequests.length, requestsBefore);
      configurationMode = "ready";
      await releaseConfiguration(configuration);
      await readyConfiguration();
      assert.equal(await page.locator(".account-provider").count(), 5);
      assert.equal(await loadingOptions().count(), 0);
      assert.equal(await failedOptions().count(), 0);
    },
  );

  configurationMode = "pending";
  await openLogin("/login", false);
  await loadingOptions().waitFor();
  await failedOptions().waitFor({ timeout: 12_000 });
  await check(
    "a hanging availability fetch times out and its late response cannot enable stale actions",
    async () => {
      assert.equal(await loadingOptions().count(), 0);
      await assertPendingChoices();
      await releaseConfiguration(configuration);
      assert.equal(await failedOptions().count(), 1);
      await assertPendingChoices();
      configurationMode = "ready";
      await page.getByRole("button", { name: "Retry sign-in options", exact: true }).click();
      await readyConfiguration();
      assert.equal(await page.locator(".account-provider").count(), 5);
    },
  );

  await openLogin("/login?next=%2Fprovider-fixture");
  await check(
    "all five configured login actions initiate the correct SDK provider with safe callbacks and the default duration",
    async () => {
      assert.equal(await page.locator(".account-provider").count(), 5);
      await assertMinimalSignIn();
      for (const [id, label] of supported) {
        const request = await initiate(id, label);
        assert.equal(request.path, "sign-in/social");
        assert.equal(request.body.provider, id);
        assert.equal(callbackPath(request).searchParams.get("next"), "/provider-fixture");
        assert.equal(request.duration, "1d");
      }
    },
  );
  await page.getByRole("button", { name: "New here? Create an account", exact: true }).click();
  await check(
    "signup keeps email registration and the same five working social actions",
    async () => {
      assert.equal(
        await page.getByRole("button", { name: "Create account", exact: true }).count(),
        1,
      );
      assert.equal(await page.locator('input[autocomplete="email"]').count(), 1);
      assert.equal(await page.locator(".account-provider").count(), 5);
      await assertMinimalSignIn();
      for (const [id, label] of supported) {
        const request = await initiate(id, label);
        assert.equal(request.body.provider, id);
        assert.equal(callbackPath(request).searchParams.get("next"), "/provider-fixture");
        assert.equal(request.duration, "1d");
      }
    },
  );

  await check("recovery and reset forms keep the sign-in choice block hidden", async () => {
    await page.getByRole("button", { name: "Forgot password?", exact: true }).click();
    await page.getByRole("heading", { name: "Recover access", exact: true }).waitFor();
    assert.equal(
      await page.locator(".account-intro:visible, .account-footnote:visible").count(),
      0,
    );
    await assertNoProviderActions();
    assert.equal(await page.locator(".account-provider-options").count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "Sign in with a passkey", exact: true }).count(),
      0,
    );
    await openLogin("/login?reset=1&token=provider-fixture-reset", false);
    await page.getByRole("button", { name: "Set new password", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Recover access", exact: true }).waitFor();
    assert.equal(
      await page.locator(".account-intro:visible, .account-footnote:visible").count(),
      0,
    );
    await assertNoProviderActions();
    assert.equal(await page.locator(".account-provider-options").count(), 0);
  });

  session = signedInSession;
  accounts = [linked("credential"), linked("github")];
  await openLogin();
  await check(
    "signed-in accounts keep independent recovery and show connected services without duplicate connect actions",
    async () => {
      await page.getByText("GitHub connected", { exact: true }).waitFor();
      await page.getByRole("heading", { name: "Account & security", exact: true }).waitFor();
      await page
        .getByText(
          "Keep independent ways to sign in, so losing a social account doesn’t lock you out.",
          { exact: true },
        )
        .waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Connect GitHub", exact: true }).count(),
        0,
      );
      assert.equal(await page.locator(".account-provider").count(), 4);
      await page
        .getByText("Password sign-in is available independently of social providers.", {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page.getByRole("heading", { name: "Change password", exact: true }).count(),
        1,
      );
      const request = await initiate("google", "Google", true);
      assert.equal(request.path, "link-social");
      assert.equal(request.body.provider, "google");
      callbackPath(request);
    },
  );
  await check(
    "a linked provider stays connected when its sign-in configuration is unavailable",
    async () => {
      configuration = { ...configuration, providers: { ...allProviders, github: false } };
      await openLogin();
      await page.getByText("GitHub connected", { exact: true }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Connect GitHub", exact: true }).count(),
        0,
      );
      await setupHelp("GitHub");
      configuration = { ...configuration, providers: allProviders };
      await openLogin();
      await page.getByText("GitHub connected", { exact: true }).waitFor();
    },
  );
  await page
    .locator(".account-linked")
    .filter({ hasText: "GitHub" })
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await page.getByRole("status").filter({ hasText: "Provider disconnected." }).waitFor();
  await check(
    "disconnecting a linked provider uses its account identity and leaves password access available",
    async () => {
      const request = providerRequests.findLast((request) => request.path === "unlink-account");
      assert.equal(request.body.providerId, "github");
      assert.equal(request.body.accountId, "provider-account-github");
      assert.equal(await page.getByText("GitHub connected", { exact: true }).count(), 0);
      assert.equal(
        await page.getByRole("button", { name: "Connect GitHub", exact: true }).count(),
        1,
      );
      assert.deepEqual(
        accounts.map((account) => account.providerId),
        ["credential"],
      );
      await page
        .getByText("Password sign-in is available independently of social providers.", {
          exact: true,
        })
        .waitFor();
    },
  );

  accounts = [linked("twitch")];
  await openLogin();
  await check(
    "the final social method cannot be disconnected and independent recovery remains discoverable",
    async () => {
      await page.getByText("Twitch connected", { exact: true }).waitFor();
      assert.equal(
        await page
          .locator(".account-linked")
          .getByRole("button", { name: "Disconnect", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        await page.getByRole("heading", { name: "Add password recovery", exact: true }).count(),
        1,
      );
      assert.match(
        await page
          .getByRole("region", { name: "Independent access readiness", exact: true })
          .innerText(),
        /One social provider is linked/,
      );
      assert.equal(
        await page.getByRole("button", { name: "Connect Google", exact: true }).isEnabled(),
        true,
      );
    },
  );

  await page.setViewportSize({ width: 390, height: 844 });
  session = null;
  accounts = [];
  configurationMode = "ready";
  configuration = {
    configured: true,
    emailRecovery: false,
    providers: allProviders,
    production: false,
    passkeys: false,
  };
  await check(
    "OAuth errors use safe copy and challenge returns open the existing recovery form",
    async () => {
      await openLogin(
        "/login?error=access_denied&error_description=provider-secret&next=%2Fprovider-fixture",
      );
      await page.getByRole("alert").filter({ hasText: "Social sign-in was cancelled" }).waitFor();
      assert.ok(!(await page.locator("body").innerText()).includes("provider-secret"));
      assert.equal(new URL(page.url()).searchParams.has("error"), false);
      await openLogin("/login?twoFactor=1&next=%2Fprovider-fixture", false);
      await page.getByLabel("Authenticator code", { exact: true }).waitFor();
      await page.getByRole("heading", { name: "Verify it’s you", exact: true }).waitFor();
      assert.equal(
        await page.locator(".account-intro:visible, .account-footnote:visible").count(),
        0,
      );
      await page.getByRole("button", { name: "Use a backup code", exact: true }).click();
      await page.getByLabel("Single-use backup code", { exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.has("twoFactor"), false);
      await assertNoProviderActions();
      assert.equal(await page.locator(".account-provider-options").count(), 0);
    },
  );
  await check(
    "configured sign-in addresses guide production and development away from a wrong origin",
    async () => {
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
        assert.equal(
          await link.getAttribute("href"),
          `${canonical}/login?next=%2Fprovider-fixture`,
        );
        assert.equal(await page.locator(".account-provider").count(), 0);
        assert.equal(
          await page.getByRole("button", { name: "Sign in", exact: true }).isDisabled(),
          true,
        );
      }
    },
  );
  await check(
    "preview metadata exposes the platform branch link without a guessed URL",
    async () => {
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
  await check(
    "the setup checklist explains missing preview settings without credential values",
    async () => {
      configuration = {
        configured: false,
        emailRecovery: false,
        providers: {},
        production: true,
        passkeys: false,
        setup: { environment: "preview", database: true, secret: false, origin: false },
      };
      await openLogin();
      const requestsBefore = providerRequests.length;
      assert.equal(await page.locator(".account-setup-details").count(), 0);
      await page.getByRole("button", { name: "Google sign-in setup", exact: true }).click();
      const details = page.locator(".account-setup-details");
      assert.equal(await details.getAttribute("open"), "");
      assert.equal(
        await details.locator("summary").evaluate((summary) => summary === document.activeElement),
        true,
      );
      assert.equal(providerRequests.length, requestsBefore);
      const rows = details.locator(".account-service-statuses li");
      assert.equal(await rows.count(), 4);
      assert.match(await rows.nth(3).innerText(), /Google/);
      assert.equal(
        await page
          .locator(".account-setup-details")
          .locator(".account-service-statuses li")
          .filter({ hasNotText: "Google" })
          .getByText("Needs setup", { exact: true })
          .count(),
        2,
      );
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text) => {
              window.setupChecklist = text;
            },
          },
        });
      });
      await page.getByRole("button", { name: "Copy setup checklist", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Setup checklist copied" }).waitFor();
      const report = await page.evaluate(() => window.setupChecklist);
      assert.match(report, /PREVIEW_DATABASE_URL: configured/);
      assert.match(report, /PREVIEW_BETTER_AUTH_SECRET: needed/);
      assert.match(report, /GOOGLE_CLIENT_ID \/ GOOGLE_CLIENT_SECRET: not enabled/);
      configuration = {
        ...configuration,
        configured: true,
        providers: { ...allProviders, google: false },
        setup: { environment: "preview", database: true, secret: true, origin: true },
      };
      await openLogin();
      await page.getByRole("button", { name: "Google sign-in setup", exact: true }).click();
      assert.equal(await details.getAttribute("open"), "");
      assert.equal(await details.locator(".account-service-statuses li").count(), 4);
      assert.match(
        await details.locator(".account-service-statuses li").nth(3).innerText(),
        /Google/,
      );
      configuration = {
        configured: true,
        emailRecovery: false,
        providers: allProviders,
        production: false,
        passkeys: false,
      };
      await openLogin();
    },
  );
  await check(
    "mobile provider choices fit the viewport, preserve the exact palette, and make no unsupported requests",
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
      assert.deepEqual(externalRequests, []);
      assert.ok(
        providerRequests.every((request) =>
          supported.some(([id]) => id === (request.body.provider ?? request.body.providerId)),
        ),
      );
      assert.deepEqual(errors, []);
    },
  );
  console.log(
    `Provider options browser: ${checks} checks passed (mocked auth availability and SDK requests; no live OAuth claimed).`,
  );
} finally {
  await releaseConfiguration(configuration);
  await context.close();
  await browser.close();
}
