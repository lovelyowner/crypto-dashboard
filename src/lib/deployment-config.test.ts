import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveDeploymentConfiguration } from "./deployment-config.ts";

const standard = {
  DATABASE_URL: "postgresql://127.0.0.1:1/production-sentinel",
  BETTER_AUTH_SECRET: "production-test-secret-".repeat(2),
  BETTER_AUTH_URL: "https://production.example",
};
const preview = {
  PREVIEW_DATABASE_URL: "postgresql://127.0.0.1:1/preview-sentinel",
  PREVIEW_BETTER_AUTH_SECRET: "isolated-preview-test-secret-".repeat(2),
  PREVIEW_BETTER_AUTH_URL: "https://preview.example",
};
const project = fileURLToPath(new URL("../../", import.meta.url));

test("production and local servers retain their normal credential selection", () => {
  for (const environment of [
    { ...standard, ...preview, VERCEL: "1", VERCEL_ENV: "production" },
    { ...standard, ...preview, NODE_ENV: "production" },
    { ...standard, ...preview, VERCEL_ENV: "preview" },
  ]) {
    const result = resolveDeploymentConfiguration(environment);
    assert.equal(result.preview, false);
    assert.equal(result.authConfigured, true);
    assert.equal(result.databaseUrl, standard.DATABASE_URL);
    assert.equal(result.authSecret, standard.BETTER_AUTH_SECRET);
    assert.equal(result.authOrigin, standard.BETTER_AUTH_URL);
  }
  assert.deepEqual(resolveDeploymentConfiguration({}), {
    production: false,
    preview: false,
    authConfigured: true,
    databaseUrl: undefined,
    authSecret: undefined,
    authOrigin: null,
  });
  const local = resolveDeploymentConfiguration({
    ...standard,
    BETTER_AUTH_URL: "http://localhost:8080",
  });
  assert.equal(local.authOrigin, "http://localhost:8080");
  assert.equal(local.authConfigured, true);
  assert.equal(
    resolveDeploymentConfiguration({ ...standard, BETTER_AUTH_URL: "http://localhost:8080" }, true)
      .authConfigured,
    false,
  );
});

test("every non-production Vercel environment ignores generic production credentials", () => {
  for (const VERCEL_ENV of [undefined, "", "preview", "development", "custom-staging"]) {
    const result = resolveDeploymentConfiguration({ ...standard, VERCEL: "1", VERCEL_ENV });
    assert.deepEqual(result, {
      production: true,
      preview: true,
      authConfigured: false,
      databaseUrl: undefined,
      authSecret: undefined,
      authOrigin: null,
    });
  }
});

test("preview database access and migrations require the entire isolated credential set", () => {
  for (const name of Object.keys(preview)) {
    const environment: Record<string, string> = {
      ...standard,
      ...preview,
      VERCEL: "1",
      VERCEL_ENV: "preview",
      [name]: "",
    };
    const result = resolveDeploymentConfiguration(environment);
    assert.equal(result.authConfigured, false, `${name} is required`);
    assert.equal(result.databaseUrl, undefined);
    assert.equal(result.authSecret, undefined);
    assert.equal(result.authOrigin, null);
  }
  for (const invalid of [
    "http://preview.example",
    "https://preview.example/login",
    "https://user:password@preview.example",
    "https://preview.example?query=1",
    "https://preview.example#fragment",
    "invalid-url",
  ]) {
    assert.equal(
      resolveDeploymentConfiguration({
        ...standard,
        ...preview,
        VERCEL: "1",
        VERCEL_ENV: "preview",
        PREVIEW_BETTER_AUTH_URL: invalid,
      }).databaseUrl,
      undefined,
    );
  }
  assert.equal(
    resolveDeploymentConfiguration({
      ...standard,
      ...preview,
      VERCEL: "1",
      PREVIEW_BETTER_AUTH_SECRET: "too short",
    }).databaseUrl,
    undefined,
  );
});

test("a complete preview uses only its explicit database, secret and exact HTTPS origin", () => {
  const result = resolveDeploymentConfiguration({
    ...standard,
    ...preview,
    VERCEL: "1",
    VERCEL_ENV: "preview",
    PREVIEW_BETTER_AUTH_URL: " https://preview.example/ ",
  });
  assert.equal(result.authConfigured, true);
  assert.equal(result.databaseUrl, preview.PREVIEW_DATABASE_URL);
  assert.equal(result.authSecret, preview.PREVIEW_BETTER_AUTH_SECRET);
  assert.equal(result.authOrigin, preview.PREVIEW_BETTER_AUTH_URL);
  assert.equal(result.preview, true);
  assert.equal(result.production, true, "previews still require HTTPS and secure server cookies");
});

function child(script: string, environment: Record<string, string | undefined>, tsx = false) {
  const result = spawnSync(
    process.execPath,
    [...(tsx ? ["--import", "tsx"] : []), "--input-type=module", "-e", script],
    {
      cwd: project,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        NODE_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "preview",
        ...standard,
        PREVIEW_DATABASE_URL: "",
        PREVIEW_BETTER_AUTH_SECRET: "",
        PREVIEW_BETTER_AUTH_URL: "",
        ...environment,
      },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.includes(standard.BETTER_AUTH_SECRET), false);
  assert.equal(result.stderr.includes(standard.BETTER_AUTH_SECRET), false);
  return result;
}

