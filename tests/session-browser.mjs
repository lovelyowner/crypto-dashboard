import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";

const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";
const origin = new URL(baseURL).origin;
const suffix = randomBytes(8).toString("hex");
const identity = {
  email: `sessions-ui-${suffix}@example.com`,
  username: `session @ ${suffix}`,
  password: `🔐 ${randomBytes(24).toString("base64")} /# +`,
};
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const testIp = `198.51.100.${1 + (randomBytes(1)[0] % 254)}`;
const first = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  extraHTTPHeaders: { "x-forwarded-for": testIp },
});
const second = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/120.0",
  extraHTTPHeaders: { "x-forwarded-for": testIp },
});
const third = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": testIp } });
const page = await first.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());
await first.route("**/*", (route) =>
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
async function request(context, path, data) {
  const response = await context.request.fetch(`${origin}/api/auth/${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { origin },
    ...(data === undefined ? {} : { data }),
  });
  assert.ok(response.ok(), "The local account request succeeds");
  return response.json();
}
async function login(context) {
  return request(context, "sign-in/email", {
    email: identity.email,
    password: identity.password,
    rememberMe: false,
  });
}
try {
  await request(first, "sign-up/email", { ...identity, name: "Session browser QA" });
  await login(second);
  const current = await request(first, "get-session");
  const other = await request(second, "get-session");
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open account", exact: true }).click();
  const panel = page.getByRole("region", { name: "Signed-in sessions", exact: true });
  await panel.locator(".account-session-card").nth(1).waitFor();
  await check(
    "session cards distinguish this browser and a separately authenticated device",
    async () => {
      assert.equal(await panel.locator(".account-session-card").count(), 2);
      assert.equal(await panel.getByText("Current session", { exact: true }).count(), 1);
      assert.equal(await panel.getByText("Firefox on Windows", { exact: true }).count(), 1);
    },
  );
  await check(
    "session dates use dd.mm.yy UTC and session tokens never enter rendered markup",
    async () => {
      const dates = await panel.locator("time").allTextContents();
      assert.ok(
        dates.length === 4 &&
          dates.every((value) => /^\d{2}\.\d{2}\.\d{2} \d{2}:\d{2} UTC$/.test(value)),
      );
      const markup = await page.locator("html").evaluate((element) => element.outerHTML);
      assert.ok(!markup.includes(current.session.token) && !markup.includes(other.session.token));
    },
  );
  await check(
    "independent access summary uses actual credential and verification state",
    async () => {
      const summary = page.getByRole("region", {
        name: "Independent access readiness",
        exact: true,
      });
      await summary
        .getByText("Password sign-in is available independently of social providers.", {
          exact: true,
        })
        .waitFor();
      assert.match(await summary.innerText(), /email is not verified/);
      assert.match(await summary.innerText(), /Authenticator protection is off/);
    },
  );
  await panel
    .locator(".account-session-card")
    .filter({ hasText: "Firefox on Windows" })
    .getByRole("button", { name: "Sign out session", exact: true })
    .click();
  await panel
    .getByRole("status")
    .filter({ hasText: "The selected session was signed out." })
    .waitFor();
  await check("signing out a selected device revokes it while retaining this browser", async () => {
    assert.ok(!(await request(second, "get-session"))?.user);
    assert.equal((await request(first, "get-session"))?.session.id, current.session.id);
    await page.waitForFunction(
      () => document.querySelectorAll(".account-session-card").length === 1,
    );
  });

  await login(second);
  await login(third);
  await panel.getByRole("button", { name: "Refresh sessions", exact: true }).click();
  await panel.locator(".account-session-card").nth(2).waitFor();
  await panel.getByRole("button", { name: "Sign out other sessions", exact: true }).click();
  await panel.getByRole("status").filter({ hasText: "Other sessions were signed out." }).waitFor();
  await check("signing out all other sessions invalidates both independent clients", async () => {
    assert.ok(
      !(await request(second, "get-session"))?.user && !(await request(third, "get-session"))?.user,
    );
    assert.equal((await request(first, "get-session"))?.session.id, current.session.id);
    await page.waitForFunction(
      () => document.querySelectorAll(".account-session-card").length === 1,
    );
    assert.equal(
      await panel
        .getByRole("button", { name: "Sign out other sessions", exact: true })
        .isDisabled(),
      true,
    );
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await check("mobile account sessions fit within the dialog and viewport", async () => {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const dimensions = await page.getByRole("dialog").evaluate((element) => ({
      width: element.clientWidth,
      content: element.scrollWidth,
      rect: element.getBoundingClientRect().toJSON(),
    }));
    assert.ok(
      dimensions.content <= dimensions.width &&
        dimensions.rect.left >= 0 &&
        dimensions.rect.right <= 390,
    );
  });
  await first.route("**/api/auth/list-sessions", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ message: "Session not fresh" }),
    }),
  );
  await panel.getByRole("button", { name: "Refresh sessions", exact: true }).click();
  await check(
    "a stale session receives sign-in-again guidance and no revocation controls",
    async () => {
      await panel
        .getByRole("alert")
        .filter({ hasText: "Sign in again before reviewing" })
        .waitFor();
      assert.equal(await panel.locator(".account-session-card").count(), 0);
      assert.equal(
        await panel.getByRole("button", { name: "Sign out other sessions", exact: true }).count(),
        0,
      );
    },
  );
  await check("session controls have no browser runtime errors", async () =>
    assert.deepEqual(errors, []),
  );
  console.log(
    `Session browser: ${checks} checks passed (real local sessions; stale-session response fixture only).`,
  );
} finally {
  await Promise.allSettled(
    [first, second, third].map((context) => request(context, "sign-out", {})),
  );
  await Promise.all([first.close(), second.close(), third.close()]);
  await browser.close();
}
