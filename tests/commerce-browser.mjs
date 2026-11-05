/** Real local creator inbox flow plus explicit payment-UI fixtures.
 * No real wallet transaction, external checkout, or blockchain request is performed.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chromium } from "playwright";

const origin = new URL(process.env.TEST_BASE_URL || "http://127.0.0.1:8080").origin;
const suffix = randomBytes(8).toString("hex");
const handle = `commerce-${suffix}`;
const ethereumAddress = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const contexts = [];
const errors = [];
let checks = 0;
async function check(description, run) {
  await run();
  checks += 1;
  console.log(`PASS ${description}`);
}
async function context(viewport = { width: 1440, height: 1000 }) {
  const value = await browser.newContext({
    viewport,
    extraHTTPHeaders: { "x-forwarded-for": `203.0.113.${1 + (randomBytes(1)[0] % 254)}` },
  });
  contexts.push(value);
  value.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  await value.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort("blockedbyclient"),
  );
  return value;
}
async function account(value, label) {
  const unique = randomBytes(8).toString("hex"),
    email = `commerce-${unique}@example.com`,
    password = `🔐 ${randomBytes(24).toString("base64")} +/#`;
  const response = await value.request.post(`${origin}/api/auth/sign-up/email`, {
    headers: { origin },
    data: { name: label, email, password, username: `commerce @ ${unique}` },
  });
  assert.ok(response.ok(), "Disposable local account signup succeeds");
  const body = await response.json();
  return { email, password, id: body.user.id, label };
}
const profile = {
  version: 1,
  displayName: "Commerce creator 🌙",
  bio: "Private creator messaging.",
  links: [{ id: "work", label: "My work", url: "https://example.org/work" }],
  wishlist: [],
  serviceLinks: { allmylinks: "", throne: "", nowpayments: "", bluesky: "" },
  donations: {
    bankLink: "",
    crypto: [
      {
        id: "eth-wallet",
        chain: "ethereum",
        address: ethereumAddress,
        label: "Creator ETH wallet",
      },
    ],
  },
};
const baseSettings = {
  dmMode: "free",
  dmEthPrice: "",
  dmUsdPrice: "",
  donationNotesEnabled: true,
  minimumDonationEth: "0.000001",
  minimumDonationUsd: "1.00",
  ethDonationAddressId: "eth-wallet",
};
let owner;
try {
  owner = await context();
  await account(owner, "Commerce creator owner");
  const senderSetup = await context();
  const sender = await account(senderSetup, "Commerce sender 🪐");
  const publish = await owner.request.put(`${origin}/api/profile/publication`, {
    headers: { origin },
    data: { handle, profile },
  });
  assert.ok(publish.ok(), "Creator publication succeeds");
  const save = await owner.request.put(`${origin}/api/profile/contact`, {
    headers: { origin },
    data: { settings: baseSettings },
  });
  assert.ok(save.ok(), "Creator contact policy setup succeeds");
  const ownerPage = await owner.newPage();
  await ownerPage.goto(origin, { waitUntil: "domcontentloaded" });
  await ownerPage.getByLabel("Display name", { exact: true }).waitFor({ state: "attached" });
  await ownerPage.getByRole("button", { name: "Profile", exact: true }).click();
  await ownerPage.getByRole("heading", { name: "Profile", exact: true }).waitFor();
  const setup = ownerPage.locator(".profile-contact-settings");
  await setup.getByLabel("Direct messages", { exact: true }).waitFor();
  await setup.getByLabel("Direct messages", { exact: true }).selectOption("closed");
  await setup.getByRole("button", { name: "Save contact settings", exact: true }).click();
  await setup.getByRole("status").filter({ hasText: "settings saved" }).waitFor();
  await setup.getByLabel("Direct messages", { exact: true }).selectOption("free");
  await setup.getByRole("button", { name: "Save contact settings", exact: true }).click();
  await setup.getByRole("status").filter({ hasText: "settings saved" }).waitFor();
  await check(
    "creator settings save the selected published wallet and free-DM policy",
    async () => {
      const response = await owner.request.get(`${origin}/api/profile/contact`),
        data = await response.json();
      assert.equal(data.settings.dmMode, "free");
      assert.equal(data.settings.ethDonationAddressId, "eth-wallet");
      assert.equal(
        await setup.getByLabel("Ethereum receiving wallet", { exact: true }).inputValue(),
        "eth-wallet",
      );
    },
  );

  const member = await context();
  const memberPage = await member.newPage();
  const publicApiCalls = [];
  memberPage.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) publicApiCalls.push(path);
  });
  await memberPage.goto(`${origin}/${handle}`, { waitUntil: "domcontentloaded" });
  const contact = memberPage.getByRole("region", { name: "Contact this creator", exact: true });
  await contact.getByRole("button", { name: "Send a private message", exact: true }).waitFor();
  await check(
    "public contact availability does not inspect the visitor's account before interaction",
    async () => {
      assert.ok(publicApiCalls.length >= 2);
      assert.ok(
        publicApiCalls.every((path) =>
          [`/api/public-profiles/${handle}`, `/api/creators/${handle}/contact`].includes(path),
        ),
      );
    },
  );
  await contact.getByRole("button", { name: "Send a private message", exact: true }).click();
  const login = contact.getByRole("link", { name: "Sign in or create an account", exact: true });
  await login.waitFor();
  await check(
    "signed-out DMs require sign-in and preserve the creator as a safe return path",
    async () => {
      const url = new URL(await login.getAttribute("href"), origin);
      assert.equal(url.pathname, "/login");
      assert.equal(url.searchParams.get("next"), `/${handle}`);
    },
  );
  await login.click();
  const panel = memberPage.locator(".account-panel");
  await panel.locator('input[autocomplete="email"]').fill(sender.email);
  await panel.locator('input[autocomplete="current-password"]').fill(sender.password);
  await panel.getByRole("button", { name: "Sign in", exact: true }).click();
  await memberPage.waitForURL(`${origin}/${handle}`);
  await contact.getByRole("button", { name: "Send a private message", exact: true }).click();
  await contact.getByText(`Sending as ${sender.label}`, { exact: true }).waitFor();
  const text = "Hello creator 🪐 <script>literal UI text</script>";
  await contact.getByLabel("Your message", { exact: true }).fill(text);
  await contact.getByRole("button", { name: "Send private message", exact: true }).click();
  await contact.getByRole("status").filter({ hasText: "Private message sent" }).waitFor();
  await check(
    "a signed-in visitor sends a real private free DM after returning from login",
    async () => {
      const response = await member.request.get(`${origin}/api/inbox?folder=sent`),
        data = await response.json();
      assert.equal(data.messages[0].text, text);
      assert.equal(data.messages[0].paymentStatus, "free");
      assert.equal(data.messages[0].senderName, sender.label);
    },
  );
  await ownerPage.getByRole("button", { name: "Inbox", exact: true }).click();
  await ownerPage.locator(".creator-inbox-row").filter({ hasText: sender.label }).click();
  await ownerPage.locator(".creator-inbox-transcript").getByText(text, { exact: true }).waitFor();
  await ownerPage
    .getByLabel("Private reply", { exact: true })
    .fill("Thanks, this stays in our private conversation 🌟");
  await ownerPage.getByRole("button", { name: "Send reply", exact: true }).click();
  await ownerPage
    .locator(".creator-inbox-transcript")
    .getByText("Thanks, this stays in our private conversation 🌟", { exact: true })
    .waitFor();
  await check(
    "the creator inbox renders literal message text and sends a participant-only reply",
    async () => {
      assert.equal(await ownerPage.locator(".creator-inbox-transcript script").count(), 0);
      const result = await owner.request.get(`${origin}/api/inbox`),
        data = await result.json();
      assert.ok(data.messages[0].readAt);
      assert.equal(data.messages[0].paymentStatus, "free");
    },
  );

  const paidSettings = { ...baseSettings, dmMode: "paid", dmEthPrice: "0.001", dmUsdPrice: "5.00" };
  assert.ok(
    (
      await owner.request.put(`${origin}/api/profile/contact`, {
        headers: { origin },
        data: { settings: paidSettings },
      })
    ).ok(),
  );
  await memberPage.goto(`${origin}/${handle}`, { waitUntil: "domcontentloaded" });
  await contact.getByRole("button", { name: "Send a paid DM", exact: true }).click();
  await contact.getByText(`Sending as ${sender.label}`, { exact: true }).waitFor();
  await check(
    "paid-DM composer displays a per-message price without treating typing as payment",
    async () => {
      assert.match(await contact.innerText(), /0\.001 ETH/);
      assert.equal(
        await contact.getByRole("button", { name: "Send private message", exact: true }).count(),
        0,
      );
      assert.equal(
        await contact
          .getByRole("heading", { name: "Payment verified · message delivered", exact: true })
          .count(),
        0,
      );
    },
  );

  // Everything below intentionally stubs the payment API and Ethereum wallet.
  // These checks verify UI sequencing only; verifier security is tested separately.
  const donor = await context({ width: 390, height: 844 });
  const donorPage = await donor.newPage();
  const donorCalls = [],
    prepared = [];
  const paymentId = randomUUID(),
    messageId = randomUUID(),
    capability = "b".repeat(64),
    reference = `0x${"a".repeat(64)}`,
    txHash = `0x${"c".repeat(64)}`;
  let paid = false,
    mode = "ethereum",
    verifyCount = 0;
  const nativePayment = {
    id: paymentId,
    messageId,
    kind: "donation",
    method: "ethereum",
    status: "pending",
    amount: "0.00002",
    currency: "ETH",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    confirmations: 0,
    transaction: {
      chainId: 1,
      to: ethereumAddress,
      value: `0x${20_000_000_000_000n.toString(16)}`,
      data: reference,
    },
  };
  const hostedPayment = {
    ...nativePayment,
    method: "nowpayments",
    amount: "2.00",
    currency: "USD",
    transaction: undefined,
    checkoutUrl: "https://nowpayments.io/payment/?iid=fixture-only",
  };
  await donor.addInitScript(
    ({ hash }) => {
      window.__walletRequests = [];
      window.ethereum = {
        async request(request) {
          window.__walletRequests.push(request);
          if (request.method === "eth_requestAccounts")
            return ["0x1111111111111111111111111111111111111111"];
          if (request.method === "eth_chainId") return "0x1";
          if (request.method === "eth_sendTransaction") return hash;
          return null;
        },
      };
    },
    { hash: txHash },
  );
  await donor.route(`**/api/creators/${handle}/contact`, async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    await route.fulfill({ response, json: { ...data, nowpaymentsConfigured: true } });
  });
  await donor.route("**/api/payments{,/**}", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let receipt = mode === "ethereum" ? nativePayment : hostedPayment;
    if (path === "/api/payments") {
      prepared.push(JSON.parse(request.postData()));
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ payment: receipt, capabilityToken: capability }),
      });
      return;
    }
    assert.equal(request.headers()["x-payment-token"], capability);
    if (path.endsWith("/verify")) {
      assert.equal(JSON.parse(request.postData()).transactionHash, txHash);
      verifyCount++;
      nativePayment.transactionHash = txHash;
      nativePayment.confirmations = 1;
    }
    receipt = {
      ...receipt,
      status: paid ? "paid" : "pending",
      confirmations: paid ? 3 : receipt.confirmations,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ payment: receipt }),
    });
  });
  donorPage.on("request", (request) => donorCalls.push(new URL(request.url()).pathname));
  await donorPage.goto(`${origin}/${handle}`, { waitUntil: "domcontentloaded" });
  const donorContact = donorPage.getByRole("region", { name: "Contact this creator", exact: true });
  await donorContact.getByRole("button", { name: "Donate with a message", exact: true }).click();
  await donorContact.getByLabel("Your message", { exact: true }).fill("Anonymous support 💜");
  await donorContact.getByLabel("Donation amount · ETH", { exact: true }).fill("0.00002");
  await donorContact.getByRole("button", { name: "Continue to payment", exact: true }).click();
  const receipt = donorContact.getByRole("region", { name: "Payment for message", exact: true });
  await receipt.getByRole("button", { name: "Pay with browser wallet", exact: true }).waitFor();
  await check(
    "anonymous donation preparation stays private and pending in payment UI fixtures",
    async () => {
      assert.equal(prepared[0].anonymous, true);
      assert.equal(prepared[0].kind, "donation");
      assert.equal(prepared[0].method, "ethereum");
      assert.equal(donorCalls.includes("/api/auth/get-session"), false);
      assert.match(
        await donorContact.innerText(),
        /Blockchain transfers remain public|random reference/,
      );
      assert.equal(
        await receipt
          .getByRole("heading", { name: "Payment verified · message delivered", exact: true })
          .count(),
        0,
      );
    },
  );
  await receipt.getByRole("button", { name: "Pay with browser wallet", exact: true }).click();
  await receipt.getByText("Confirmations: 1 / 3.", { exact: false }).waitFor();
  await check(
    "wallet UI sends the issued destination, exact value and nonce without unlocking on submission",
    async () => {
      const calls = await donorPage.evaluate(() => window.__walletRequests);
      const sent = calls.find((request) => request.method === "eth_sendTransaction").params[0];
      assert.equal(sent.to, nativePayment.transaction.to);
      assert.equal(sent.value, nativePayment.transaction.value);
      assert.equal(sent.data, reference);
      assert.equal(verifyCount, 1);
      assert.equal(
        await receipt
          .getByRole("heading", { name: "Payment verified · message delivered", exact: true })
          .count(),
        0,
      );
    },
  );
  paid = true;
  await receipt.getByRole("button", { name: "Refresh payment status", exact: true }).click();
  await receipt
    .getByRole("heading", { name: "Payment verified · message delivered", exact: true })
    .waitFor();
  await check(
    "payment UI unlocks only after its server fixture reports paid and never stores the anonymous capability",
    async () => {
      assert.equal(new URL(donorPage.url()).search, "");
      assert.equal(new URL(donorPage.url()).hash, "");
      assert.equal((await donorPage.content()).includes(capability), false);
      assert.equal(
        await donorPage.evaluate(
          (token) =>
            [...Object.values(localStorage), ...Object.values(sessionStorage)].some((value) =>
              String(value).includes(token),
            ),
          capability,
        ),
        false,
      );
    },
  );
  await check(
    "public donation and payment controls fit mobile and preserve the white/gray palette",
    async () => {
      assert.ok(await donorPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.equal(
        await donorPage
          .locator("main")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
        "rgb(255, 255, 255)",
      );
    },
  );

  mode = "nowpayments";
  paid = false;
  await donorPage.goto(`${origin}/${handle}`, { waitUntil: "domcontentloaded" });
  await donorContact.getByRole("button", { name: "Donate with a message", exact: true }).click();
  await donorContact.getByLabel("Payment option", { exact: true }).selectOption("nowpayments");
  await donorContact.getByLabel("Your message", { exact: true }).fill("Hosted checkout fixture");
  await donorContact.getByLabel("Donation amount · USD", { exact: true }).fill("2.00");
  await donorContact.getByRole("button", { name: "Continue to payment", exact: true }).click();
  await receipt.getByRole("link", { name: "Open NOWPayments checkout", exact: true }).waitFor();
  await check(
    "hosted checkout UI exposes the provider link while remaining unverified",
    async () => {
      assert.equal(prepared.at(-1).method, "nowpayments");
      assert.equal(
        await receipt
          .getByRole("link", { name: "Open NOWPayments checkout", exact: true })
          .getAttribute("href"),
        hostedPayment.checkoutUrl,
      );
      await receipt.getByRole("button", { name: "Refresh payment status", exact: true }).click();
      assert.equal(
        await receipt
          .getByRole("heading", { name: "Payment verified · message delivered", exact: true })
          .count(),
        0,
      );
      assert.equal(
        donorCalls.some((path) => path.includes("nowpayments.io")),
        false,
      );
    },
  );
  mode = "ethereum";
  paid = false;
  delete nativePayment.transactionHash;
  nativePayment.confirmations = 0;
  nativePayment.expiresAt = new Date(Date.now() + 500).toISOString();
  await donorPage.goto(`${origin}/${handle}`, { waitUntil: "domcontentloaded" });
  await donorContact.getByRole("button", { name: "Donate with a message", exact: true }).click();
  await donorContact.getByLabel("Your message", { exact: true }).fill("Expired quote fixture");
  await donorContact.getByLabel("Donation amount · ETH", { exact: true }).fill("0.00002");
  await donorContact.getByRole("button", { name: "Continue to payment", exact: true }).click();
  await receipt.getByText("Payment expired", { exact: true }).waitFor();
  await check("an expired native quote cannot start a new wallet payment", async () => {
    assert.equal(
      await receipt.getByRole("button", { name: "Pay with browser wallet", exact: true }).count(),
      0,
    );
    assert.equal(await donorPage.evaluate(() => window.__walletRequests.length), 0);
    assert.equal(
      await receipt.getByRole("button", { name: "Refresh payment status", exact: true }).count(),
      1,
    );
  });
  await check("commerce browser flows have no runtime errors", async () =>
    assert.deepEqual(errors, []),
  );
  console.log(
    `Commerce browser: ${checks} checks passed (real free-message flow; native/hosted payment UI fixtures only).`,
  );
} finally {
  if (owner)
    await owner.request
      .delete(`${origin}/api/profile/publication`, { headers: { origin } })
      .catch(() => undefined);
  await Promise.all(contexts.map((value) => value.close()));
  await browser.close();
}
