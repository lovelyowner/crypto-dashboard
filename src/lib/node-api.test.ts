import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  createNodeApiHandler,
  MAX_API_BODY_BYTES,
  type NodeApiRequest,
  type ApiDispatcher,
} from "./node-api.ts";

interface TestRequest {
  url?: string;
  method?: string;
  headers?: IncomingHttpHeaders;
  body?: unknown;
  chunks?: (string | Buffer)[];
}

async function invoke(
  dispatch: ApiDispatcher,
  input: TestRequest = {},
  baseUrl = "https://fathom.example",
) {
  const request = Object.assign(Readable.from(input.chunks ?? []), {
    method: input.method ?? "GET",
    url: input.url ?? "/api/auth/config?next=profile",
    headers: input.headers ?? {},
    ...(Object.hasOwn(input, "body") ? { body: input.body } : {}),
  }) as NodeApiRequest;
  const headers = new Map<string, string | string[]>();
  let output = "";
  const response = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: string | string[]) {
      headers.set(name.toLowerCase(), value);
    },
    end(body?: Buffer | string) {
      output = body?.toString() ?? "";
      this.writableEnded = true;
    },
  };
  await createNodeApiHandler(dispatch, { baseUrl })(request, response as unknown as ServerResponse);
  return { status: response.statusCode, headers, output };
}

test("Node adapter preserves path, query, cookies, and CSRF Origin while fixing security origin", async () => {
  const result = await invoke(
    async (request) => {
      assert.equal(request.url, "https://fathom.example/api/auth/config?next=profile");
      assert.equal(request.headers.get("host"), "fathom.example");
      assert.equal(request.headers.get("x-forwarded-host"), "fathom.example");
      assert.equal(request.headers.get("x-forwarded-proto"), "https");
      assert.equal(request.headers.get("origin"), "https://other.example");
      assert.equal(request.headers.get("cookie"), "session=one; policy=two");
      return Response.json({ configured: true });
    },
    {
      headers: {
        host: "attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
        origin: "https://other.example",
        cookie: "session=one; policy=two",
      },
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "private, no-store");
});

test("Node adapter handles streaming, Vercel JSON, text, and binary bodies", async () => {
  for (const input of [
    { chunks: ['{"profile":', "null}"] },
    { body: { profile: null } },
    { body: '{"profile":null}' },
    { body: Buffer.from('{"profile":null}') },
    { body: new Uint8Array(Buffer.from('{"profile":null}')) },
  ]) {
    const result = await invoke(
      async (request) => {
        assert.deepEqual(await request.json(), { profile: null });
        assert.equal(request.method, "PUT");
        return new Response(null, { status: 204 });
      },
      {
        method: "PUT",
        url: "/api/profile",
        headers: { "content-type": "application/json" },
        ...input,
      },
    );
    assert.equal(result.status, 204);
  }
});

test("Node adapter bounds declared, streamed, parsed, and multibyte request bytes before dispatch", async () => {
  let dispatched = false;
  const dispatch = async () => {
    dispatched = true;
    return new Response("unexpected");
  };
  for (const input of [
    { headers: { "content-length": String(MAX_API_BODY_BYTES + 1) } },
    { chunks: [Buffer.alloc(MAX_API_BODY_BYTES), "x"] },
    { body: { text: "x".repeat(MAX_API_BODY_BYTES) } },
    { body: "🪐".repeat(MAX_API_BODY_BYTES / 2) },
  ]) {
    const result = await invoke(dispatch, { method: "POST", ...input });
    assert.equal(result.status, 413);
  }
  assert.equal(dispatched, false);
});

test("Node adapter keeps each Set-Cookie header including Expires commas", async () => {
  const result = await invoke(async () => {
    const headers = new Headers({ Location: "/?linked=1" });
    headers.append(
      "Set-Cookie",
      "session=abc; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
    );
    headers.append("Set-Cookie", "policy=; Path=/; HttpOnly; Max-Age=0");
    return new Response(null, { status: 302, headers });
  });
  assert.equal(result.status, 302);
  assert.deepEqual(result.headers.get("set-cookie"), [
    "session=abc; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
    "policy=; Path=/; HttpOnly; Max-Age=0",
  ]);
  assert.equal(result.headers.get("location"), "/?linked=1");
});

test("Node adapter rejects absolute, protocol-relative, backslash, and non-API targets", async () => {
  for (const url of [
    "https://evil.example/api/auth/config",
    "//evil.example/api/auth/config",
    "/\\evil.example/api/auth/config",
    "/profile",
  ]) {
    const result = await invoke(
      async () => {
        throw new Error("dispatch must not run");
      },
      { url },
    );
    assert.equal(result.status, url === "/profile" ? 404 : 400);
  }
});

test("Node adapter fails safely without exposing exceptions or invalid configuration", async () => {
  for (const baseUrl of [
    "https://fathom.example",
    "invalid-url",
    "https://user:private-secret@fathom.example",
  ]) {
    const result = await invoke(
      async () => {
        throw new Error("database-password-secret");
      },
      {},
      baseUrl,
    );
    assert.equal(result.status, 503);
    assert.equal(result.output.includes("secret"), false);
    assert.equal(result.output.includes("database"), false);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
  }
});

test("Node adapter preserves HEAD response metadata without returning a body", async () => {
  const result = await invoke(
    async () => new Response("sensitive body", { headers: { "x-test": "present" } }),
    { method: "HEAD" },
  );
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("x-test"), "present");
  assert.equal(result.output, "");
});
