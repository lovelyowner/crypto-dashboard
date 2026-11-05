import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readPublicAuthConfiguration } from "./public-settings.server";

const standard = {
  DATABASE_URL: "postgresql://127.0.0.1:1/production-sentinel",
  BETTER_AUTH_SECRET: "production-secret-sentinel-".repeat(2),
  BETTER_AUTH_URL: "https://production.example",
};
const preview = {
  PREVIEW_DATABASE_URL: "postgresql://127.0.0.1:1/preview-sentinel",
  PREVIEW_BETTER_AUTH_SECRET: "preview-secret-sentinel-".repeat(2),
  PREVIEW_BETTER_AUTH_URL: "https://preview.example",
};
const providerNames = ["google", "discord", "twitter", "github", "twitch"] as const;
const providerCredentials = Object.fromEntries(
  providerNames.flatMap((name) => [
    [`${name.toUpperCase()}_CLIENT_ID`, `${name}-client-sentinel`],
    [`${name.toUpperCase()}_CLIENT_SECRET`, `${name}-secret-sentinel`],
  ]),
);
const email = { RESEND_API_KEY: "email-secret-sentinel", AUTH_EMAIL_FROM: "account@example.com" };
const disabledProviders = Object.fromEntries(providerNames.map((name) => [name, false]));

test("public configuration exposes the complete hosted DTO without credential values", () => {
  const environment = {
    ...standard,
    ...providerCredentials,
    ...email,
    NODE_ENV: "production",
  };
  const configuration = readPublicAuthConfiguration(environment);
  assert.deepEqual(configuration, {
    configured: true,
    emailRecovery: true,
    passkeys: true,
    passkeyOrigin: standard.BETTER_AUTH_URL,
    providers: Object.fromEntries(providerNames.map((name) => [name, true])),
    production: true,
    setup: { environment: "production", database: true, secret: true, origin: true },
    signInOrigin: standard.BETTER_AUTH_URL,
  });
  const serialized = JSON.stringify(configuration);
  for (const [name, value] of Object.entries(environment)) {
    if (name.includes("SECRET") || name.includes("CLIENT_ID") || name.endsWith("DATABASE_URL"))
      assert.equal(serialized.includes(value), false);
  }
  assert.equal(serialized.includes(email.RESEND_API_KEY), false);
  assert.equal(serialized.includes(email.AUTH_EMAIL_FROM), false);
});

test("every incomplete preview reports setup presence and keeps account capabilities disabled", () => {
  const previewNames = Object.keys(preview) as (keyof typeof preview)[];
  for (let mask = 0; mask < 7; mask++) {
    const present = previewNames.map((_name, index) => Boolean(mask & (1 << index)));
    const selected = Object.fromEntries(
      previewNames.map((name, index) => [name, present[index] ? preview[name] : ""]),
    );
    assert.deepEqual(
      readPublicAuthConfiguration({
        ...standard,
        ...providerCredentials,
        ...email,
        ...selected,
        VERCEL: "1",
        VERCEL_ENV: "preview",
      }),
      {
        configured: false,
        emailRecovery: false,
        passkeys: false,
        passkeyOrigin: "http://localhost:8080",
        providers: disabledProviders,
        production: true,
        setup: {
          environment: "preview",
          database: present[0],
          secret: present[1],
          origin: present[2],
        },
      },
    );
  }
});

test("local OAuth origin guidance is present only for complete provider credentials", () => {
  const local = readPublicAuthConfiguration({});
  assert.equal(local.configured, true);
  assert.equal(local.passkeys, true);
  assert.equal(local.passkeyOrigin, "http://localhost:8080");
  assert.equal("signInOrigin" in local, false);
  assert.deepEqual(local.setup, {
    environment: "local",
    database: true,
    secret: true,
    origin: true,
  });
  const incomplete = readPublicAuthConfiguration({
    GOOGLE_CLIENT_ID: "client-only",
    GITHUB_CLIENT_SECRET: "secret-only",
    TWITCH_CLIENT_ID: "client",
    TWITCH_CLIENT_SECRET: "   ",
    ...email,
    AUTH_EMAIL_FROM: "   ",
  });
  assert.deepEqual(incomplete.providers, disabledProviders);
  assert.equal(incomplete.emailRecovery, false);
  assert.equal("signInOrigin" in incomplete, false);
  const social = readPublicAuthConfiguration(providerCredentials);
  assert.equal(social.signInOrigin, "http://localhost:8080");
  const unsafePasskeys = readPublicAuthConfiguration({ BETTER_AUTH_URL: "http://local.example" });
  assert.equal(unsafePasskeys.passkeys, false);
  assert.equal(unsafePasskeys.passkeyOrigin, "http://local.example");
});

