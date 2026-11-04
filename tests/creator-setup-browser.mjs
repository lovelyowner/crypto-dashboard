/** Creator setup refreshes use real local accounts; hosted checkout flags are fixture-only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";

const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:8080";
const origin = new URL(baseURL).origin;
const suffix = randomBytes(8).toString("hex");
const handle = `setup-${suffix}`;
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const owner = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  extraHTTPHeaders: { "x-forwarded-for": `203.0.113.${1 + (randomBytes(1)[0] % 254)}` },
});
const page = await owner.newPage();
page.setDefaultTimeout(15_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());
let contactWrites = 0;
let rejectNextContactWrite = false;
let hostedDeletes = 0;
let hostedWrites = 0;
let configuredHostedFixture = true;
let holdNextContactGet = null;
const pendingReleases = new Set();
let checks = 0;

async function check(name, run) {
  await run();
  checks += 1;
  console.log(`PASS ${name}`);
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function holdContactRefresh() {
  const fetched = deferred();
  const release = deferred();
  holdNextContactGet = { fetched, release };
  pendingReleases.add(release.resolve);
  return {
    fetched: fetched.promise,
    release: () => {
      pendingReleases.delete(release.resolve);
      release.resolve();
    },
  };
}
await owner.route("**/*", (route) =>
  new URL(route.request().url()).origin === origin
    ? route.continue()
    : route.abort("blockedbyclient"),
);
await owner.route("**/api/profile/contact", async (route) => {
  if (route.request().method() === "PUT") {
    contactWrites += 1;
    if (rejectNextContactWrite) {
      rejectNextContactWrite = false;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ message: "Fixture conflict: your contact changes were not saved." }),
      });
      return;
    }
  }
  if (route.request().method() === "GET" && holdNextContactGet) {
    const gate = holdNextContactGet;
    holdNextContactGet = null;
    const response = await route.fetch();
    gate.fetched.resolve();
    await gate.release.promise;
    await route.fulfill({ response });
    return;
  }
  await route.continue();
});
// There are no live merchant credentials or provider requests in this test.
await owner.route("**/api/profile/payments", async (route) => {
  const method = route.request().method();
  if (method === "DELETE") {
    hostedDeletes += 1;
    configuredHostedFixture = false;
  }
  if (method === "PUT") {
    hostedWrites += 1;
    configuredHostedFixture = true;
  }
  if (method !== "GET" && method !== "DELETE" && method !== "PUT") {
    await route.abort("blockedbyclient");
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      nowpayments: {
        configured: configuredHostedFixture,
        webhookUrl: configuredHostedFixture ? `${origin}/api/payments/nowpayments/ipn` : null,
      },
      ethereum: { available: true, chainId: 1, minConfirmations: 3 },
    }),
  });
});

