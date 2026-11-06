import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { username } from "better-auth/plugins";
import {
  identifierSignIn,
  normalizeIdentifierSignInResponse,
} from "./identifier-sign-in.server.js";
import { accountTwoFactor } from "./passkeys.server.js";
import { sessionDurationPlugin } from "./session-duration.js";
import {
  isValidUsername,
  normalizeUsername,
  ACCOUNT_SESSION_POLICY,
  SESSION_DURATION_HEADER,
} from "./policy.js";

const origin = "http://localhost:8080";
const passwordA = "fixture-password-A-🔐";
const passwordB = "fixture-password-B-⚡";
let fixtureIp = 1;

function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret.toUpperCase()]
    .map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0"))
    .join("");
  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((value) => parseInt(value, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hash = createHmac("sha1", bytes).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

function fixture(max = 100) {
  const database: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
    twoFactor: [],
  };
  let userLookups = 0;
  const adapter = memoryAdapter(database);
  const auth = betterAuth({
    database: (options: Parameters<typeof adapter>[0]) => {
      const storage = adapter(options);
      return {
        ...storage,
        async findOne<T>(input: Parameters<typeof storage.findOne>[0]) {
          if (input.model === "user") userLookups++;
          return storage.findOne<T>(input);
        },
      };
    },
    baseURL: origin,
    trustedOrigins: [origin],
    secret: randomBytes(32).toString("hex"),
    logger: { disabled: true },
    telemetry: { enabled: false },
    emailAndPassword: { enabled: true },
    session: ACCOUNT_SESSION_POLICY,
    rateLimit: {
      enabled: true,
      storage: "memory",
      customRules: { "/sign-in/*": { window: 60, max } },
    },
    advanced: {
      cookiePrefix: "fathom",
      useSecureCookies: false,
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    plugins: [
      identifierSignIn(),
      username({
        minUsernameLength: 1,
        maxUsernameLength: 128,
        usernameValidator: isValidUsername,
        usernameNormalization: normalizeUsername,
        displayUsernameNormalization: normalizeUsername,
      }),
      accountTwoFactor(origin),
      sessionDurationPlugin(),
    ],
  });
  const ip = `10.71.0.${fixtureIp++}`;
  const cookies = new Map<string, string>();
  async function request(
    path: string,
    body?: Record<string, unknown> | string,
    options: { headers?: Record<string, string>; duration?: string; method?: string } = {},
  ) {
    const headers = new Headers({
      origin,
      "x-forwarded-for": ip,
      cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      [SESSION_DURATION_HEADER]: options.duration ?? "1d",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...options.headers,
    });
    const incoming = new Request(`${origin}/api/auth${path}`, {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      ...(body !== undefined
        ? { body: typeof body === "string" ? body : JSON.stringify(body) }
        : {}),
    });
    const raw = await auth.handler(incoming);
    const response = path.startsWith("/sign-in/identifier")
      ? await normalizeIdentifierSignInResponse(raw)
      : raw;
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0],
        at = pair.indexOf("=");
      const name = pair.slice(0, at),
        value = pair.slice(at + 1);
      if (!value || /max-age=0(?:;|$)/i.test(line)) cookies.delete(name);
      else cookies.set(name, value);
    }
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  }
  async function signup(email: string, name: string, password = passwordA) {
    const result = await request("/sign-up/email", {
      email,
      username: name,
      displayUsername: name,
      name,
      password,
      rememberMe: false,
    });
    assert.equal(result.response.status, 200);
    return result.body.user;
  }
  async function signout() {
    assert.equal((await request("/sign-out", {})).response.status, 200);
  }
  return { database, cookies, request, signup, signout, lookups: () => userLookups };
}

