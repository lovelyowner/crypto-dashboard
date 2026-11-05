import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_CONFIGURATION_ERROR,
  loadPublicAuthConfiguration,
  parsePublicAuthConfiguration,
} from "./public-configuration";

const valid = {
  configured: true,
  emailRecovery: true,
  production: true,
  providers: { google: true, discord: false, twitter: true, github: false, twitch: false },
  passkeys: true,
  passkeyOrigin: "https://accounts.example/",
};
const json = (value: unknown) => Response.json(value);
const load = (response: Response) => loadPublicAuthConfiguration({ fetcher: async () => response });

test("public auth configuration selects implemented flags without copying arbitrary response fields", () => {
  const parsed = parsePublicAuthConfiguration({
    ...valid,
    providers: { ...valid.providers, bluesky: true, unknown: "untrusted" },
    unrecognized: "must not persist",
  });
  assert.deepEqual(parsed, { ...valid, passkeyOrigin: "https://accounts.example" });
  assert.equal("unrecognized" in parsed, false);
  assert.equal("bluesky" in parsed.providers, false);
});

test("unconfigured and older servers cannot accidentally enable missing capabilities", () => {
  const parsed = parsePublicAuthConfiguration({
    ...valid,
    configured: false,
    passkeyOrigin: "http://localhost:8080",
    providers: { google: true, discord: false, twitter: true },
  });
  assert.equal(parsed.configured, false);
  assert.equal(parsed.emailRecovery, false);
  assert.equal(parsed.passkeys, false);
  assert.equal(parsed.passkeyOrigin, undefined);
  assert.deepEqual(Object.values(parsed.providers), [false, false, false, false, false]);
  const older = parsePublicAuthConfiguration({
    configured: true,
    emailRecovery: false,
    production: false,
    providers: { google: true },
  });
  assert.equal(older.providers.github, false);
  assert.equal(older.passkeys, false);
});

test("malformed schemas fail closed rather than remaining in loading or accepting truthy flags", () => {
  for (const value of [
    null,
    [],
    {},
    { ...valid, configured: "true" },
    { ...valid, emailRecovery: 1 },
    { ...valid, production: null },
    { ...valid, providers: [] },
    { ...valid, providers: { google: "true" } },
    { ...valid, providers: { github: 1 } },
    { ...valid, passkeys: "false" },
    { ...valid, passkeyOrigin: "https://accounts.example/path" },
  ]) {
    assert.throws(() => parsePublicAuthConfiguration(value), { message: AUTH_CONFIGURATION_ERROR });
  }
});

test("configuration requests use same-origin credentials, no cache and no followed redirects", async () => {
  let calls = 0;
  const result = await loadPublicAuthConfiguration({
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, "/api/auth/config");
      assert.equal(options?.credentials, "same-origin");
      assert.equal(options?.cache, "no-store");
      assert.equal(options?.redirect, "error");
      assert.ok(options?.signal instanceof AbortSignal);
      return new Response(JSON.stringify(valid), {
        headers: { "content-type": "Application/JSON; charset=utf-8" },
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.providers.google, true);
});

test("HTTP, HTML, invalid JSON, oversized JSON and schema failures give one retryable error", async () => {
  for (const response of [
    new Response("sensitive upstream detail", { status: 503 }),
    new Response("<html>Deployment protection</html>", {
      headers: { "content-type": "text/html" },
    }),
    new Response("{broken", { headers: { "content-type": "application/json" } }),
    json({ ...valid, padding: "x".repeat(65_536) }),
    json({ ...valid, providers: { google: "true" } }),
  ])
    await assert.rejects(load(response), { message: AUTH_CONFIGURATION_ERROR });
  const afterFailure = await load(json(valid));
  assert.equal(afterFailure.configured, true);
});

test("a transport ignoring cancellation still times out and receives an abort signal", async () => {
  let signal: AbortSignal | null | undefined;
  await assert.rejects(
    loadPublicAuthConfiguration({
      timeoutMs: 20,
      fetcher: async (_url, options) => {
        signal = options?.signal;
        return new Promise<Response>(() => {});
      },
    }),
    { message: AUTH_CONFIGURATION_ERROR },
  );
  assert.equal(signal?.aborted, true);
});

test("the same deadline includes stalled response bodies", async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
  });
  try {
    await assert.rejects(
      loadPublicAuthConfiguration({
        timeoutMs: 20,
        fetcher: async () =>
          new Response(body, { headers: { "content-type": "application/json" } }),
      }),
      { message: AUTH_CONFIGURATION_ERROR },
    );
  } finally {
    stream?.close();
  }
});

test("unmount cancellation stops pending work and an already cancelled load never requests", async () => {
  const controller = new AbortController();
  let calls = 0;
  const request = loadPublicAuthConfiguration({
    signal: controller.signal,
    fetcher: async () => {
      calls++;
      return new Promise<Response>(() => {});
    },
  });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  await assert.rejects(
    loadPublicAuthConfiguration({
      signal: controller.signal,
      fetcher: async () => {
        calls++;
        return json(valid);
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});
