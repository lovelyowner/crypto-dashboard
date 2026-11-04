/** Real HTTP checks for explicit public-profile publication.
 * Usage: node scripts/publication-integration.mjs [http://127.0.0.1:8080]
 * Creates disposable local accounts and unpublishes their test pages afterward.
 * Credentials, cookies, and session tokens are never printed.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:8080").origin;
const privatePath = "/api/profile/publication";
const suffix = randomBytes(8).toString("hex");
const handle = `pub-${suffix}`;
let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}
function client() {
  const cookies = new Map();
  const ip = `198.51.100.${1 + (randomBytes(1)[0] % 254)}`;
  async function request(path, { method = "GET", json, body, headers = {} } = {}) {
    const requestHeaders = new Headers({ origin, "x-forwarded-for": ip });
    if (json !== undefined || body !== undefined)
      requestHeaders.set("content-type", "application/json");
    if (cookies.size)
      requestHeaders.set(
        "cookie",
        [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
      );
    for (const [key, value] of Object.entries(headers)) {
      if (value === null) requestHeaders.delete(key);
      else requestHeaders.set(key, value);
    }
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: requestHeaders,
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
  const accountSuffix = randomBytes(8).toString("hex");
  const email = `publication-${accountSuffix}@example.com`;
  const password = `🔐 ${randomBytes(24).toString("base64")} @/# +`;
  const signup = await account.request("/api/auth/sign-up/email", {
    method: "POST",
    json: { name: label, email, password, username: `publication @ ${accountSuffix}` },
  });
  check(signup.ok && Boolean(signup.data?.user?.id), `${label} creates a real account session`);
  return { ...account, userId: signup.data.user.id, email };
}
const profile = (displayName) => ({
  version: 1,
  displayName,
  bio: "Public links, a wishlist, and support options. 宇宙 🪐",
  links: [{ id: "site", label: "Portfolio", url: "https://creator.example.org/portfolio" }],
  wishlist: [
    {
      id: "gift",
      title: "Creative tools",
      url: "https://shop.example.org/tools",
      price: "19.50",
      currency: "EUR",
    },
  ],
  serviceLinks: {
    allmylinks: "",
    throne: "",
    nowpayments: "",
    bluesky: "https://bsky.app/profile/creator.bsky.social",
  },
  donations: {
    bankLink: "https://buy.stripe.com/test_publication",
    crypto: [
      {
        id: "eth",
        chain: "ethereum",
        address: "0x0000000000000000000000000000000000000001",
        label: "Support",
      },
    ],
  },
});
const guest = client();
const publicPath = `/api/public-profiles/${handle}`;
const accounts = [];
try {
  const config = await guest.request("/api/auth/config");
  check(config.ok && config.data?.configured, "Local authentication is configured");
  for (const method of ["GET", "PUT", "DELETE"]) {
    const result = await guest.request(privatePath, {
      method,
      ...(method === "PUT" ? { json: { handle, profile: profile("Guest") } } : {}),
    });
    check(result.status === 401, `Anonymous ${method} cannot manage a publication`);
  }
  const absent = await guest.request(publicPath);
  check(
    absent.status === 404 && absent.data?.message === "Public profile not found.",
    "An unknown public handle has a uniform not-found response",
  );
  check(
    absent.headers.get("cache-control")?.includes("no-store"),
    "Not-found responses cannot cache a stale public state",
  );

  const owner = await createAccount("Publication owner");
  accounts.push(owner);
  const rival = await createAccount("Publication rival");
  accounts.push(rival);
  const initial = await owner.request(privatePath);
  check(initial.ok && initial.data?.publication === null, "A new account has no published profile");
  const draft = await owner.request("/api/profile", {
    method: "PUT",
    json: { profile: profile("Private draft only") },
  });
  check(
    draft.ok && (await guest.request(publicPath)).status === 404,
    "Saving an account draft does not publish it",
  );

  const snapshot = profile("Published creator 宇宙 🪐");
  const publish = (account, extras = {}) =>
    account.request(privatePath, { method: "PUT", json: { handle, profile: snapshot }, ...extras });
  check(
    (await publish(owner, { headers: { origin: null } })).status === 403,
    "Publishing requires a same-origin Origin header",
  );
  check(
    (await publish(owner, { headers: { origin: "https://untrusted.example" } })).status === 403,
    "Cross-origin publishing is rejected",
  );
  check(
    (await publish(owner, { headers: { "sec-fetch-site": "cross-site" } })).status === 403,
    "Cross-site fetch metadata rejects a forged origin",
  );
  check(
    (await publish(owner, { headers: { "content-type": "text/plain" } })).status === 415,
    "Publishing requires JSON content type",
  );
  check(
    (await owner.request(privatePath, { method: "PUT", body: "{" })).status === 400,
    "Malformed JSON cannot publish a page",
  );
  check(
    (
      await owner.request(privatePath, {
        method: "PUT",
        json: { handle, profile: snapshot, userId: rival.userId },
      })
    ).status === 400,
    "A publication envelope cannot override the session owner",
  );
  check(
    (
      await owner.request(privatePath, {
        method: "PUT",
        json: { handle: "../bad", profile: snapshot },
      })
    ).status === 400,
    "Invalid public handles are rejected",
  );
  check(
    (
      await owner.request(privatePath, {
        method: "PUT",
        json: { handle, profile: { ...snapshot, displayName: " " } },
      })
    ).status === 400,
    "Publishing requires a nonempty creator display name",
  );
  check(
    (
      await owner.request(privatePath, {
        method: "PUT",
        json: {
          handle,
          profile: {
            ...snapshot,
            links: [{ id: "unsafe", label: "Unsafe", url: "javascript:alert(1)" }],
          },
        },
      })
    ).status === 400,
    "Unsafe profile destinations cannot be published",
  );
  check(
    (await owner.request(privatePath, { method: "PUT", body: " ".repeat(128 * 1024 + 1) }))
      .status === 413,
    "Publication payloads above 128 KiB are rejected over real HTTP",
  );

  const published = await owner.request(privatePath, {
    method: "PUT",
    json: {
      handle: handle.toUpperCase(),
      profile: {
        ...snapshot,
        email: owner.email,
        privateKey: "do-not-publish-fixture",
        verified: true,
      },
    },
  });
  check(
    published.ok &&
      published.data?.publication?.published === true &&
      published.data.publication.handle === handle,
    "An explicit publish creates a normalized stable public handle",
  );
  const publicPage = await guest.request(publicPath);
  check(
    publicPage.ok &&
      publicPage.data?.handle === handle &&
      JSON.stringify(publicPage.data.profile) === JSON.stringify(snapshot),
    "Anonymous visitors receive the published public snapshot",
  );
  check(
    JSON.stringify(Object.keys(publicPage.data).sort()) ===
      JSON.stringify(["handle", "profile", "updatedAt"]),
    "Public response exposes no owner, email, credential, or publication metadata",
  );
  check(
    !JSON.stringify(publicPage.data).includes(owner.email) &&
      !JSON.stringify(publicPage.data).includes(owner.userId) &&
      !JSON.stringify(publicPage.data).includes("do-not-publish-fixture"),
    "Private and unverified identity extras are removed at the public boundary",
  );
  check(
    publicPage.headers.get("set-cookie") === null &&
      publicPage.headers.get("cache-control")?.includes("no-store"),
    "Anonymous public reads set no session cookies and prohibit stale caching",
  );
  check(
    Number.isFinite(Date.parse(publicPage.data.updatedAt)),
    "Public pages include a valid database update timestamp",
  );

  const otherView = await rival.request(
    `${privatePath}?userId=${encodeURIComponent(owner.userId)}`,
    { headers: { "x-user-id": owner.userId } },
  );
  check(
    otherView.ok && otherView.data?.publication === null,
    "Private publication metadata always follows the authenticated owner",
  );
  check(
    (await publish(rival)).status === 409,
    "Another account cannot claim an owned public handle",
  );
  check(
    (
      await owner.request(privatePath, {
        method: "PUT",
        json: { handle: `other-${suffix}`, profile: snapshot },
      })
    ).status === 409,
    "An account cannot silently rename its reserved public URL",
  );
  check(
    (
      await owner.request(privatePath, {
        method: "DELETE",
        headers: { origin: "https://untrusted.example" },
      })
    ).status === 403,
    "Cross-origin unpublishing is rejected",
  );
  const rivalUnpublish = await rival.request(privatePath, { method: "DELETE" });
  check(
    rivalUnpublish.ok &&
      rivalUnpublish.data?.publication === null &&
      (await guest.request(publicPath)).ok,
    "Another account cannot unpublish the owner's page",
  );

  await owner.request("/api/profile", {
    method: "PUT",
    json: { profile: profile("Changed private draft") },
  });
  check(
    (await guest.request(publicPath)).data?.profile?.displayName === snapshot.displayName,
    "Editing a private draft leaves the published snapshot unchanged",
  );
  const updated = profile("Updated creator snapshot");
  const update = await owner.request(privatePath, {
    method: "PUT",
    json: { handle, profile: updated },
  });
  check(
    update.ok &&
      (await guest.request(publicPath)).data?.profile?.displayName === updated.displayName,
    "Explicitly updating changes the same stable public URL",
  );

  const removed = await owner.request(privatePath, { method: "DELETE" });
  check(
    removed.ok &&
      removed.data?.publication?.published === false &&
      removed.data.publication.handle === handle,
    "Unpublishing retains the owner's reserved handle and private metadata",
  );
  const unpublished = await guest.request(publicPath);
  check(
    unpublished.status === 404 && JSON.stringify(unpublished.data) === JSON.stringify(absent.data),
    "An unpublished page is indistinguishable from an unknown public handle",
  );
  check(
    (await publish(rival)).status === 409,
    "An unpublished handle cannot be taken over by another account",
  );
  const republished = await owner.request(privatePath, {
    method: "PUT",
    json: { handle, profile: updated },
  });
  check(
    republished.ok &&
      (await guest.request(publicPath)).data?.profile?.displayName === updated.displayName,
    "The owner can republish the same URL",
  );
} finally {
  for (const account of accounts) {
    try {
      await account.request(privatePath, { method: "DELETE" });
    } catch {
      /* Keep the original test failure. */
    }
    try {
      await account.request("/api/auth/sign-out", { method: "POST", json: {} });
    } catch {
      /* The disposable local session can expire normally. */
    }
  }
}
console.log(
  `Publication integration passed: ${checks} checks (real local sessions and public/private ownership).`,
);