const walletOne = {
  id: "setup-eth-one",
  chain: "ethereum",
  address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
  label: "Primary fixture ETH",
};
const walletTwo = {
  id: "setup-eth-two",
  chain: "ethereum",
  address: "0x52908400098527886e0f7030069857d2e4169ee7",
  label: "Second fixture ETH",
};
function profile(stage, wallets) {
  return {
    version: 1,
    displayName: `Setup fixture ${stage}`,
    bio: "Local regression fixtures only.",
    links: [],
    wishlist: [],
    serviceLinks: { allmylinks: "", throne: "", nowpayments: "", bluesky: "" },
    donations: { bankLink: "", crypto: wallets },
  };
}
const publication = page.getByRole("region", { name: "Your public page", exact: true });
const contact = page.getByRole("region", { name: "Messages & donations", exact: true });
const mode = contact.getByLabel("Direct messages", { exact: true });
const wallet = contact.getByLabel("Ethereum receiving wallet", { exact: true });
const ethFee = contact.getByLabel("ETH price per incoming message", { exact: true });
const usdFee = contact.getByLabel("USD price via NOWPayments", { exact: true });
const minimumEth = contact.getByLabel("Minimum donation for a note · ETH", { exact: true });
const minimumUsd = contact.getByLabel("Minimum donation for a note · USD checkout", {
  exact: true,
});
const donationNotes = contact.getByRole("checkbox", {
  name: "Allow donation messages, anonymously or with an account",
  exact: true,
});
async function importProfile(value) {
  await page.getByLabel("Import creator profile JSON", { exact: true }).setInputFiles({
    name: "creator-setup-fixture.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(value)),
  });
  await page.waitForFunction(
    (name) => Array.from(document.querySelectorAll("input")).some((input) => input.value === name),
    value.displayName,
  );
}
async function publish(value, first = false) {
  await importProfile(value);
  if (first) await publication.getByLabel("Public handle", { exact: true }).fill(handle);
  await publication
    .getByRole("checkbox", {
      name: "I want to publish the current preview and its public links and donation details.",
      exact: true,
    })
    .check();
  const response = page.waitForResponse(
    (request) =>
      new URL(request.url()).pathname === "/api/profile/publication" &&
      request.request().method() === "PUT",
  );
  await publication
    .getByRole("button", {
      name: first ? "Publish public page" : "Publish update",
      exact: true,
    })
    .click();
  assert.equal((await response).status(), 200);
  await publication
    .getByRole("status")
    .filter({ hasText: "profile snapshot is published" })
    .waitFor();
}
async function waitForWalletChoices(ids, removedId = null) {
  await page.waitForFunction(
    (expected) => {
      const select = document.querySelector('select[aria-label="Ethereum receiving wallet"]');
      return (
        select &&
        JSON.stringify(Array.from(select.options, (option) => option.value)) ===
          JSON.stringify(["", ...expected])
      );
    },
    [...(removedId ? [removedId] : []), ...ids],
  );
  await contact
    .getByText("Loading contact settings…", { exact: true })
    .waitFor({ state: "hidden" });
}
async function serverSettings() {
  const response = await owner.request.get(`${origin}/api/profile/contact`);
  assert.equal(response.status(), 200);
  return (await response.json()).settings;
}

