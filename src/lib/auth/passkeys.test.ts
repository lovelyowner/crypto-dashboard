import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { chromium, type BrowserContext } from "playwright";
import {
  accountPasskeys,
  accountTwoFactor,
  passkeyConfiguration,
  passkeyPolicyPlugin,
} from "./passkeys.server.ts";
import { sessionDurationPlugin } from "./session-duration.ts";
import { ACCOUNT_SESSION_POLICY, SESSION_DURATION_HEADER } from "./policy.ts";

// Uses a disposable local HTTP server and Chromium's virtual authenticator.
// CHROMIUM_PATH selects a browser; /usr/bin/chromium and Playwright's bundled
// browser are fallbacks. This does not test real platform authenticators.

test("passkey RP configuration is fixed to its secure configured origin", () => {
  assert.deepEqual(passkeyConfiguration("https://accounts.example.com"), {
    enabled: true,
    rpID: "accounts.example.com",
    origin: ["https://accounts.example.com"],
  });
  assert.equal(passkeyConfiguration("http://localhost:8080").enabled, true);
  assert.equal(passkeyConfiguration("http://accounts.example.com").enabled, false);
});

function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret].map((ch) => alphabet.indexOf(ch).toString(2).padStart(5, "0")).join("");
  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((part) => parseInt(part, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", bytes).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1)! & 15) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}

test(
  "real HTTP WebAuthn ceremonies enforce UV, origin, challenge use, owner scope, freshness, duration and TOTP",
  { timeout: 90_000 },
  async () => {
    const database: Record<string, Record<string, unknown>[]> = {
      user: [],
      session: [],
      account: [],
      verification: [],
      twoFactor: [],
      passkey: [],
    };
    const server = createServer(async (incoming, outgoing) => {
      try {
        if (!incoming.url?.startsWith("/api/auth/")) {
          outgoing
            .writeHead(200, { "content-type": "text/html" })
            .end("<!doctype html><title>WebAuthn fixture</title>");
          return;
        }
        const chunks = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers))
          if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        const response = await handler(
          new Request(`${origin}${incoming.url}`, {
            method: incoming.method,
            headers,
            ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          }),
        );
        outgoing.statusCode = response.status;
        for (const [key, value] of response.headers)
          if (key !== "set-cookie") outgoing.setHeader(key, value);
        outgoing.setHeader("set-cookie", response.headers.getSetCookie());
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        outgoing.writeHead(500).end();
      }
    });
    server.listen(0);
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://localhost:${address.port}`;
    const auth = betterAuth({
      database: memoryAdapter(database),
      baseURL: origin,
      trustedOrigins: [origin],
      secret: randomBytes(32).toString("hex"),
      emailAndPassword: { enabled: true },
      session: ACCOUNT_SESSION_POLICY,
      telemetry: { enabled: false },
      advanced: { cookiePrefix: "fathom", useSecureCookies: false },
      plugins: [
        accountPasskeys(origin),
        passkeyPolicyPlugin(origin),
        accountTwoFactor(),
        sessionDurationPlugin(),
      ],
    });
    const handler = auth.handler;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        executablePath:
          process.env.CHROMIUM_PATH ||
          (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : chromium.executablePath()),
        args: ["--no-sandbox"],
      });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(origin);
      const cdp = await context.newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      async function request(
        path: string,
        body?: Record<string, unknown>,
        duration = "1h",
        client: BrowserContext = context,
        extra: Record<string, string> = {},
      ) {
        const response = await client.request.fetch(`${origin}/api/auth${path}`, {
          method: body ? "POST" : "GET",
          headers: { origin, [SESSION_DURATION_HEADER]: duration, ...extra },
          ...(body ? { data: body } : {}),
        });
        return {
          status: response.status(),
          body: await response.text().then((text) => (text ? JSON.parse(text) : null)),
          cookies: response
            .headersArray()
            .filter((header) => header.name.toLowerCase() === "set-cookie")
            .map((header) => header.value),
        };
      }
      async function credential(kind: "create" | "get", options: Record<string, unknown>) {
        // Browser-native JSON conversion preserves the signed authenticator data.
        return page.evaluate(
          async ({ kind, options }) => {
            const publicKey =
              kind === "create"
                ? PublicKeyCredential.parseCreationOptionsFromJSON(
                    options as unknown as PublicKeyCredentialCreationOptionsJSON,
                  )
                : PublicKeyCredential.parseRequestOptionsFromJSON(
                    options as unknown as PublicKeyCredentialRequestOptionsJSON,
                  );
            const credential = (await navigator.credentials[kind]({
              publicKey,
            } as CredentialCreationOptions & CredentialRequestOptions)) as PublicKeyCredential;
            return credential.toJSON();
          },
          { kind, options },
        );
      }
      const password = randomBytes(24).toString("hex");
      const signup = await request("/sign-up/email", {
        email: "passkeys@example.com",
        password,
        name: "Passkey fixture",
      });
      assert.equal(signup.status, 200);
      const userId = signup.body.user.id;
      const generated = await request("/passkey/generate-register-options");
      assert.equal(generated.status, 200);
      assert.equal(generated.body.rp.id, "localhost");
      assert.equal(generated.body.authenticatorSelection.residentKey, "required");
      assert.equal(generated.body.authenticatorSelection.userVerification, "required");
      const registration = await credential("create", generated.body);
      const registered = await request("/passkey/verify-registration", {
        response: registration,
        name: "Virtual device",
      });
      assert.equal(registered.status, 200);
      const keyId = registered.body.id;
      assert.equal(database.passkey.length, 1);
      assert.equal(
        (await request("/passkey/verify-registration", { response: registration })).status,
        400,
        "registration challenge is single use",
      );
      const listed = await request("/passkey/list-user-passkeys");
      assert.equal(listed.body.length, 1);
      assert.equal(
        (await request("/passkey/update-passkey", { id: keyId, name: "Renamed device" })).status,
        200,
      );
      assert.equal(
        (await request("/passkey/update-passkey", { id: keyId, name: "x".repeat(81) })).status,
        400,
      );
      const other = await browser.newContext();
      await request(
        "/sign-up/email",
        { email: "other-passkeys@example.com", password, name: "Other owner" },
        "1h",
        other,
      );
      assert.deepEqual(
        (await request("/passkey/list-user-passkeys", undefined, "1h", other)).body,
        [],
      );
      assert.ok(
        [401, 403].includes(
          (await request("/passkey/delete-passkey", { id: keyId }, "1h", other)).status,
        ),
      );
      assert.ok(
        [401, 403].includes(
          (await request("/passkey/update-passkey", { id: keyId, name: "Stolen" }, "1h", other))
            .status,
        ),
      );
      await other.close();
      const currentSession = database.session.find((row) => row.userId === userId)!;
      const createdAt = currentSession.createdAt;
      currentSession.createdAt = new Date(Date.now() - 11 * 60_000);
      assert.equal((await request("/passkey/generate-register-options")).status, 403);
      assert.equal((await request("/passkey/delete-passkey", { id: keyId })).status, 403);
      currentSession.createdAt = createdAt;
      await request("/sign-out", {});
      async function assertion() {
        const generated = await request("/passkey/generate-authenticate-options");
        assert.equal(generated.body.userVerification, "required");
        return credential("get", generated.body);
      }
      const otherOrigin = createServer((_request, response) =>
        response.end("<!doctype html><title>Other origin</title>"),
      );
      otherOrigin.listen(0);
      await once(otherOrigin, "listening");
      try {
        const address = otherOrigin.address();
        assert.ok(address && typeof address === "object");
        const options = await request("/passkey/generate-authenticate-options");
        await page.goto(`http://localhost:${address.port}`);
        const wrongOriginResponse = await credential("get", options.body);
        const rejected = await request("/passkey/verify-authentication", {
          response: wrongOriginResponse,
        });
        assert.equal(
          rejected.status,
          400,
          "a real signed assertion from another origin is rejected even when the RP host and HTTP Origin header match",
        );
        assert.equal((await request("/get-session")).body, null);
      } finally {
        await page.goto(origin);
        otherOrigin.closeAllConnections();
        await new Promise<void>((resolve) => otherOrigin.close(() => resolve()));
      }
      let response = await assertion();
      assert.equal(
        (
          await request("/passkey/verify-authentication", { response }, "1h", context, {
            origin: "https://attacker.example",
          })
        ).status,
        403,
      );
      const signedIn = await request(
        "/passkey/verify-authentication",
        { response },
        "1h",
        context,
        { "x-fathom-remember-me": "true" },
      );
      assert.equal(signedIn.status, 200);
      assert.equal(signedIn.body.user.id, userId);
      assert.match(
        signedIn.cookies
          .slice()
          .reverse()
          .find((line) => line.startsWith("fathom.session_token="))!,
        /Max-Age=(?:35\d\d|3600)/i,
      );
      assert.equal(
        (await request("/passkey/verify-authentication", { response })).status,
        400,
        "authentication challenge is single use",
      );
      await request("/sign-out", {});
      response = await assertion();
      for (const row of database.verification)
        if (String(row.value).includes('"type":"authentication"'))
          row.expiresAt = new Date(Date.now() - 1000);
      assert.equal(
        (await request("/passkey/verify-authentication", { response })).status,
        400,
        "expired challenge cannot authenticate",
      );
      const uvOptions = await request("/passkey/generate-authenticate-options");
      await cdp.send("WebAuthn.setResponseOverrideBits", { authenticatorId, isBadUV: true });
      response = await credential("get", { ...uvOptions.body, userVerification: "preferred" });
      assert.equal(
        (await request("/passkey/verify-authentication", { response })).status,
        403,
        "signed UV flag is required, even if a client weakens options",
      );
      await cdp.send("WebAuthn.setResponseOverrideBits", { authenticatorId });
      response = await assertion();
      assert.equal(
        (await request("/passkey/verify-authentication", { response }, "365d")).status,
        400,
      );
      assert.equal((await request("/passkey/verify-authentication", { response })).status, 200);
      const enabled = await request("/two-factor/enable", { password });
      assert.equal(enabled.status, 200);
      const secret = new URL(enabled.body.totpURI).searchParams.get("secret")!;
      assert.equal((await request("/two-factor/verify-totp", { code: totp(secret) })).status, 200);
      await request("/sign-out", {});
      response = await assertion();
      const pending = await request("/passkey/verify-authentication", { response }, "1h", context, {
        "x-fathom-remember-me": "false",
      });
      assert.equal(pending.body.twoFactorRedirect, true, "passkeys honor account 2FA");
      assert.equal(
        (await request("/get-session")).body,
        null,
        "no authenticated session before TOTP",
      );
      assert.ok(
        pending.cookies.every(
          (line) => !line.startsWith("fathom.session_token=") || /Max-Age=0/.test(line),
        ),
        "no live session token leaks during pending TOTP",
      );
      const verified = await request(
        "/two-factor/verify-backup-code",
        { code: enabled.body.backupCodes[0], trustDevice: false },
        "7d",
      );
      assert.equal(verified.status, 200);
      const session = (await request("/get-session")).body.session;
      const remaining = new Date(session.expiresAt).getTime() - Date.now();
      assert.ok(
        remaining > 3_570_000 && remaining <= 3_600_000,
        "signed chosen duration survives 2FA; completion headers cannot expand it",
      );
      assert.doesNotMatch(
        verified.cookies
          .slice()
          .reverse()
          .find((line) => line.startsWith("fathom.session_token="))!,
        /;\s*(?:max-age|expires)=/i,
        "unchecked remember me uses a session cookie",
      );
      assert.equal((await request("/passkey/delete-passkey", { id: keyId })).status, 200);
      assert.equal(database.passkey.length, 0);
      console.log(
        "Virtual Chromium authenticator + real local HTTP only; no platform-device or live OAuth claim.",
      );
    } finally {
      await browser?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
