import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CREATOR_PROFILE } from "./creator-profile";
import { PublicationConflictError } from "./public-profile";
import {
  createPublicationHandlers,
  MAX_PUBLICATION_BODY_BYTES,
  type PublicationHandlerDependencies,
  type StoredPublication,
} from "./publication-handler";

const origin = "https://dashboard.example.com";
const now = Date.parse("2026-11-04T12:00:00.000Z");
const profile = { ...structuredClone(DEFAULT_CREATOR_PROFILE), displayName: "Creator 🌙" };
const existing: StoredPublication = {
  handle: "creator",
  profile,
  updatedAt: new Date(now),
  published: true,
};
const session = {
  user: { id: "owner" },
  session: { userId: "owner", expiresAt: new Date(now + 3600_000) },
};

function fixture(overrides: Partial<PublicationHandlerDependencies> = {}) {
  const calls: Array<{ method: string; userId?: string; handle?: string; profile?: unknown }> = [];
  const handlers = createPublicationHandlers({
    configured: true,
    allowedOrigins: [origin],
    now: () => now,
    getSession: async () => session,
    store: {
      async read(userId) {
        calls.push({ method: "read", userId });
        return existing;
      },
      async readPublic(handle) {
        calls.push({ method: "readPublic", handle });
        return existing;
      },
      async publish(userId, handle, profile) {
        calls.push({ method: "publish", userId, handle, profile });
        return { ...existing, handle, profile };
      },
      async unpublish(userId) {
        calls.push({ method: "unpublish", userId });
        return { ...existing, published: false };
      },
    },
    ...overrides,
  });
  return { ...handlers, calls };
}
function request(
  method = "GET",
  body?: unknown,
  headers: HeadersInit = {},
  path = "/api/profile/publication",
) {
  return new Request(origin + path, {
    method,
    headers: {
      origin,
      ...(method === "PUT" ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
async function expectStatus(response: Response, status: number) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  return response.json();
}

test("publication management requires configured authentication and a live matching account session", async () => {
  const unconfigured = fixture({ configured: false });
  await expectStatus(await unconfigured.handlePublicationRequest(request()), 503);
  assert.deepEqual(unconfigured.calls, []);
  for (const value of [
    null,
    { ...session, session: { ...session.session, userId: "other" } },
    { ...session, session: { ...session.session, expiresAt: new Date(now) } },
    { ...session, session: { ...session.session, expiresAt: "invalid" } },
  ]) {
    const app = fixture({ getSession: async () => value });
    for (const method of ["GET", "PUT", "DELETE"])
      await expectStatus(await app.handlePublicationRequest(request(method)), 401);
    assert.deepEqual(app.calls, []);
  }
});

test("private metadata and publish responses whitelist public fields without leaking owner details", async () => {
  const app = fixture();
  const metadata = await expectStatus(await app.handlePublicationRequest(request()), 200);
  assert.deepEqual(metadata, {
    publication: { ...existing, updatedAt: new Date(now).toISOString() },
  });
  const response = await app.handlePublicationRequest(
    request("PUT", {
      handle: " CREATOR ",
      profile: {
        ...profile,
        userId: "not-the-owner",
        email: "private@example.com",
        password: "must-not-leak",
      },
    }),
  );
  const published = await expectStatus(response, 200);
  assert.deepEqual(published.publication.profile, profile);
  assert.deepEqual(app.calls.at(-1), {
    method: "publish",
    userId: "owner",
    handle: "creator",
    profile,
  });
  assert.doesNotMatch(JSON.stringify(published), /not-the-owner|private@example|must-not-leak/);
  assert.equal(response.headers.get("vary"), "Cookie, Origin");
});

test("PUT and DELETE require the configured same-origin browser context before reading session or storage", async () => {
  let authCalls = 0;
  const app = fixture({
    getSession: async () => {
      authCalls++;
      return session;
    },
  });
  for (const method of ["PUT", "DELETE"]) {
    for (const headers of [
      { origin: "" },
      { origin: "https://evil.example.com" },
      { origin, "sec-fetch-site": "cross-site" },
      { origin: "https://dashboard.example.com.evil.example" },
    ] as Record<string, string>[]) {
      await expectStatus(
        await app.handlePublicationRequest(request(method, undefined, headers)),
        403,
      );
    }
  }
  assert.equal(authCalls, 0);
  assert.deepEqual(app.calls, []);
});

test("publish input requires JSON and a strict validated handle/profile envelope", async () => {
  const app = fixture();
  await expectStatus(
    await app.handlePublicationRequest(request("PUT", {}, { "content-type": "text/plain" })),
    415,
  );
  for (const body of [
    "not-json",
    "",
    "null",
    [],
    {},
    { handle: "creator", profile, userId: "other" },
    { handle: "../creator", profile },
    { handle: "creator", profile: DEFAULT_CREATOR_PROFILE },
    {
      handle: "creator",
      profile: {
        ...profile,
        links: [{ id: "unsafe", label: "Click", url: "javascript:alert(1)" }],
      },
    },
  ]) {
    await expectStatus(await app.handlePublicationRequest(request("PUT", body)), 400);
  }
  assert.deepEqual(app.calls, []);
});

test("publication byte limits cannot be bypassed by missing or misleading Content-Length", async () => {
  const app = fixture();
  await expectStatus(
    await app.handlePublicationRequest(
      request("PUT", "{}", { "content-length": String(MAX_PUBLICATION_BODY_BYTES + 1) }),
    ),
    413,
  );
  for (const headers of [{}, { "content-length": "2" }] as Record<string, string>[]) {
    await expectStatus(
      await app.handlePublicationRequest(
        request("PUT", "a".repeat(MAX_PUBLICATION_BODY_BYTES + 1), headers),
      ),
      413,
    );
  }
  await expectStatus(
    await app.handlePublicationRequest(
      request("PUT", "🌙".repeat(Math.floor(MAX_PUBLICATION_BODY_BYTES / 4) + 1)),
    ),
    413,
  );
  const invalidUtf8 = new Request(origin + "/api/profile/publication", {
    method: "PUT",
    headers: { origin, "content-type": "application/json" },
    body: new Uint8Array([0xc3, 0x28]),
  });
  await expectStatus(await app.handlePublicationRequest(invalidUtf8), 400);
  assert.deepEqual(app.calls, []);
});

test("unpublish uses only the session owner and retains the private handle snapshot", async () => {
  const app = fixture();
  const unpublished = await expectStatus(
    await app.handlePublicationRequest(request("DELETE", undefined, { "x-user-id": "other" })),
    200,
  );
  assert.equal(unpublished.publication.published, false);
  assert.equal(unpublished.publication.handle, "creator");
  assert.deepEqual(unpublished.publication.profile, profile);
  assert.deepEqual(app.calls, [{ method: "unpublish", userId: "owner" }]);
  // Idempotence is represented by a null metadata record and no claimed handle.
  const empty = fixture({
    store: {
      read: async () => null,
      readPublic: async () => null,
      publish: async () => existing,
      unpublish: async () => null,
    },
  });
  assert.deepEqual(
    await expectStatus(await empty.handlePublicationRequest(request("DELETE")), 200),
    { publication: null },
  );
});

test("handle conflicts become safe 409 responses while database internals stay hidden", async () => {
  const baseStore = {
    read: async () => existing,
    readPublic: async () => existing,
    unpublish: async () => existing,
  };
  const conflict = fixture({
    store: {
      ...baseStore,
      publish: async () => {
        throw new PublicationConflictError("private database detail");
      },
    },
  });
  const body = await expectStatus(
    await conflict.handlePublicationRequest(request("PUT", { handle: "creator", profile })),
    409,
  );
  assert.doesNotMatch(JSON.stringify(body), /private database/);
  const broken = fixture({
    store: {
      ...baseStore,
      publish: async () => {
        throw new Error("password=must-not-leak");
      },
    },
  });
  const failed = await expectStatus(
    await broken.handlePublicationRequest(request("PUT", { handle: "creator", profile })),
    500,
  );
  assert.doesNotMatch(JSON.stringify(failed), /password|must-not-leak/);
});

test("public lookup never authenticates visitors and returns only the published snapshot", async () => {
  let authCalls = 0;
  const app = fixture({
    getSession: async () => {
      authCalls++;
      throw new Error("Public lookup must not authenticate");
    },
  });
  const response = await app.handlePublicProfileRequest(
    request(
      "GET",
      undefined,
      { cookie: "private-cookie", "x-user-id": "other" },
      "/api/public-profiles/CREATOR",
    ),
  );
  const value = await expectStatus(response, 200);
  assert.deepEqual(value, { handle: "creator", profile, updatedAt: new Date(now).toISOString() });
  assert.equal(authCalls, 0);
  assert.deepEqual(app.calls, [{ method: "readPublic", handle: "creator" }]);
  assert.equal(response.headers.getSetCookie().length, 0);
  assert.doesNotMatch(JSON.stringify(value), /owner|published|userId|emailVerified/);
});

test("unknown, invalid and unpublished public handles share an identical 404 response", async () => {
  const missing = fixture({
    store: {
      read: async () => null,
      readPublic: async () => null,
      publish: async () => existing,
      unpublish: async () => null,
    },
  });
  const hidden = fixture({
    store: {
      read: async () => existing,
      readPublic: async () => ({ ...existing, published: false }),
      publish: async () => existing,
      unpublish: async () => existing,
    },
  });
  const expected = { message: "Public profile not found." };
  assert.deepEqual(
    await expectStatus(
      await missing.handlePublicProfileRequest(
        request("GET", undefined, {}, "/api/public-profiles/missing"),
      ),
      404,
    ),
    expected,
  );
  assert.deepEqual(
    await expectStatus(
      await hidden.handlePublicProfileRequest(
        request("GET", undefined, {}, "/api/public-profiles/creator"),
      ),
      404,
    ),
    expected,
  );
  for (const path of [
    "/api/public-profiles/ab",
    "/api/public-profiles/%zz",
    "/api/public-profiles/a%2Fb",
    "/api/public-profiles/creator/extra",
  ]) {
    assert.deepEqual(
      await expectStatus(
        await missing.handlePublicProfileRequest(request("GET", undefined, {}, path)),
        404,
      ),
      expected,
    );
  }
});

test("public records are revalidated and neither endpoint accepts unsupported mutations", async () => {
  const invalid = fixture({
    store: {
      read: async () => ({
        ...existing,
        profile: {
          ...profile,
          links: [{ id: "link", label: "Unsafe", url: "javascript:alert(1)" }],
        },
      }),
      readPublic: async () => ({ ...existing, handle: "another" }),
      publish: async () => existing,
      unpublish: async () => existing,
    },
  });
  await expectStatus(await invalid.handlePublicationRequest(request()), 500);
  await expectStatus(
    await invalid.handlePublicProfileRequest(
      request("GET", undefined, {}, "/api/public-profiles/creator"),
    ),
    500,
  );
  const app = fixture();
  const deniedPrivate = await app.handlePublicationRequest(request("POST"));
  await expectStatus(deniedPrivate, 405);
  assert.equal(deniedPrivate.headers.get("allow"), "GET, PUT, DELETE");
  const deniedPublic = await app.handlePublicProfileRequest(
    request("PUT", {}, {}, "/api/public-profiles/creator"),
  );
  await expectStatus(deniedPublic, 405);
  assert.equal(deniedPublic.headers.get("allow"), "GET");
  const unconfigured = fixture({ configured: false });
  await expectStatus(
    await unconfigured.handlePublicProfileRequest(
      request("GET", undefined, {}, "/api/public-profiles/creator"),
    ),
    503,
  );
  assert.deepEqual(app.calls, []);
});

test("new creator IDs cannot shadow app routes while existing reserved handles remain editable", async () => {
  const blocked = fixture();
  await expectStatus(
    await blocked.handlePublicationRequest(request("PUT", { handle: "LOGIN", profile })),
    400,
  );
  assert.equal(
    blocked.calls.some((call) => call.method === "publish"),
    false,
  );
  const legacy = { ...existing, handle: "login" };
  const app = fixture({
    store: {
      read: async () => legacy,
      readPublic: async () => legacy,
      publish: async (_userId, handle, value) => ({ ...legacy, handle, profile: value }),
      unpublish: async () => ({ ...legacy, published: false }),
    },
  });
  const result = await expectStatus(
    await app.handlePublicationRequest(request("PUT", { handle: "login", profile })),
    200,
  );
  assert.equal(result.publication.handle, "login");
});