test("the actual Node 24 migrator skips incomplete previews without constructing a PostgreSQL pool", () => {
  for (const environment of [
    {},
    { ...preview, PREVIEW_BETTER_AUTH_SECRET: "" },
    { ...preview, PREVIEW_BETTER_AUTH_URL: "http://preview.example" },
    { VERCEL_ENV: undefined },
  ]) {
    const result = child(
      `
      const pg = (await import("pg")).default;
      pg.Pool = class { constructor() { throw new Error("DATABASE_MUST_NOT_BE_OPENED"); } };
      await import("./scripts/migrate.mjs");
    `,
      environment,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /skipping isolated preview migrations/);
    assert.equal(result.stderr.includes("DATABASE_MUST_NOT_BE_OPENED"), false);
  }
});

test("the actual migrator selects preview and production databases consistently with runtime", () => {
  for (const environment of [
    { ...preview, EXPECTED_TEST_DATABASE_URL: preview.PREVIEW_DATABASE_URL },
    { ...preview, VERCEL_ENV: "production", EXPECTED_TEST_DATABASE_URL: standard.DATABASE_URL },
  ]) {
    const result = child(
      `
      const pg = (await import("pg")).default;
      pg.Pool = class { constructor(options) {
        if (options.connectionString !== process.env.EXPECTED_TEST_DATABASE_URL) throw new Error("WRONG_DATABASE_SELECTED");
        throw new Error("EXPECTED_DATABASE_SELECTED_WITHOUT_NETWORK");
      } };
      await import("./scripts/migrate.mjs");
    `,
      environment,
    );
    assert.equal(result.status, 1, "the stub intentionally stops before opening a database");
    assert.match(result.stderr, /EXPECTED_DATABASE_SELECTED_WITHOUT_NETWORK/);
    assert.equal(result.stderr.includes("WRONG_DATABASE_SELECTED"), false);
  }
});

test("incomplete Vercel preview runtime cannot access generic database, auth secret or API origin", () => {
  const result = child(
    `
    import assert from "node:assert/strict";
    import { Readable } from "node:stream";
    const pg = (await import("pg")).default;
    pg.Pool = class { constructor() { throw new Error("DATABASE_MUST_NOT_BE_OPENED"); } };
    const auth = await import("./src/lib/auth/server.ts");
    assert.equal(auth.authConfigured, false);
    assert.equal(auth.authOrigin, null);
    assert.notEqual(auth.getAuthEncryptionSecret(), process.env.BETTER_AUTH_SECRET);
    const db = await import("./src/lib/db.ts");
    await assert.rejects(db.getSql(), /required for production account storage/);
    const { handleApiRequest } = await import("./src/lib/api.server.ts");
    for (const path of ["/api/auth/get-session", "/api/profile", "/api/profile/publication", "/api/profile/contact", "/api/profile/payments", "/api/moderation/access"]) {
      const response = await handleApiRequest(new Request("https://preview.example" + path));
      assert.equal(response.status, 503, path);
    }
    const { createNodeApiHandler } = await import("./src/lib/node-api.ts");
    let fixedOrigin;
    const request = Object.assign(Readable.from([]), { url: "/api/auth/config", method: "GET", headers: { host: "production.example" } });
    const response = { setHeader() {}, end() {}, statusCode: 0 };
    await createNodeApiHandler(async request => { fixedOrigin = new URL(request.url).origin; return Response.json({}); })(request, response);
    assert.equal(fixedOrigin, "https://unconfigured.invalid");
    console.log("ISOLATED_RUNTIME_OK");
  `,
    {},
    true,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ISOLATED_RUNTIME_OK/);
});

test("configured preview wrappers accept only the selected preview origin and use its secret/database", () => {
  const result = child(
    `
    import assert from "node:assert/strict";
    import { Readable } from "node:stream";
    const pg = (await import("pg")).default;
    const RealPool = pg.Pool;
    RealPool.prototype.connect = function () { throw new Error("NO_DATABASE_NETWORK_ALLOWED"); };
    const auth = await import("./src/lib/auth/server.ts");
    assert.equal(auth.authConfigured, true);
    assert.equal(auth.authOrigin, "https://preview.example");
    assert.equal(auth.getAuthEncryptionSecret(), process.env.PREVIEW_BETTER_AUTH_SECRET);
    assert.equal(auth.auth.options.database.options.connectionString, process.env.PREVIEW_DATABASE_URL);
    const { handleApiRequest } = await import("./src/lib/api.server.ts");
    for (const path of ["/api/profile", "/api/profile/publication", "/api/profile/contact", "/api/profile/payments", "/api/inbox/test-thread/moderation"]) {
      const wrong = await handleApiRequest(new Request("https://preview.example" + path, { method: "PUT", headers: { origin: "https://production.example", "content-type": "application/json" }, body: "{}" }));
      assert.equal(wrong.status, 403, path);
      const right = await handleApiRequest(new Request("https://preview.example" + path, { method: "PUT", headers: { origin: "https://preview.example", "content-type": "application/json" }, body: "{}" }));
      assert.equal(right.status, 401, path);
    }
    const { createNodeApiHandler } = await import("./src/lib/node-api.ts");
    let fixedOrigin;
    const request = Object.assign(Readable.from([]), { url: "/api/auth/config", method: "GET", headers: { host: "production.example" } });
    await createNodeApiHandler(async request => { fixedOrigin = new URL(request.url).origin; return Response.json({}); })(request, { setHeader() {}, end() {}, statusCode: 0 });
    assert.equal(fixedOrigin, "https://preview.example");
    console.log("CONFIGURED_PREVIEW_RUNTIME_OK");
  `,
    preview,
    true,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CONFIGURED_PREVIEW_RUNTIME_OK/);
});
