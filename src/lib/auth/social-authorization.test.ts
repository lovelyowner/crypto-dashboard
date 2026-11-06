import assert from "node:assert/strict";
import test from "node:test";
import {
  requestSocialAuthorization,
  SOCIAL_AUTHORIZATION_TIMEOUT_MS,
} from "./social-authorization.js";
import type { SupportedSocialProviderId } from "./providers.js";

const endpoints: Record<SupportedSocialProviderId, string> = {
  google: "https://accounts.google.com/o/oauth2/v2/auth",
  discord: "https://discord.com/api/oauth2/authorize",
  twitter: "https://x.com/i/oauth2/authorize",
  github: "https://github.com/login/oauth/authorize",
  twitch: "https://id.twitch.tv/oauth2/authorize",
};
const validGoogle = { data: { url: `${endpoints.google}?state=private-fixture`, redirect: false } };

test("all five native authorization endpoints accept manual-redirect responses", async () => {
  assert.equal(SOCIAL_AUTHORIZATION_TIMEOUT_MS, 12_000);
  for (const [provider, endpoint] of Object.entries(endpoints)) {
    const url = `${endpoint}?client_id=fixture&state=private-fixture`;
    const authorization = await requestSocialAuthorization(
      provider as SupportedSocialProviderId,
      async () => ({ data: { url, redirect: false }, error: null }),
    );
    assert.deepEqual(authorization, { kind: "redirect", url });
  }
  assert.deepEqual(
    await requestSocialAuthorization("discord", async () => ({
      data: { url: "https://discord.com/oauth2/authorize?state=fixture", redirect: false },
    })),
    { kind: "redirect", url: "https://discord.com/oauth2/authorize?state=fixture" },
  );
});

test("an absent or malformed authorization result fails visibly instead of completing silently", async () => {
  for (const result of [
    null,
    undefined,
    "<!doctype html>private-fixture",
    [],
    {},
    { data: null },
    { data: [] },
    { data: {} },
    { data: { url: "" } },
    { data: { url: "  " } },
    { data: { url: 42 } },
    { data: { twoFactorRedirect: "true" } },
  ])
    await assert.rejects(
      requestSocialAuthorization("google", async () => result),
      { message: "Google did not return an authorization link. Please try again." },
    );
});

test("unsafe, mismatched, and non-authorization URLs are rejected without echoing them", async () => {
  for (const url of [
    "javascript:alert('private-fixture')",
    "data:text/html,private-fixture",
    "/private-fixture",
    "https://accounts.google.com.attacker.invalid/o/oauth2/v2/auth?state=private-fixture",
    "http://accounts.google.com/o/oauth2/v2/auth?state=private-fixture",
    "https://accounts.google.com/o/oauth2/v2/auth/extra?state=private-fixture",
    "https://accounts.google.com:444/o/oauth2/v2/auth?state=private-fixture",
    "https://private-fixture@accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com/o/oauth2/v2/auth#private-fixture",
    "https://accounts.google.com/o/oauth2/v2/auth#",
    "https://discord.com/api/oauth2/authorize?state=private-fixture",
  ])
    await assert.rejects(
      requestSocialAuthorization("google", async () => ({ data: { url } })),
      { message: "Google returned an invalid authorization link. Please try again." },
    );
});

test("setup/provider failures and account-linking policy messages remain actionable", async () => {
  await assert.rejects(
    requestSocialAuthorization("google", async () => ({
      error: { code: "ACCOUNT_SETUP_REQUIRED", message: "private-fixture", status: 503 },
    })),
    /Account sign-in is not set up on this website\. Open Website sign-in setup/,
  );
  await assert.rejects(
    requestSocialAuthorization("discord", async () => ({
      error: { code: "PROVIDER_NOT_FOUND", message: "private-fixture", status: 404 },
    })),
    /Discord sign-in is not enabled on this website.*register and configure/,
  );
  await assert.rejects(
    requestSocialAuthorization("google", async () => ({
      error: { message: "Account service is temporarily unavailable.", status: 503 },
    })),
    { message: "Account service is temporarily unavailable." },
  );
  await assert.rejects(
    requestSocialAuthorization("google", async () => ({
      error: { code: "FORBIDDEN", message: "Verify your email before linking a social account." },
    })),
    { message: "Verify your email before linking a social account." },
  );
});

test("thrown network/parser failures do not leak transport details or authorization state", async () => {
  for (const cause of [
    new TypeError("private-fixture network failure"),
    new SyntaxError("private-fixture response body"),
    "private-fixture transport error",
  ])
    await assert.rejects(
      requestSocialAuthorization("google", async () => {
        throw cause;
      }),
      { message: "Google sign-in is unavailable. Please try again." },
    );
});

test("a verified two-factor continuation is handled before requiring an authorization URL", async () => {
  assert.deepEqual(
    await requestSocialAuthorization("google", async () => ({
      data: { twoFactorRedirect: true, url: "javascript:private-fixture" },
    })),
    { kind: "two-factor" },
  );
});

test("the deadline aborts a transport that never settles even when it ignores abort", async () => {
  let requestSignal: AbortSignal | undefined;
  await assert.rejects(
    requestSocialAuthorization(
      "google",
      (signal) => {
        requestSignal = signal;
        return new Promise(() => {});
      },
      { timeoutMs: 15 },
    ),
    { message: "Google sign-in took too long. Please try again." },
  );
  assert.equal(requestSignal?.aborted, true);
});

test("the full response/body deadline rejects a late authorization result permanently", async () => {
  let resolveBody!: (value: unknown) => void;
  const pending = requestSocialAuthorization(
    "google",
    async () => {
      await Promise.resolve("headers already received");
      return new Promise((resolve) => {
        resolveBody = resolve;
      });
    },
    { timeoutMs: 15 },
  );
  await assert.rejects(pending, { message: "Google sign-in took too long. Please try again." });
  resolveBody(validGoogle);
  await assert.rejects(pending, { message: "Google sign-in took too long. Please try again." });
});

test("external cancellation aborts an active request and late responses cannot succeed", async () => {
  const external = new AbortController();
  let requestSignal!: AbortSignal;
  let resolveBody!: (value: unknown) => void;
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const pending = requestSocialAuthorization(
    "discord",
    (signal) => {
      requestSignal = signal;
      notifyStarted();
      return new Promise((resolve) => {
        resolveBody = resolve;
      });
    },
    { signal: external.signal },
  );
  await started;
  external.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(requestSignal.aborted, true);
  resolveBody({ data: { url: endpoints.discord } });
  await assert.rejects(pending, { name: "AbortError" });
});

test("already cancelled requests never start a transport", async () => {
  const external = new AbortController();
  external.abort();
  let calls = 0;
  await assert.rejects(
    requestSocialAuthorization(
      "google",
      async () => {
        calls++;
        return validGoogle;
      },
      {
        signal: external.signal,
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(calls, 0);
});
