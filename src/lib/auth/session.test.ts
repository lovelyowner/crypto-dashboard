import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { ACCOUNT_SESSION_POLICY } from "./policy.ts";

test("active remembered sessions retain their original expiry and expired sessions are denied", async () => {
  const database: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  const auth = betterAuth({
    database: memoryAdapter(database),
    baseURL: "http://localhost:8080",
    secret: randomBytes(32).toString("hex"),
    emailAndPassword: { enabled: true },
    session: ACCOUNT_SESSION_POLICY,
    telemetry: { enabled: false },
    advanced: { useSecureCookies: false },
  });
  const signup = await auth.handler(
    new Request("http://localhost:8080/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin: "http://localhost:8080", "content-type": "application/json" },
      body: JSON.stringify({
        name: "Session expiry fixture",
        email: "expiry@example.com",
        password: randomBytes(32).toString("hex"),
      }),
    }),
  );
  assert.equal(signup.status, 200);
  const cookie = signup.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  assert.ok(cookie);
  assert.equal(database.session.length, 1);
  const day = 24 * 60 * 60_000;
  const expiresAt = new Date(Date.now() + 5 * day);
  database.session[0].createdAt = new Date(Date.now() - 2 * day);
  database.session[0].updatedAt = new Date(Date.now() - 2 * day);
  database.session[0].expiresAt = expiresAt;
  const currentSession = await auth.handler(
    new Request("http://localhost:8080/api/auth/get-session", { headers: { cookie } }),
  );
  assert.equal(currentSession.status, 200);
  const body = await currentSession.json();
  assert.ok(body.user.id);
  assert.equal(
    body.session.expiresAt,
    expiresAt.toISOString(),
    "activity after the refresh interval must not extend absolute expiry",
  );
  assert.equal(new Date(database.session[0].expiresAt as string).getTime(), expiresAt.getTime());
  database.session[0].expiresAt = new Date(Date.now() - 1);
  const expired = await auth.handler(
    new Request("http://localhost:8080/api/auth/get-session", { headers: { cookie } }),
  );
  assert.equal(expired.status, 200);
  assert.equal(await expired.json(), null, "expired sessions cannot authenticate");
});
