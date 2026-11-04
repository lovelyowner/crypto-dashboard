/** Real HTTP checks against the running local app; no external identity provider required.
 * Usage: node scripts/auth-integration.mjs [http://127.0.0.1:8080]
 * Creates a disposable account with random credentials. Never logs keys, codes or cookies.
 */
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:8080").origin;
const suffix = randomBytes(8).toString("hex");
const username = `試験 @ 🪐 +${suffix}`;
const email = `integration-${suffix}@example.com`;
const password = `🔐 ${randomBytes(24).toString("base64")} @/# +`;
let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function client() {
  const cookies = new Map();
  let recentCookies = [];
  async function request(path, body, duration) {
    const response = await fetch(`${origin}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(duration ? { "x-fathom-session-duration": duration } : {}),
        ...(cookies.size
          ? { cookie: Array.from(cookies, ([k, v]) => `${k}=${v}`).join("; ") }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    recentCookies = response.headers.getSetCookie();
    for (const line of recentCookies) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      const key = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (/max-age=0(?:;|$)/i.test(line) || value === "") cookies.delete(key);
      else cookies.set(key, value);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { status: response.status, ok: response.ok, data, setCookies: recentCookies };
  }
  return { request };
}

function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.toUpperCase().replace(/=+$/, "")) {
    const n = alphabet.indexOf(ch);
    assert.ok(n >= 0, "Server returned a valid base32 TOTP secret");
    bits += n.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hmac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const guest = client();
const anonymousSession = await guest.request("/get-session");
check(
  anonymousSession.ok && !anonymousSession.data?.user,
  "Anonymous request has no authenticated session",
);
const addPasswordAsGuest = await guest.request("/add-password", { newPassword: password });
check(!addPasswordAsGuest.ok, "Anonymous requests cannot add an account password");
const privateAccounts = await guest.request("/list-accounts");
check(!privateAccounts.ok, "Anonymous requests cannot list linked accounts");

const user = client();
const signup = await user.request("/sign-up/email", {
  name: "Integration account",
  email,
  password,
  username,
});
check(
  signup.ok && Boolean(signup.data?.user?.id),
  "Email signup with a Unicode symbol username succeeds",
);
const session = await user.request("/get-session");
check(
  session.ok && session.data?.user?.username === username.normalize("NFC"),
  "Signup creates a real session with the intended Unicode username",
);
const unverifiedLink = await user.request("/link-social", { provider: "google", callbackURL: "/" });
check(
  unverifiedLink.status === 403 &&
    unverifiedLink.data?.message === "Verify your email before linking a social account.",
  "Unverified local email cannot link a social provider",
);
const unverifiedAddPassword = await user.request("/add-password", { newPassword: password });
check(
  unverifiedAddPassword.status === 403 &&
    unverifiedAddPassword.data?.message === "Verify your email before adding a password.",
  "Unverified local email cannot add another password",
);
const accounts = await user.request("/list-accounts");
check(
  accounts.ok &&
    Array.isArray(accounts.data) &&
    accounts.data.some((a) => a.providerId === "credential"),
  "Credential login is recorded as a linked account",
);
const unlink = await user.request("/unlink-account", { providerId: "credential" });
check(!unlink.ok, "The only remaining sign-in method cannot be removed");
await user.request("/sign-out", {});
const wrong = await user.request("/sign-in/username", { username, password: `${password}wrong` });
check(!wrong.ok, "Wrong password is rejected");
const invalidDuration = await user.request("/sign-in/username", { username, password }, "365d");
check(invalidDuration.status === 400, "Unsupported session duration is rejected");
const signin = await user.request(
  "/sign-in/username",
  { username, password, rememberMe: false },
  "1h",
);
check(
  signin.ok && !signin.data?.twoFactorRedirect,
  "Unicode username and arbitrary-symbol password can sign in",
);
const sessionCookie = signin.setCookies.find((s) => /^[^=]*session_token=/.test(s));
check(
  Boolean(sessionCookie) && !/;\s*(?:max-age|expires)=/i.test(sessionCookie),
  "rememberMe=false produces a browser-session login cookie",
);
const shortSession = await user.request("/get-session");
const shortRemaining = new Date(shortSession.data?.session?.expiresAt).getTime() - Date.now();
check(
  shortRemaining > 3_590_000 && shortRemaining <= 3_600_000,
  "One-hour choice changes actual server session expiry",
);

const enable = await user.request("/two-factor/enable", { password, issuer: "Fathom" });
check(
  enable.ok && typeof enable.data?.totpURI === "string",
  "TOTP enrollment produces an authenticator URI",
);
check(
  Array.isArray(enable.data?.backupCodes) &&
    enable.data.backupCodes.length === 10 &&
    enable.data.backupCodes.every((code) => code.replaceAll("-", "").length === 16),
  "Enrollment supplies ten 16-character recovery codes",
);
const backupCode = enable.data.backupCodes[0];
const secret = new URL(enable.data.totpURI).searchParams.get("secret");
check(Boolean(secret), "Authenticator URI includes a secret");
const unverified = await user.request("/get-session");
check(
  !unverified.data?.user?.twoFactorEnabled,
  "2FA remains disabled until authenticator verification",
);
const invalidEnroll = await user.request("/two-factor/verify-totp", { code: "invalid" });
check(!invalidEnroll.ok, "Invalid enrollment code cannot activate 2FA");
const verify = await user.request("/two-factor/verify-totp", { code: totp(secret) });
check(verify.ok, "A real RFC6238 authenticator code activates 2FA");
const enabled = await user.request("/get-session");
check(enabled.data?.user?.twoFactorEnabled === true, "Server records verified 2FA enrollment");
await user.request("/sign-out", {});
const challenge = await user.request(
  "/sign-in/username",
  {
    username,
    password,
    rememberMe: false,
  },
  "1h",
);
check(
  challenge.ok && challenge.data?.twoFactorRedirect === true,
  "Password login is challenged when 2FA is enabled",
);
const pending = await user.request("/get-session");
check(!pending.data?.user, "A password alone does not establish a 2FA session");
const badCode = await user.request("/two-factor/verify-totp", { code: "invalid" });
check(!badCode.ok, "Invalid authenticator code is rejected at login");
const challenged = await user.request(
  "/two-factor/verify-totp",
  {
    code: totp(secret),
    trustDevice: false,
  },
  "7d",
);
check(challenged.ok, "Correct authenticator code completes challenged login");
const signedIn = await user.request("/get-session");
check(
  signedIn.data?.user?.username === username,
  "2FA completion grants the expected account session",
);
const challengedRemaining = new Date(signedIn.data?.session?.expiresAt).getTime() - Date.now();
check(
  challengedRemaining > 3_590_000 && challengedRemaining <= 3_600_000,
  "2FA completion preserves the signed one-hour deadline despite a different header",
);
await user.request("/sign-out", {});
await user.request("/sign-in/username", { username, password, rememberMe: false }, "7d");
const recover = await user.request("/two-factor/verify-backup-code", {
  code: backupCode,
  trustDevice: false,
});
check(recover.ok, "A saved backup code can recover the 2FA login");
const recoverySession = await user.request("/get-session");
const recoveryRemaining = new Date(recoverySession.data?.session?.expiresAt).getTime() - Date.now();
check(
  recoveryRemaining > 604_790_000 && recoveryRemaining <= 604_800_000,
  "Recovery-code login preserves the selected seven-day server lifetime",
);
await user.request("/sign-out", {});
await user.request("/sign-in/username", { username, password, rememberMe: false });
const replay = await user.request("/two-factor/verify-backup-code", {
  code: backupCode,
  trustDevice: false,
});
check(!replay.ok, "A consumed backup code cannot be reused");
const noReplaySession = await user.request("/get-session");
check(!noReplaySession.data?.user, "Rejected recovery-code replay does not create a session");
console.log(
  `Auth integration: ${checks} checks passed (Unicode login, server-enforced duration, verified TOTP, single-use recovery, access controls).`,
);
