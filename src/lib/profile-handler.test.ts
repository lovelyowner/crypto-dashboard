import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CREATOR_PROFILE, type CreatorProfile } from "./creator-profile";
import {
  createProfileHandler,
  MAX_PROFILE_BODY_BYTES,
  type ProfileHandlerDependencies,
  type ProfileSession,
  type StoredCreatorProfile,
} from "./profile-handler";

const origin = "https://fathom.example";
const timestamp = "2026-01-01T00:00:00.000Z";
const profile = (): CreatorProfile => ({
  ...structuredClone(DEFAULT_CREATOR_PROFILE),
  displayName: "Creator",
});
const session = (userId = "owner"): ProfileSession => ({
  user: { id: userId },
  session: { userId, expiresAt: "2030-01-01T00:00:00.000Z" },
});

function harness(overrides: Partial<ProfileHandlerDependencies> = {}) {
  const reads: string[] = [];
  const writes: { userId: string; profile: CreatorProfile }[] = [];
  let sessionCalls = 0;
  const handle = createProfileHandler({
    configured: true,
    allowedOrigins: [origin],
    now: () => new Date(timestamp).getTime(),
    getSession: async () => {
      sessionCalls += 1;
      return session();
    },
    store: {
      read: async (userId) => {
        reads.push(userId);
        return null;
      },
      write: async (userId, value) => {
        writes.push({ userId, profile: value });
        return { profile: value, updatedAt: timestamp };
      },
    },
    ...overrides,
  });
  return { handle, reads, writes, sessionCalls: () => sessionCalls };
}

function put(body: unknown = { profile: profile() }, headers: HeadersInit = {}) {
  return new Request(`${origin}/api/profile`, {
    method: "PUT",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("profile drafts require configured authentication and a live matching session", async () => {
  const unavailable = harness({ configured: false });
  assert.equal((await unavailable.handle(new Request(`${origin}/api/profile`))).status, 503);
  assert.equal(unavailable.sessionCalls(), 0);
  for (const value of [
    null,
    { ...session(), session: { userId: "other", expiresAt: "2030-01-01" } },
    { ...session(), session: { userId: "owner", expiresAt: "2025-01-01" } },
    { ...session(), session: { userId: "owner", expiresAt: "invalid" } },
  ]) {
    const { handle, reads, writes } = harness({ getSession: async () => value });
    const response = await handle(
      new Request(`${origin}/api/profile?userId=other`, {
        headers: { "x-user-id": "other", Authorization: "Bearer made-up-token" },
      }),
    );
    assert.equal(response.status, 401);
    assert.deepEqual(reads, []);
    assert.deepEqual(writes, []);
  }
});

test("GET scopes drafts to the authenticated owner and never caches private content", async () => {
  const { handle, reads } = harness();
  const response = await handle(
    new Request(`${origin}/api/profile?userId=someone-else`, {
      headers: { "x-user-id": "someone-else" },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { profile: null, updatedAt: null });
  assert.deepEqual(reads, ["owner"]);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("PUT stores only validated public profile fields under the session owner", async () => {
  const { handle, writes } = harness();
  const draft = {
    ...profile(),
    password: "never-persist-this",
    privateKey: "never-persist-this-either",
    serviceLinks: { ...profile().serviceLinks, verified: true },
    donations: { ...profile().donations, recoveryCodes: ["secret"] },
  };
  const response = await handle(put({ profile: draft }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { profile: profile(), updatedAt: timestamp });
  assert.deepEqual(writes, [{ userId: "owner", profile: profile() }]);
  assert.equal(JSON.stringify(writes).includes("never-persist"), false);
});

test("PUT rejects missing, forged, and cross-site origins before accessing storage", async () => {
  for (const invalid of [
    "",
    "null",
    "https://evil.example",
    `${origin}.evil.example`,
    `${origin}/path`,
  ]) {
    const { handle, writes } = harness();
    const request = put(undefined, { Origin: invalid });
    if (!invalid) request.headers.delete("origin");
    assert.equal((await handle(request)).status, 403);
    assert.deepEqual(writes, []);
  }
  const { handle, writes } = harness();
  assert.equal((await handle(put(undefined, { "Sec-Fetch-Site": "cross-site" }))).status, 403);
  assert.deepEqual(writes, []);
});

test("PUT requires JSON and rejects malformed or owner-changing envelopes", async () => {
  const { handle, writes } = harness();
  assert.equal((await handle(put(undefined, { "Content-Type": "text/plain" }))).status, 415);
  for (const body of [
    "{",
    [],
    null,
    { userId: "other", profile: profile() },
    { profile: null },
    { profile: { ...profile(), links: [{ id: "x", label: "Bad", url: "javascript:alert(1)" }] } },
  ])
    assert.equal((await handle(put(body))).status, 400);
  const invalidUtf8 = new Request(`${origin}/api/profile`, {
    method: "PUT",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: new Uint8Array([0xff]),
  });
  assert.equal((await handle(invalidUtf8)).status, 400);
  assert.deepEqual(writes, []);
});

test("PUT enforces a byte limit with absent or misleading Content-Length", async () => {
  for (const contentLength of [undefined, "1"]) {
    const { handle, writes } = harness();
    let cancelled = false;
    const request = new Request(`${origin}/api/profile`, {
      method: "PUT",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(contentLength ? { "Content-Length": contentLength } : {}),
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          // Multibyte text passes a character count but exceeds the byte cap.
          controller.enqueue(new TextEncoder().encode("🪐".repeat(MAX_PROFILE_BODY_BYTES / 3)));
        },
        cancel() {
          cancelled = true;
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    assert.equal((await handle(request)).status, 413);
    assert.equal(cancelled, true);
    assert.deepEqual(writes, []);
  }
  const { handle, writes } = harness();
  assert.equal(
    (await handle(put(undefined, { "Content-Length": String(MAX_PROFILE_BODY_BYTES + 1) }))).status,
    413,
  );
  assert.deepEqual(writes, []);
});

test("GET revalidates persisted fields and hides internal storage errors", async () => {
  const stored: StoredCreatorProfile = {
    profile: { ...profile(), recoveryCodes: ["do-not-leak"] },
    updatedAt: new Date(timestamp),
  };
  const { handle } = harness({
    store: {
      read: async () => stored,
      write: async () => {
        throw new Error("unused");
      },
    },
  });
  const response = await handle(new Request(`${origin}/api/profile`));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { profile: profile(), updatedAt: timestamp });

  const broken = harness({
    store: {
      read: async () => {
        throw new Error("database password=do-not-leak");
      },
      write: async () => {
        throw new Error("unused");
      },
    },
  });
  const failure = await broken.handle(new Request(`${origin}/api/profile`));
  assert.equal(failure.status, 500);
  assert.equal((await failure.text()).includes("do-not-leak"), false);
});

test("profile API does not expose a public publishing or deleting method", async () => {
  const { handle, reads, writes } = harness();
  const response = await handle(new Request(`${origin}/api/profile`, { method: "DELETE" }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, PUT");
  assert.deepEqual(reads, []);
  assert.deepEqual(writes, []);
});
