import assert from "node:assert/strict";
import test from "node:test";
import {
  readDeploymentStatus,
  parseDeploymentStatus,
  handleDeploymentStatusRequest,
} from "./deployment-status";
import { readAccountSetup } from "./auth/setup";
import { socialReturnError, socialReturnPath } from "./auth/social-return";
import { createAccountExportHandler } from "./account-export";
import { DEFAULT_CREATOR_PROFILE } from "./creator-profile";

test("preview metadata exposes only validated platform values and no production/local metadata", async () => {
  const env = {
    VERCEL: "1",
    VERCEL_ENV: "preview",
    VERCEL_BRANCH_URL: "app-git-preview-team.vercel.app",
    VERCEL_URL: "app-build-team.vercel.app",
    VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
    VERCEL_GIT_COMMIT_REF: "preview",
    DATABASE_URL: "not-public",
  };
  const value = readDeploymentStatus(env);
  assert.deepEqual(value, {
    preview: true,
    branchUrl: "https://app-git-preview-team.vercel.app",
    deploymentUrl: "https://app-build-team.vercel.app",
    commit: "a".repeat(40),
    branch: "preview",
  });
  assert.deepEqual(parseDeploymentStatus(value), value);
  for (const VERCEL_ENV of [undefined, "production", "development"])
    assert.deepEqual(readDeploymentStatus({ ...env, VERCEL_ENV }), { preview: false });
  const response = handleDeploymentStatusRequest(
    new Request("https://untrusted.example/api/deployment"),
    env,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), value);
  assert.equal(
    handleDeploymentStatusRequest(
      new Request("https://site.test/api/deployment", { method: "POST" }),
      env,
    ).status,
    405,
  );
});

test("preview link parsing rejects unsafe URLs, unknown data and malformed build metadata", () => {
  for (const branchUrl of [
    "http://app.vercel.app",
    "https://app.vercel.app.evil.test",
    "https://user:pass@app.vercel.app",
    "https://app.vercel.app/path",
    "https://app.vercel.app?token=secret",
    "https://app.vercel.app:443",
    " https://app.vercel.app",
    "javascript:alert(1)",
  ])
    assert.equal(parseDeploymentStatus({ preview: true, branchUrl }), null);
  assert.equal(parseDeploymentStatus({ preview: true, secret: "private" }), null);
  assert.equal(parseDeploymentStatus({ preview: true, commit: "not-a-sha" }), null);
  assert.equal(parseDeploymentStatus({ preview: false, branch: "main" }), null);
});

test("setup flags explain incomplete preview settings without reusing or disclosing production secrets", () => {
  const production = {
    DATABASE_URL: "private-production-database",
    BETTER_AUTH_SECRET: "p".repeat(32),
    BETTER_AUTH_URL: "https://production.example",
  };
  assert.deepEqual(readAccountSetup({ ...production, VERCEL: "1", VERCEL_ENV: "preview" }), {
    environment: "preview",
    database: false,
    secret: false,
    origin: false,
  });
  const partial = readAccountSetup({
    ...production,
    VERCEL: "1",
    PREVIEW_DATABASE_URL: "preview-db",
    PREVIEW_BETTER_AUTH_SECRET: "short",
    PREVIEW_BETTER_AUTH_URL: "https://preview.example/path",
  });
  assert.deepEqual(partial, {
    environment: "preview",
    database: true,
    secret: false,
    origin: false,
  });
  assert.deepEqual(readAccountSetup({ ...production, NODE_ENV: "production" }), {
    environment: "production",
    database: true,
    secret: true,
    origin: true,
  });
  assert.deepEqual(readAccountSetup({}), {
    environment: "local",
    database: true,
    secret: true,
    origin: true,
  });
  assert(!JSON.stringify(partial).includes("preview-db"));
});

