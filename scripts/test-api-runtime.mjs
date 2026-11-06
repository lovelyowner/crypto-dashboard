import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { registerHooks } from "node:module";
import { Socket } from "node:net";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const filename = fileURLToPath(import.meta.url);
const providers = ["google", "discord", "twitter", "github", "twitch"];

async function childChecks(entryURL, scenario) {
  assert.equal(
    process.execArgv.some((arg) => /tsx|loader|--import/.test(arg)),
    false,
  );
  let networkCalls = 0;
  const rejectNetwork = () => {
    networkCalls++;
    throw new Error("Runtime fixture must not contact a database or provider.");
  };
  globalThis.fetch = rejectNetwork;
  Socket.prototype.connect = rejectNetwork;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      assert.equal(
        /^(?:better-auth|@better-auth\/[^/]+|pg|pg-pool|@electric-sql\/pglite)(?:\/|$)/.test(
          specifier,
        ),
        false,
        "Configuration must not import the auth SDK or storage",
      );
      assert.equal(specifier.startsWith("@/"), false, "Plain Node cannot resolve Vite aliases");
      return nextResolve(specifier, context);
    },
  });
  const { default: handleApi } = await import(entryURL);
  async function invoke(path, method = "GET") {
    const request = Object.assign(Readable.from([]), {
      method,
      url: path,
      headers: {
        host: "attacker.invalid",
        origin: "https://attacker.invalid",
        "x-forwarded-host": "attacker.invalid",
        "x-forwarded-proto": "http",
      },
    });
    const headers = new Map();
    let body = "";
    const response = {
      statusCode: 0,
      headersSent: false,
      writableEnded: false,
      setHeader(name, value) {
        headers.set(name.toLowerCase(), value);
      },
      end(value) {
        body = value?.toString() ?? "";
        this.writableEnded = true;
      },
    };
    await handleApi(request, response);
    assert.match(headers.get("cache-control"), /no-store/);
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.equal(headers.has("set-cookie"), false);
    for (const [name, value] of Object.entries(process.env))
      if (value && /(?:CLIENT_ID|SECRET|DATABASE_URL|RESEND_API_KEY|AUTH_EMAIL_FROM)$/.test(name))
        assert.equal(
          body.includes(value),
          false,
          "Public fixture responses must not leak credentials",
        );
    return { status: response.statusCode, headers, body, json: body ? JSON.parse(body) : null };
  }
  const result = await invoke("/api/auth/config");
  assert.equal(result.status, 200);
  assert.match(result.headers.get("content-type"), /^application\/json/);
  const configured = scenario === "complete-preview";
  assert.equal(result.json.configured, configured);
  assert.equal(result.json.production, true);
  assert.equal(result.json.passkeys, configured);
  assert.deepEqual(
    result.json.providers,
    Object.fromEntries(providers.map((id) => [id, configured && id === "google"])),
  );
  assert.equal(result.json.setup.environment, scenario === "production" ? "production" : "preview");
  if (configured) {
    assert.equal(result.json.signInOrigin, "https://preview.example");
    assert.equal(result.json.passkeyOrigin, "https://preview.example");
  } else {
    assert.equal("signInOrigin" in result.json, false);
    assert.equal(result.json.setup.database, false);
    assert.equal(result.json.setup.secret, false);
    assert.equal(result.json.setup.origin, false);
  }
  const refused = await invoke("/api/auth/config", "POST");
  assert.equal(refused.status, 405);
  assert.equal(refused.headers.get("allow"), "GET");
  assert.equal(networkCalls, 0);
  hook.deregister();
  if (!configured) {
    const deployment = await invoke("/api/deployment");
    assert.equal(deployment.status, 200);
    assert.deepEqual(deployment.json, { preview: scenario !== "production" });
    for (const path of ["/api/auth/get-session", "/api/profile", "/api/account/export"]) {
      const response = await invoke(path);
      assert.equal(response.status, 503, path);
      assert.equal(typeof response.json.message, "string");
    }
  }
  assert.equal(networkCalls, 0);
}

if (process.argv[2] === "--child") {
  await childChecks(process.argv[3], process.argv[4]);
} else {
  const { compileApiRuntime } = await import("./api-runtime.mjs");
  const runtime = await compileApiRuntime();
  try {
    for (const scenario of ["production", "incomplete-preview", "complete-preview"]) {
      const environment = { ...process.env };
      for (const name of Object.keys(environment))
        if (
          /^(?:(?:PREVIEW_)?(?:DATABASE_URL|BETTER_AUTH_SECRET|BETTER_AUTH_URL)|(?:GOOGLE|DISCORD|TWITTER|GITHUB|TWITCH)_CLIENT_(?:ID|SECRET)|RESEND_API_KEY|AUTH_EMAIL_FROM|VERCEL(?:_|$)|PGLITE_DATA_DIR)/.test(
            name,
          )
        )
          delete environment[name];
      Object.assign(environment, {
        NODE_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: scenario === "production" ? "production" : "preview",
      });
      if (scenario !== "production")
        Object.assign(environment, {
          DATABASE_URL: "postgresql://127.0.0.1:1/production-sentinel",
          BETTER_AUTH_SECRET: "production-fixture-only-secret-".repeat(2),
          BETTER_AUTH_URL: "https://production.example",
          GOOGLE_CLIENT_ID: "google-fixture-only-client",
          GOOGLE_CLIENT_SECRET: "google-fixture-only-secret",
        });
      if (scenario === "complete-preview")
        Object.assign(environment, {
          PREVIEW_DATABASE_URL: "postgresql://127.0.0.1:1/preview-sentinel",
          PREVIEW_BETTER_AUTH_SECRET: "preview-fixture-only-secret-".repeat(2),
          PREVIEW_BETTER_AUTH_URL: "https://preview.example",
        });
      await promisify(execFile)(
        process.execPath,
        [filename, "--child", runtime.entryURL, scenario],
        { env: environment, timeout: 20_000 },
      );
      console.log(`PASS emitted API runs with plain Node: ${scenario}`);
    }
  } finally {
    await runtime.cleanup();
  }
}