try {
  const signup = await owner.request.post(`${origin}/api/auth/sign-up/email`, {
    headers: { origin },
    data: {
      email: `creator-setup-${suffix}@example.com`,
      password: `🔐 ${randomBytes(24).toString("base64")} /# +`,
      name: "Creator setup browser fixture",
      username: `setup_${suffix}`,
    },
  });
  assert.ok(signup.ok(), "Disposable local owner account signs up successfully");
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  // The server renders navigation before React attaches its event handlers.
  await page.getByLabel("Display name", { exact: true }).waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await mode.waitFor();
  await contact
    .getByText("Loading contact settings…", { exact: true })
    .waitFor({ state: "hidden" });
  await check("unpublished setup has no receiving-wallet choices", async () => {
    assert.equal(await wallet.isDisabled(), true);
    assert.equal(await wallet.locator("option").count(), 1);
    assert.equal(await mode.inputValue(), "closed");
  });

  const originalProfile = profile("private backup", [walletOne]);
  await importProfile(originalProfile);
  await page.getByRole("button", { name: "Save to account", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "saved to your account" }).waitFor();
  await publish(profile("first publication", [walletOne]), true);
  await waitForWalletChoices([walletOne.id]);
  await check(
    "publishing automatically supplies wallet choices without saving contact settings",
    async () => {
      assert.equal(await wallet.isDisabled(), false);
      assert.equal(await wallet.inputValue(), "");
      assert.equal(contactWrites, 0);
      assert.equal((await serverSettings()).dmMode, "closed");
    },
  );

  await mode.selectOption("paid");
  await wallet.selectOption(walletOne.id);
  await ethFee.fill("0.004");
  await usdFee.fill("5.50");
  await contact.getByRole("button", { name: "Save contact settings", exact: true }).click();
  await contact
    .getByRole("status")
    .filter({ hasText: "Message and donation settings saved" })
    .waitFor();
  const savedSettings = await serverSettings();
  await check("contact settings save only through their explicit Save button", async () => {
    assert.equal(contactWrites, 1);
    assert.equal(savedSettings.ethDonationAddressId, walletOne.id);
    assert.equal(savedSettings.dmEthPrice, "0.004");
  });

  await contact
    .getByText("Loading contact settings…", { exact: true })
    .waitFor({ state: "hidden" });
  await ethFee.fill("0.0055");
  rejectNextContactWrite = true;
  const refreshAfterFailure = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/profile/contact" &&
      response.request().method() === "GET",
  );
  await contact.getByRole("button", { name: "Save contact settings", exact: true }).click();
  await (await refreshAfterFailure).finished();
  await contact
    .getByText("Loading contact settings…", { exact: true })
    .waitFor({ state: "hidden" });
  await check(
    "a failed Save retains its error and dirty values after the automatic metadata refresh",
    async () => {
      await contact.getByRole("alert").filter({ hasText: "Fixture conflict" }).waitFor();
      assert.equal(await ethFee.inputValue(), "0.0055");
      assert.deepEqual(await serverSettings(), savedSettings);
      assert.equal(contactWrites, 2);
    },
  );

  await ethFee.fill("0.0067");
  await usdFee.fill("9.25");
  await minimumEth.fill("0.0005");
  await minimumUsd.fill("3.50");
  await mode.selectOption("free");
  await publish(profile("second publication", [walletOne, walletTwo]));
  await waitForWalletChoices([walletOne.id, walletTwo.id]);
  await check(
    "newly published wallets refresh while unsaved mode, fees and wallet choice stay intact",
    async () => {
      assert.equal(await mode.inputValue(), "free");
      assert.equal(await wallet.inputValue(), walletOne.id);
      assert.equal(await minimumEth.inputValue(), "0.0005");
      assert.equal(await minimumUsd.inputValue(), "3.50");
      await mode.selectOption("paid");
      assert.equal(await ethFee.inputValue(), "0.0067");
      assert.equal(await usdFee.inputValue(), "9.25");
      assert.deepEqual(await serverSettings(), savedSettings);
      assert.equal(contactWrites, 2);
    },
  );

  const delayedRefresh = holdContactRefresh();
  await publish(profile("in-flight update", [walletOne, walletTwo]));
  await Promise.race([
    delayedRefresh.fetched,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Publication did not trigger a contact refresh")), 15_000),
    ),
  ]);
  await ethFee.fill("0.0089");
  await usdFee.fill("12.75");
  await minimumEth.fill("0.0009");
  await mode.selectOption("free");
  delayedRefresh.release();
  await contact
    .getByText("Loading contact settings…", { exact: true })
    .waitFor({ state: "hidden" });
  await check(
    "edits made while the publication refresh is in flight survive its response",
    async () => {
      assert.equal(await mode.inputValue(), "free");
      assert.equal(await minimumEth.inputValue(), "0.0009");
      await mode.selectOption("paid");
      assert.equal(await ethFee.inputValue(), "0.0089");
      assert.equal(await usdFee.inputValue(), "12.75");
      assert.equal(await wallet.inputValue(), walletOne.id);
      assert.deepEqual(await serverSettings(), savedSettings);
    },
  );

  await publish(profile("primary wallet removed", [walletTwo]));
  await waitForWalletChoices([walletTwo.id], walletOne.id);
  await check(
    "a removed receiving wallet is flagged and requires an explicit replacement",
    async () => {
      assert.equal(await wallet.inputValue(), walletOne.id);
      assert.equal(await wallet.getAttribute("aria-invalid"), "true");
      assert.equal(
        await wallet
          .locator(`option[value="${walletOne.id}"]`)
          .evaluate((option) => option.disabled),
        true,
      );
      assert.equal(
        await contact
          .getByRole("button", { name: "Save contact settings", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(await ethFee.inputValue(), "0.0089");
      assert.equal(await usdFee.inputValue(), "12.75");
      assert.equal(await minimumEth.inputValue(), "0.0009");
      assert.equal(contactWrites, 2);
    },
  );
  await wallet.selectOption(walletTwo.id);

  await contact.locator("summary").filter({ hasText: "NOWPayments merchant setup" }).click();
  const disable = contact.getByRole("button", {
    name: "Disable new hosted checkouts",
    exact: true,
  });
  await disable.waitFor();
  await check(
    "disabling hosted checkouts requires the inline confirmation and Cancel sends no request",
    async () => {
      await disable.click();
      assert.equal(hostedDeletes, 0);
      await contact.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(hostedDeletes, 0);
      assert.equal(await disable.count(), 1);
    },
  );
  await disable.click();
  await contact.getByRole("button", { name: "Confirm disable", exact: true }).click();
  await contact
    .getByRole("status")
    .filter({ hasText: "New hosted checkouts are disabled" })
    .waitFor();
  await check("disabling new hosted checkouts preserves unsaved contact values", async () => {
    assert.equal(hostedDeletes, 1);
    assert.equal(await disable.count(), 0);
    assert.equal(await wallet.inputValue(), walletTwo.id);
    assert.equal(await ethFee.inputValue(), "0.0089");
    assert.equal(await usdFee.inputValue(), "12.75");
    assert.equal(contactWrites, 2);
  });

  await contact.getByLabel("NOWPayments API key", { exact: true }).fill("fixture-api-key");
  await contact.getByLabel("NOWPayments IPN secret", { exact: true }).fill("fixture-ipn-secret");
  await contact.getByRole("button", { name: "Save merchant credentials", exact: true }).click();
  await contact
    .getByRole("status")
    .filter({ hasText: "Merchant credentials saved privately" })
    .waitFor();
  await check(
    "enabling hosted checkout again removes the old disabled notice without saving contact edits",
    async () => {
      assert.equal(hostedWrites, 1);
      await disable.waitFor();
      assert.equal(
        await contact
          .getByRole("status")
          .filter({ hasText: "New hosted checkouts are disabled" })
          .count(),
        0,
      );
      assert.equal(
        await contact.getByLabel("NOWPayments API key", { exact: true }).inputValue(),
        "",
      );
      assert.equal(
        await contact.getByLabel("NOWPayments IPN secret", { exact: true }).inputValue(),
        "",
      );
      assert.equal(await ethFee.inputValue(), "0.0089");
      assert.equal(await usdFee.inputValue(), "12.75");
      assert.equal(contactWrites, 2);
    },
  );

  await donationNotes.uncheck();
  await mode.selectOption("free");
  const unpublished = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/profile/publication" &&
      response.request().method() === "DELETE",
  );
  await publication.getByRole("button", { name: "Unpublish page", exact: true }).click();
  assert.equal((await unpublished).status(), 200);
  await waitForWalletChoices([], walletTwo.id);
  await check(
    "unpublishing removes receiving choices and preserves unsaved fees and availability preferences",
    async () => {
      assert.equal(await wallet.getAttribute("aria-invalid"), "true");
      assert.equal(await wallet.locator("option:not([disabled])").count(), 1);
      await wallet.selectOption("");
      assert.equal(await wallet.isDisabled(), true);
      assert.equal(await mode.inputValue(), "free");
      assert.equal(await donationNotes.isChecked(), false);
      await mode.selectOption("paid");
      assert.equal(await ethFee.inputValue(), "0.0089");
      assert.equal(await usdFee.inputValue(), "12.75");
      assert.equal(
        (await owner.request.get(`${origin}/api/public-profiles/${handle}`)).status(),
        404,
      );
      assert.equal(
        (await owner.request.get(`${origin}/api/creators/${handle}/contact`)).status(),
        404,
      );
      assert.equal(contactWrites, 2);
    },
  );
  await check(
    "publishing changes do not replace the owner's private account profile backup",
    async () => {
      const response = await owner.request.get(`${origin}/api/profile`);
      assert.equal(response.status(), 200);
      assert.deepEqual((await response.json()).profile, originalProfile);
    },
  );
  await check("creator setup has no uncaught browser exceptions", async () => {
    assert.deepEqual(errors, []);
  });
  console.log(`Creator setup browser checks passed: ${checks}`);
} finally {
  for (const release of pendingReleases) release();
  await owner.request
    .delete(`${origin}/api/profile/publication`, { headers: { origin } })
    .catch(() => {});
  await browser.close();
}