test("one field signs in with case-insensitive email and NFC, case-sensitive Unicode usernames", async () => {
  const app = fixture();
  const user = await app.signup("combined@example.com", "Cafe\u0301 ⚡ @symbol");
  await app.signout();
  for (const identifier of [
    "COMBINED@EXAMPLE.COM",
    "  COMBINED@EXAMPLE.COM  ",
    "Café ⚡ @symbol",
    "  Café ⚡ @symbol  ",
    "Cafe\u0301 ⚡ @symbol",
  ]) {
    const result = await app.request("/sign-in/identifier", {
      identifier,
      password: passwordA,
      rememberMe: false,
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.user.id, user.id);
    await app.signout();
  }
  const wrongCase = await app.request("/sign-in/identifier", {
    identifier: "CAFÉ ⚡ @symbol",
    password: passwordA,
  });
  assert.equal(wrongCase.response.status, 401);
});

test("email-shaped usernames remain usable when no registered account email matches", async () => {
  const app = fixture();
  const user = await app.signup("real-address@example.com", "email-shaped@example.com");
  await app.signout();
  const result = await app.request("/sign-in/identifier", {
    identifier: "email-shaped@example.com",
    password: passwordA,
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.user.id, user.id);
});

test("registered email wins a collision and bad credentials never fall through to another account", async () => {
  const app = fixture();
  const owner = await app.signup("owner@example.com", "owner");
  const other = await app.signup("other@example.com", "owner@example.com", passwordB);
  await app.signout();
  const rejected = await app.request("/sign-in/identifier", {
    identifier: "owner@example.com",
    password: passwordB,
  });
  assert.equal(rejected.response.status, 401);
  assert.equal((await app.request("/get-session")).body, null);
  const accepted = await app.request("/sign-in/identifier", {
    identifier: "OWNER@example.com",
    password: passwordA,
  });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.user.id, owner.id);
  await app.signout();
  const otherViaEmail = await app.request("/sign-in/identifier", {
    identifier: "other@example.com",
    password: passwordB,
  });
  assert.equal(otherViaEmail.response.status, 200);
  assert.equal(otherViaEmail.body.user.id, other.id);
  await app.signout();
  const legacy = await app.request("/sign-in/username", {
    username: "owner@example.com",
    password: passwordB,
  });
  assert.equal(legacy.response.status, 200);
  assert.equal(legacy.body.user.id, other.id);
});

test("invalid credentials share one namespace-neutral response without sessions", async () => {
  const app = fixture();
  await app.signup("known@example.com", "known-user");
  await app.signout();
  const errors = [];
  for (const identifier of [
    "known@example.com",
    "known-user",
    "missing@example.com",
    "missing-user",
    "bad\u200buser",
    "x".repeat(100),
  ]) {
    const result = await app.request("/sign-in/identifier", {
      identifier,
      password: "incorrect fixture password",
    });
    assert.equal(result.response.status, 401);
    errors.push(result.body);
    assert.equal((await app.request("/get-session")).body, null);
  }
  for (const body of errors)
    assert.deepEqual(body, {
      code: "INVALID_IDENTIFIER_OR_PASSWORD",
      message: "Incorrect email or username, or password.",
    });
});

test("body and origin checks happen before account lookup, including cross-site first login", async () => {
  const app = fixture();
  const input = { identifier: "unknown", password: passwordA };
  const rejectedOrigins: { headers: Record<string, string> }[] = [
    { headers: { origin: "https://attacker.invalid" } },
    { headers: { origin: "null" } },
    { headers: { "sec-fetch-site": "cross-site" } },
  ];
  for (const options of rejectedOrigins) {
    const before = app.lookups();
    assert.equal((await app.request("/sign-in/identifier", input, options)).response.status, 403);
    assert.equal(app.lookups(), before);
  }
  for (const [body, status] of [
    ["{broken", 400],
    [{ identifier: {}, password: passwordA }, 400],
    [{ identifier: "  ", password: passwordA }, 400],
    [{ identifier: "unknown", password: "x".repeat(257) }, 400],
    [{ identifier: "x".repeat(321), password: passwordA }, 400],
    [{ ...input, rememberMe: "yes" }, 400],
    ["x".repeat(9_000), 413],
  ] as const) {
    const before = app.lookups();
    assert.equal(
      (await app.request("/sign-in/identifier", body as Record<string, unknown> | string)).response
        .status,
      status,
    );
    assert.equal(app.lookups(), before);
  }
  const before = app.lookups();
  assert.equal(
    (await app.request("/sign-in/identifier", input, { headers: { "content-type": "text/plain" } }))
      .response.status,
    415,
  );
  assert.equal(app.lookups(), before);
});

test("shared identifier rate limit runs before resolution and cannot be split by identifier kind", async () => {
  const app = fixture(2);
  for (const identifier of ["unknown-name", "unknown@example.com"])
    assert.equal(
      (await app.request("/sign-in/identifier", { identifier, password: passwordA })).response
        .status,
      401,
    );
  const before = app.lookups();
  const limited = await app.request("/sign-in/identifier", {
    identifier: "another-name",
    password: passwordA,
  });
  assert.equal(limited.response.status, 429);
  assert.equal(app.lookups(), before);
});

test("native TOTP, signed session duration, Remember cookies and password normalization survive dispatch", async () => {
  const app = fixture();
  const password = "fixture-ＡＢＣ-🔐-password";
  await app.signup("mfa@example.com", "mfa ⚡", password);
  const enabled = await app.request("/two-factor/enable", { password });
  assert.equal(enabled.response.status, 200);
  const secret = new URL(enabled.body.totpURI).searchParams.get("secret")!;
  assert.equal(
    (await app.request("/two-factor/verify-totp", { code: totp(secret) })).response.status,
    200,
  );
  await app.signout();
  const pending = await app.request(
    "/sign-in/identifier",
    { identifier: "mfa ⚡", password: "fixture-ABC-🔐-password", rememberMe: false },
    { duration: "1h" },
  );
  assert.equal(pending.response.status, 200);
  assert.equal(pending.body.twoFactorRedirect, true);
  assert.equal((await app.request("/get-session")).body, null);
  assert.ok(app.cookies.has("fathom.login_duration"));
  const completed = await app.request(
    "/two-factor/verify-totp",
    { code: totp(secret), trustDevice: false },
    { duration: "7d" },
  );
  assert.equal(completed.response.status, 200);
  const session = await app.request("/get-session");
  const remaining = new Date(session.body.session.expiresAt).getTime() - Date.now();
  assert.ok(remaining > 3_590_000 && remaining <= 3_600_000);
  const sessionCookie = completed.response.headers
    .getSetCookie()
    .find((line) => line.startsWith("fathom.session_token="));
  assert.ok(sessionCookie);
  assert.doesNotMatch(sessionCookie, /;\s*(?:max-age|expires)=/i);
  await app.signout();
  const remembered = await app.request("/sign-in/identifier", {
    identifier: "MFA@example.com",
    password,
    rememberMe: true,
  });
  assert.equal(remembered.body.twoFactorRedirect, true);
  const verified = await app.request("/two-factor/verify-totp", {
    code: totp(secret),
    trustDevice: false,
  });
  const persistent = verified.response.headers
    .getSetCookie()
    .find((line) => line.startsWith("fathom.session_token="));
  assert.match(persistent!, /max-age=/i);
});

test("native callback and session-policy validation still reject unsafe login options", async () => {
  const app = fixture();
  await app.signup("policies@example.com", "policy-user");
  await app.signout();
  const input = { identifier: "policy-user", password: passwordA, rememberMe: false };
  const invalidDuration = await app.request("/sign-in/identifier", input, { duration: "forever" });
  assert.equal(invalidDuration.response.status, 400);
  assert.equal((await app.request("/get-session")).body, null);
  const unsafeCallback = await app.request("/sign-in/identifier", {
    ...input,
    callbackURL: "https://attacker.invalid/steal",
  });
  assert.equal(unsafeCallback.response.status, 403);
  assert.equal((await app.request("/get-session")).body, null);
  const valid = await app.request("/sign-in/identifier", { ...input, callbackURL: "/creator" });
  assert.equal(valid.response.status, 200);
  assert.equal(valid.response.headers.get("location"), "/creator");
});

test("identifier padding is trimmed without modifying the password's surrounding characters", async () => {
  const app = fixture();
  const password = "  fixture-password-with-spaces  ";
  await app.signup("spaces@example.com", "space-user", password);
  await app.signout();
  const accepted = await app.request("/sign-in/identifier", {
    identifier: "  SPACES@example.com  ",
    password,
  });
  assert.equal(accepted.response.status, 200);
  await app.signout();
  const wrong = await app.request("/sign-in/identifier", {
    identifier: "space-user",
    password: password.trim(),
  });
  assert.equal(wrong.response.status, 401);
});
