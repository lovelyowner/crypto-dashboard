/** Real HTTP profile checks against the running local app.
 * Usage: node scripts/profile-integration.mjs [http://127.0.0.1:8080]
 * Creates two disposable accounts. Never prints passwords, sessions, or cookies.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:8080").origin;
let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function client() {
  const cookies = new Map();
  async function request(path, { method = "GET", json, body, headers = {} } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        origin,
        ...(json !== undefined || body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookies.size
          ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") }
          : {}),
        ...headers,
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : body !== undefined ? { body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const separator = pair.indexOf("=");
      const key = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (!value || /max-age=0(?:;|$)/i.test(line)) cookies.delete(key);
      else cookies.set(key, value);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { status: response.status, ok: response.ok, data, headers: response.headers };
  }
  return { request };
}

async function createAccount(label) {
  const account = client();
  const suffix = randomBytes(8).toString("hex");
  const email = `profile-integration-${suffix}@example.com`;
  const password = `🔐 ${randomBytes(24).toString("base64")} @/# +`;
  const signup = await account.request("/api/auth/sign-up/email", {
    method: "POST",
    json: { name: label, email, password, username: `profile @ ${suffix}` },
  });
  check(signup.ok && Boolean(signup.data?.user?.id), `${label} signs up successfully`);
  await account.request("/api/auth/sign-out", { method: "POST", json: {} });
  const login = await account.request("/api/auth/sign-in/email", {
    method: "POST",
    json: { email, password, rememberMe: false },
  });
  check(
    login.ok && Boolean(login.data?.user?.id),
    `${label} authenticates with email and password`,
  );
  return { ...account, userId: signup.data.user.id };
}

const publicProfile = (displayName) => ({
  version: 1,
  displayName,
  bio: "A creator profile with links, wishlist items, and public donation details.",
  links: [{ id: "my-links", label: "My links", url: "https://allmylinks.com/fathom" }],
  wishlist: [
    {
      id: "wishlist-item",
      title: "A creative project",
      url: "https://throne.com/fathom/item",
      price: "12.00",
      currency: "USD",
    },
  ],
  serviceLinks: {
    allmylinks: "https://allmylinks.com/fathom",
    throne: "https://throne.com/fathom",
    nowpayments: "https://nowpayments.io/donation/fathom",
    bluesky: "https://bsky.app/profile/fathom.bsky.social",
  },
  donations: {
    bankLink: "https://buy.stripe.com/test_profile",
    crypto: [
      {
        id: "eth-donation",
        chain: "ethereum",
        address: "0x0000000000000000000000000000000000000001",
        label: "ETH donation",
      },
    ],
  },
});

const guest = client();
const configuration = await guest.request("/api/auth/config");
check(
  configuration.ok && configuration.data?.configured,
  "Authentication API is configured for profile checks",
);
const guestRead = await guest.request("/api/profile");
check(guestRead.status === 401, "Guests cannot read account profiles");
const guestWrite = await guest.request("/api/profile", {
  method: "PUT",
  json: { profile: publicProfile("Guest") },
});
check(guestWrite.status === 401, "Guests cannot save account profiles");

const accounts = [];
try {
  const owner = await createAccount("Profile owner");
  accounts.push(owner);
  const other = await createAccount("Other profile owner");
  accounts.push(other);
  const initialOwner = await owner.request("/api/profile");
  const initialOther = await other.request("/api/profile");
  check(
    initialOwner.ok && initialOwner.data?.profile === null,
    "A new owner starts without a stored profile",
  );
  check(
    initialOther.ok && initialOther.data?.profile === null,
    "A second owner starts without a stored profile",
  );

  const draft = publicProfile("Creator 宇宙 🪐");
  const saved = await owner.request("/api/profile", {
    method: "PUT",
    json: { profile: { ...draft, privateKey: "must-not-persist", verified: true } },
  });
  check(saved.ok, "An authenticated owner saves a valid profile");
  check(
    JSON.stringify(saved.data?.profile) === JSON.stringify(draft),
    "Only public whitelisted fields are returned after saving",
  );
  check(
    Number.isFinite(Date.parse(saved.data?.updatedAt)),
    "A saved profile returns its database timestamp",
  );
  const loaded = await owner.request("/api/profile");
  check(
    loaded.ok && JSON.stringify(loaded.data?.profile) === JSON.stringify(draft),
    "The authenticated owner reloads the saved profile",
  );
  check(
    loaded.headers.get("cache-control")?.includes("no-store"),
    "Private profile responses prohibit caching",
  );

  const forged = await other.request(`/api/profile?userId=${encodeURIComponent(owner.userId)}`, {
    headers: { "x-user-id": owner.userId },
  });
  check(
    forged.ok && forged.data?.profile === null,
    "A query parameter and user header cannot read another account's draft",
  );

  const crossOrigin = await owner.request("/api/profile", {
    method: "PUT",
    json: { profile: publicProfile("Unexpected change") },
    headers: { origin: "https://untrusted.example" },
  });
  check(crossOrigin.status === 403, "Cross-origin profile writes are rejected");
  const invalidJson = await owner.request("/api/profile", { method: "PUT", body: "{" });
  check(invalidJson.status === 400, "Malformed JSON is rejected");
  const unsafeLink = await owner.request("/api/profile", {
    method: "PUT",
    json: {
      profile: { ...draft, links: [{ id: "unsafe", label: "Unsafe", url: "javascript:alert(1)" }] },
    },
  });
  check(unsafeLink.status === 400, "Unsafe public links are rejected");
  const forgedWrite = await other.request("/api/profile", {
    method: "PUT",
    json: { userId: owner.userId, profile: publicProfile("Unexpected owner") },
  });
  check(forgedWrite.status === 400, "A profile envelope cannot override its session owner");
  const oversized = await owner.request("/api/profile", {
    method: "PUT",
    body: " ".repeat(128 * 1024 + 1),
  });
  check(oversized.status === 413, "The real HTTP endpoint rejects bodies above 128 KiB");

  const otherDraft = publicProfile("A separate creator");
  const otherSave = await other.request("/api/profile", {
    method: "PUT",
    json: { profile: otherDraft },
  });
  check(otherSave.ok, "A second owner can save their own profile");
  const ownerAfter = await owner.request("/api/profile");
  const otherAfter = await other.request("/api/profile");
  check(
    JSON.stringify(ownerAfter.data?.profile) === JSON.stringify(draft),
    "Rejected writes and another account's save leave the owner's draft intact",
  );
  check(
    JSON.stringify(otherAfter.data?.profile) === JSON.stringify(otherDraft),
    "The second account reloads its own separate draft",
  );
} finally {
  for (const account of accounts) {
    await account.request("/api/auth/sign-out", { method: "POST", json: {} });
    const afterSignout = await account.request("/api/profile");
    check(afterSignout.status === 401, "Signing out revokes access to private account profiles");
  }
}

console.log(`Profile integration passed: ${checks} checks.`);