test("social callback messages never echo provider text or unsafe return destinations", () => {
  assert.match(socialReturnError("access_denied")!, /cancelled/);
  assert.match(socialReturnError("account_not_linked")!, /existing method/);
  const secret = "<script>provider-secret</script>";
  assert(!socialReturnError(secret)!.includes(secret));
  assert.equal(socialReturnError(null), null);
  assert.equal(socialReturnPath("//evil.example"), "/login");
  assert.equal(socialReturnPath("/creator"), "/login?next=%2Fcreator");
});

const now = Date.now();
const session = {
  user: {
    id: "owner",
    email: "owner@example.com",
    name: "Owner",
    emailVerified: true,
    password: "private-password",
    accessToken: "private-token",
  },
  session: {
    userId: "owner",
    createdAt: new Date(now - 1000),
    expiresAt: new Date(now + 100_000),
    token: "private-session",
  },
};
const emptySource = { identities: [], draft: null, publication: null };

test("account exports require a matching fresh session before reading private data", async () => {
  let reads = 0;
  const request = new Request("https://app.test/api/account/export?userId=other");
  for (const [value, status] of [
    [null, 401],
    [{ ...session, session: { ...session.session, userId: "other" } }, 401],
    [{ ...session, session: { ...session.session, expiresAt: new Date(now - 1) } }, 401],
    [{ ...session, session: { ...session.session, createdAt: new Date(now - 601_000) } }, 403],
  ] as const) {
    const handler = createAccountExportHandler({
      configured: true,
      getSession: async () => value,
      read: async () => {
        reads++;
        return emptySource;
      },
      now: () => now,
    });
    const response = await handler(request);
    assert.equal(response.status, status);
    assert.match(response.headers.get("cache-control")!, /no-store/);
  }
  assert.equal(reads, 0);
});

test("account export is owner-scoped and whitelists data without secrets or anonymous contact fields", async () => {
  let readOwner = "";
  const handler = createAccountExportHandler({
    configured: true,
    getSession: async () => session,
    now: () => now,
    read: async (userId) => {
      readOwner = userId;
      return {
        identities: [
          {
            providerId: "github",
            accountId: "public-service-id",
            accessToken: "private-oauth",
            moderation_actor_id: "private-actor",
          },
        ],
        draft: {
          profile: {
            ...DEFAULT_CREATOR_PROFILE,
            displayName: "Private draft",
            privateKey: "private-key",
          },
          updatedAt: new Date(now),
        },
        publication: null,
      };
    },
  });
  const response = await handler(new Request("https://app.test/api/account/export?userId=other"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition")!, /attachment/);
  const raw = await response.text(),
    value = JSON.parse(raw);
  assert.equal(readOwner, "owner");
  assert.equal(value.account.id, "owner");
  assert.equal(value.profileDraft.profile.displayName, "Private draft");
  assert.equal(value.complete, false);
  assert.equal(value.scope, "account-profile");
  assert(raw.includes("Conversations and replies"));
  for (const secret of [
    "private-password",
    "private-token",
    "private-session",
    "private-oauth",
    "private-actor",
    "private-key",
  ])
    assert(!raw.includes(secret));
});

test("account export bounds linked identities and fails closed on invalid stored profiles", async () => {
  const handler = createAccountExportHandler({
    configured: true,
    getSession: async () => session,
    read: async () => ({
      ...emptySource,
      identities: Array.from({ length: 51 }, (_, n) => ({
        providerId: "github",
        accountId: String(n),
      })),
    }),
    now: () => now,
  });
  const value = await (await handler(new Request("https://app.test/api/account/export"))).json();
  assert.equal(value.linkedProviders.items.length, 50);
  assert.equal(value.linkedProviders.complete, false);
  const invalid = createAccountExportHandler({
    configured: true,
    getSession: async () => session,
    read: async () => ({ ...emptySource, draft: { profile: {}, updatedAt: new Date(now) } }),
    now: () => now,
  });
  assert.equal((await invalid(new Request("https://app.test/api/account/export"))).status, 503);
});