test("hosted build checks cannot turn missing production credentials into a local account server", () => {
  const configuration = readPublicAuthConfiguration(providerCredentials, true);
  assert.equal(configuration.production, true);
  assert.equal(configuration.configured, false);
  assert.equal(configuration.passkeys, false);
  assert.deepEqual(configuration.providers, disabledProviders);
  assert.deepEqual(configuration.setup, {
    environment: "production",
    database: false,
    secret: false,
    origin: false,
  });
});

test("the actual Vercel config handler works with SDK and database imports forbidden", async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { Socket } from 'node:net';
    import { Readable } from 'node:stream';

    let networkCalls = 0;
    const rejectNetwork = () => {
      networkCalls++;
      throw new Error('Configuration discovery must not use the network');
    };
    globalThis.fetch = rejectNetwork;
    Socket.prototype.connect = rejectNetwork;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        assert.equal(/^(?:better-auth|@better-auth\\/[^/]+|pg|pg-pool|@electric-sql\\/pglite)(?:\\/|$)/.test(specifier), false, 'SDK/DB import: ' + specifier);
        const resolved = nextResolve(specifier, context);
        assert.equal(/\\/src\\/lib\\/(?:db|api\\.server|auth\\/(?:server|passkeys\\.server|pglite-dialect))\\.[cm]?[jt]s(?:$|[?])/.test(resolved.url), false, 'Server initialization import: ' + resolved.url);
        return resolved;
      },
    });
    const { default: handler } = await import('./api/[...path].ts');
    async function invoke(method = 'GET') {
      const request = Object.assign(Readable.from([]), {
        method,
        url: '/api/auth/config?next=profile',
        headers: {
          host: 'attacker.example',
          origin: 'https://attacker.example',
          'x-forwarded-host': 'attacker.example',
          'x-forwarded-proto': 'http',
        },
      });
      const headers = new Map();
      let output = '';
      const response = {
        statusCode: 0,
        headersSent: false,
        writableEnded: false,
        setHeader(name, value) { headers.set(name.toLowerCase(), value); },
        end(body) { output = body?.toString() ?? ''; this.writableEnded = true; },
      };
      await handler(request, response);
      assert.equal(headers.get('cache-control'), 'private, no-store');
      assert.equal(headers.get('x-content-type-options'), 'nosniff');
      assert.equal(headers.has('set-cookie'), false);
      for (const [name, value] of Object.entries(process.env)) {
        if (value && /(?:CLIENT_ID|SECRET|DATABASE_URL|RESEND_API_KEY|AUTH_EMAIL_FROM)$/.test(name))
          assert.equal(output.includes(value), false, 'Credential appeared in public response');
      }
      return { status: response.statusCode, headers, output };
    }
    const result = await invoke();
    assert.equal(result.status, 200);
    const configuration = JSON.parse(result.output);
    assert.deepEqual(configuration, {
      configured: true,
      emailRecovery: true,
      passkeys: true,
      passkeyOrigin: 'https://preview.example',
      providers: { google: true, discord: true, twitter: true, github: true, twitch: true },
      production: true,
      setup: { environment: 'preview', database: true, secret: true, origin: true },
      signInOrigin: 'https://preview.example',
    });
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
      const response = await invoke(method);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET');
      if (method === 'HEAD') assert.equal(response.output, '');
    }
    delete process.env.PREVIEW_BETTER_AUTH_SECRET;
    const incomplete = await invoke();
    assert.equal(incomplete.status, 200);
    const disabled = JSON.parse(incomplete.output);
    assert.equal(disabled.configured, false);
    assert.equal(disabled.emailRecovery, false);
    assert.equal(disabled.passkeys, false);
    assert.deepEqual(Object.values(disabled.providers), [false, false, false, false, false]);
    assert.deepEqual(disabled.setup, { environment: 'preview', database: true, secret: false, origin: true });
    assert.equal('signInOrigin' in disabled, false);
    assert.equal(networkCalls, 0);
  `;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      timeout: 20_000,
      env: {
        ...process.env,
        ...standard,
        ...preview,
        ...providerCredentials,
        ...email,
        NODE_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "preview",
      },
    },
  );
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});
