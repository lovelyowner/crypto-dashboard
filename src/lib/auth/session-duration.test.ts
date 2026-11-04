import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { twoFactor } from "better-auth/plugins";
import { sessionDurationPlugin } from "./session-duration.ts";
import { ACCOUNT_SESSION_POLICY, SESSION_DURATION_HEADER } from "./policy.ts";

function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret].map((ch) => alphabet.indexOf(ch).toString(2).padStart(5, "0")).join("");
  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((part) => parseInt(part, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", bytes).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1)! & 15) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}

test("selected duration is enforced in real sessions, cookies, 2FA and backup-code recovery", async () => {
  const database: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    twoFactor: [],
  };
  const auth = betterAuth({
    database: memoryAdapter(database),
    baseURL: "http://localhost:8080",
    secret: randomBytes(32).toString("hex"),
    emailAndPassword: { enabled: true },
    session: ACCOUNT_SESSION_POLICY,
    telemetry: { enabled: false },
    plugins: [
      twoFactor({ backupCodeOptions: { length: 16, storeBackupCodes: "encrypted" } }),
      sessionDurationPlugin(),
    ],
    advanced: { cookiePrefix: "fathom", useSecureCookies: false },
  });
  const cookies = new Map<string, string>();
  async function request(path: string, body?: Record<string, unknown>, duration?: string) {
    const response = await auth.handler(
      new Request(`http://localhost:8080/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          origin: "http://localhost:8080",
          ...(body ? { "content-type": "application/json" } : {}),
          ...(duration ? { [SESSION_DURATION_HEADER]: duration } : {}),
          cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0];
      const i = pair.indexOf("=");
      const name = pair.slice(0, i),
        value = pair.slice(i + 1);
      if (!value || /max-age=0(?:;|$)/i.test(line)) cookies.delete(name);
      else cookies.set(name, value);
    }
    return { response, body: await response.json() };
  }
  const password = randomBytes(24).toString("hex");
  const credentials = { email: "duration@example.com", password };
  const signup = await request(
    "/sign-up/email",
    { ...credentials, name: "Duration fixture", rememberMe: true },
    "1h",
  );
  assert.equal(signup.response.status, 200);
  const assertExpiry = async (seconds: number) => {
    const result = await request("/get-session");
    assert.equal(result.response.status, 200);
    const remaining = new Date(result.body.session.expiresAt).getTime() - Date.now();
    assert.ok(
      remaining > seconds * 1000 - 10_000 && remaining <= seconds * 1000,
      `Expected ${seconds}s server lifetime`,
    );
    return result.body.session;
  };
  await assertExpiry(3600);
  const signupCookie = signup.response.headers
    .getSetCookie()
    .reverse()
    .find((line) => line.startsWith("fathom.session_token="));
  assert.match(signupCookie!, /Max-Age=35\d\d/i);
  await request("/sign-out", {});
  const invalidDuration = await request(
    "/sign-in/email",
    { ...credentials, rememberMe: true },
    "365d",
  );
  assert.equal(invalidDuration.response.status, 400);
  assert.equal((await request("/get-session")).body, null);
  await request("/sign-in/email", { ...credentials, rememberMe: true }, "7d");
  await assertExpiry(7 * 86400);
  const enable = await request("/two-factor/enable", { password });
  assert.equal(enable.response.status, 200);
  const secret = new URL(enable.body.totpURI).searchParams.get("secret")!;
  const backupCode = enable.body.backupCodes[0];
  assert.equal(backupCode.replaceAll("-", "").length, 16);
  await request("/two-factor/verify-totp", { code: totp(secret) });
  await request("/sign-out", {});
  const challenge = await request("/sign-in/email", { ...credentials, rememberMe: true }, "1h");
  assert.equal(challenge.body.twoFactorRedirect, true);
  assert.equal(
    cookies.has("fathom.login_duration"),
    true,
    "Selected duration survives the password challenge",
  );
  assert.equal((await request("/get-session")).body, null);
  // Supplying a different header at completion cannot expand the signed policy.
  const verified = await request(
    "/two-factor/verify-totp",
    { code: totp(secret), trustDevice: false },
    "7d",
  );
  assert.equal(verified.response.status, 200);
  const session = await assertExpiry(3600);
  assert.equal(cookies.has("fathom.login_duration"), false);
  // An expired row is rejected even if the browser retains its cookie.
  database.session.find((row) => row.id === session.id)!.expiresAt = new Date(Date.now() - 1);
  assert.equal((await request("/get-session")).body, null);
  await request("/sign-out", {});
  await request("/sign-in/email", { ...credentials, rememberMe: false }, "1d");
  const recovered = await request("/two-factor/verify-backup-code", {
    code: backupCode,
    trustDevice: false,
  });
  assert.equal(recovered.response.status, 200);
  await assertExpiry(86400);
  const recoveryCookie = recovered.response.headers
    .getSetCookie()
    .reverse()
    .find((line) => line.startsWith("fathom.session_token="));
  assert.doesNotMatch(recoveryCookie!, /;\s*(?:max-age|expires)=/i);
  await request("/sign-out", {});
  await request("/sign-in/email", { ...credentials, rememberMe: true }, "1h");
  // A tampered policy cookie falls back to the shortest lifetime.
  cookies.set("fathom.login_duration", "7d.forged-signature");
  const tampered = await request("/two-factor/verify-totp", {
    code: totp(secret),
    trustDevice: false,
  });
  assert.equal(tampered.response.status, 200);
  await assertExpiry(3600);
});
