/** Real HTTP checks for account session ownership and revocation.
 * Usage: node scripts/session-integration.mjs [http://127.0.0.1:8080]
 * Creates disposable accounts; never prints credentials, cookies or session tokens.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:8080").origin;
const testIp = `192.0.2.${1 + (randomBytes(1)[0] % 254)}`;
let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}
function client(name) {
  const cookies = new Map();
  async function request(path, body, headers = {}) {
    const response = await fetch(`${origin}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        "x-forwarded-for": testIp,
        "user-agent": `Fathom session integration ${name}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookies.size
          ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") }
          : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    return { ok: response.ok, status: response.status, data };
  }
  return { request };
}
function credentials() {
  const suffix = randomBytes(8).toString("hex");
  return {
    email: `session-integration-${suffix}@example.com`,
    username: `session @ ${suffix}`,
    password: `🔐 ${randomBytes(24).toString("base64")} /# +`,
  };
}
async function signup(account, identity) {
  const response = await account.request("/sign-up/email", {
    ...identity,
    name: "Session integration",
  });
  check(response.ok && Boolean(response.data?.user?.id), "Disposable account signup succeeds");
  return response.data.user.id;
}
async function login(account, identity) {
  const response = await account.request("/sign-in/email", {
    email: identity.email,
    password: identity.password,
    rememberMe: false,
  });
  check(response.ok && Boolean(response.data?.user?.id), "An independent client can sign in");
}
async function session(account) {
  const response = await account.request("/get-session");
  check(response.ok, "Session lookup succeeds");
  return response.data;
}

const guest = client("guest");
const owner = client("owner");
const second = client("second");
const third = client("third");
const foreign = client("foreign");
const identity = credentials();
const foreignIdentity = credentials();
try {
  const configuration = await guest.request("/config");
  check(configuration.ok && configuration.data?.configured, "The local account API is configured");
  const anonymousList = await guest.request("/list-sessions");
  check(anonymousList.status === 401, "Guests cannot list account sessions");
  const anonymousRevoke = await guest.request("/revoke-other-sessions", {});
  check(anonymousRevoke.status === 401, "Guests cannot revoke account sessions");

  const ownerId = await signup(owner, identity);
  await login(second, identity);
  const ownerSession = await session(owner);
  const secondSession = await session(second);
  check(
    ownerSession?.user?.id === ownerId &&
      secondSession?.user?.id === ownerId &&
      ownerSession?.session?.id !== secondSession?.session?.id,
    "Independent clients hold distinct sessions for the same account",
  );
  const list = await owner.request("/list-sessions");
  check(
    list.ok &&
      Array.isArray(list.data) &&
      list.data.length === 2 &&
      list.data.every((entry) => entry.userId === ownerId) &&
      list.data.some((entry) => entry.id === ownerSession.session.id) &&
      list.data.some((entry) => entry.id === secondSession.session.id),
    "The owner can list both actual active sessions",
  );
  check(
    list.data.every(
      (entry) =>
        Number.isFinite(new Date(entry.createdAt).getTime()) &&
        new Date(entry.expiresAt).getTime() > Date.now() &&
        typeof entry.userAgent === "string",
    ),
    "Listed sessions include valid dates and device metadata",
  );

  const foreignId = await signup(foreign, foreignIdentity);
  const foreignList = await foreign.request("/list-sessions");
  check(
    foreignList.ok &&
      foreignList.data.length === 1 &&
      foreignList.data.every((entry) => entry.userId === foreignId),
    "Another account can list only its own sessions",
  );
  // Better Auth deliberately returns success for an unknown or foreign token;
  // the important guarantee is that the other user's session survives.
  await foreign.request("/revoke-session", { token: secondSession.session.token });
  check(
    (await session(second))?.session?.id === secondSession.session.id,
    "A foreign account cannot revoke another user's session",
  );
  const crossSite = await owner.request(
    "/revoke-session",
    { token: secondSession.session.token },
    { origin: "https://outside.example.org" },
  );
  check(crossSite.status === 403, "Cross-origin revocation is rejected");
  check(
    (await session(second))?.session?.id === secondSession.session.id,
    "Rejected cross-origin revocation preserves the target session",
  );

  const revoked = await owner.request("/revoke-session", { token: secondSession.session.token });
  check(revoked.ok && revoked.data?.status === true, "The owner can revoke another session");
  check(!(await session(second))?.user, "A revoked session no longer authenticates");
  check(
    (await session(owner))?.session?.id === ownerSession.session.id,
    "Single-session revocation keeps the current session signed in",
  );
  const remaining = await owner.request("/list-sessions");
  check(
    remaining.ok && remaining.data.length === 1 && remaining.data[0].id === ownerSession.session.id,
    "The revoked session disappears from the authoritative list",
  );

  await login(second, identity);
  await login(third, identity);
  const expanded = await owner.request("/list-sessions");
  check(
    expanded.ok && expanded.data.length === 3,
    "New independent sign-ins create active sessions",
  );
  const revokeOthers = await owner.request("/revoke-other-sessions", {});
  check(
    revokeOthers.ok && revokeOthers.data?.status === true,
    "The owner can revoke every other session",
  );
  check(
    !(await session(second))?.user && !(await session(third))?.user,
    "Revoking other sessions invalidates each independent client",
  );
  check(
    (await session(owner))?.session?.id === ownerSession.session.id,
    "Revoking other sessions preserves the current session",
  );
  const finalList = await owner.request("/list-sessions");
  check(
    finalList.ok && finalList.data.length === 1 && finalList.data[0].id === ownerSession.session.id,
    "Only the current session remains active for the owner",
  );
  check(
    (await session(foreign))?.user?.id === foreignId,
    "Bulk revocation does not affect another account",
  );
  console.log(
    `Session integration: ${checks} checks passed (real ownership, CSRF and server revocation).`,
  );
} finally {
  await Promise.allSettled([
    owner.request("/sign-out", {}),
    second.request("/sign-out", {}),
    third.request("/sign-out", {}),
    foreign.request("/sign-out", {}),
  ]);
}
