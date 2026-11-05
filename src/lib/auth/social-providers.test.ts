import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  configuredSocialProviders,
  socialProviderAvailability,
} from "./social-providers.server.ts";
import { sessionDurationPlugin } from "./session-duration.ts";
import { ACCOUNT_SESSION_POLICY, SESSION_DURATION_HEADER } from "./policy.ts";

const appCredentials = {
  GITHUB_CLIENT_ID: "github-fixture-client",
  GITHUB_CLIENT_SECRET: "github-fixture-secret",
  TWITCH_CLIENT_ID: "twitch-fixture-client",
  TWITCH_CLIENT_SECRET: "twitch-fixture-secret",
};

test("social adapters require complete credential pairs and public flags require configured accounts", () => {
  assert.deepEqual(configuredSocialProviders({}), {});
  for (const prefix of ["GOOGLE", "DISCORD", "TWITTER", "GITHUB", "TWITCH"]) {
    assert.deepEqual(configuredSocialProviders({ [`${prefix}_CLIENT_ID`]: "client-only" }), {});
    assert.deepEqual(configuredSocialProviders({ [`${prefix}_CLIENT_SECRET`]: "secret-only" }), {});
    assert.deepEqual(
      configuredSocialProviders({
        [`${prefix}_CLIENT_ID`]: "client",
        [`${prefix}_CLIENT_SECRET`]: "  ",
      }),
      {},
    );
  }
  const configuration = configuredSocialProviders(appCredentials);
  assert.deepEqual(Object.keys(configuration), ["github", "twitch"]);
  assert.deepEqual(socialProviderAvailability(configuration, true), {
    google: false,
    discord: false,
    twitter: false,
    github: true,
    twitch: true,
  });
  assert.deepEqual(socialProviderAvailability(configuration, false), {
    google: false,
    discord: false,
    twitter: false,
    github: false,
    twitch: false,
  });
  assert.equal(
    JSON.stringify(socialProviderAvailability(configuration, true)).includes("fixture-secret"),
    false,
  );
});

test("official GitHub/Twitch OAuth flows preserve state, scopes, duration and explicit verified-email linking", async () => {
  const origin = "http://localhost:8080";
  const database: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  const auth = betterAuth({
    database: memoryAdapter(database),
    baseURL: origin,
    trustedOrigins: [origin],
    secret: randomBytes(32).toString("hex"),
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
    telemetry: { enabled: false },
    socialProviders: configuredSocialProviders(appCredentials),
    session: ACCOUNT_SESSION_POLICY,
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
      },
    },
    advanced: { cookiePrefix: "fathom", useSecureCookies: false },
    plugins: [sessionDurationPlugin()],
  });
  const cookies = new Map<string, string>();
  async function request(path: string, body?: Record<string, unknown>, duration = "1h") {
    const response = await auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          origin,
          cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
          [SESSION_DURATION_HEADER]: duration,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0],
        at = pair.indexOf("=");
      const name = pair.slice(0, at),
        value = pair.slice(at + 1);
      if (!value || /Max-Age=0(?:;|$)/i.test(line)) cookies.delete(name);
      else cookies.set(name, value);
    }
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      location: response.headers.get("location"),
    };
  }
  const authorization = new Map<string, URL>();
  async function start(provider: "github" | "twitch", linking = false) {
    const result = await request(linking ? "/link-social" : "/sign-in/social", {
      provider,
      callbackURL: "/login",
      disableRedirect: true,
    });
    assert.equal(result.status, 200);
    const url = new URL(result.body.url);
    authorization.set(provider, url);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), `${provider}-fixture-client`);
    assert.equal(url.searchParams.get("redirect_uri"), `${origin}/api/auth/callback/${provider}`);
    assert.ok((url.searchParams.get("state")?.length ?? 0) >= 32);
    assert.equal(url.searchParams.has("client_secret"), false);
    if (provider === "github") {
      assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
      assert.deepEqual(
        new Set(url.searchParams.get("scope")!.split(" ")),
        new Set(["read:user", "user:email"]),
      );
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.ok(url.searchParams.get("code_challenge"));
    } else {
      assert.equal(url.origin + url.pathname, "https://id.twitch.tv/oauth2/authorize");
      assert.deepEqual(
        new Set(url.searchParams.get("scope")!.split(" ")),
        new Set(["openid", "user:read:email"]),
      );
      assert.deepEqual(Object.keys(JSON.parse(url.searchParams.get("claims")!).id_token), [
        "email",
        "email_verified",
        "preferred_username",
        "picture",
      ]);
      assert.equal(
        url.searchParams.has("code_challenge"),
        false,
        "the official Twitch confidential-client adapter does not claim PKCE",
      );
    }
    return url.searchParams.get("state")!;
  }
  async function callback(provider: "github" | "twitch", state: string) {
    return request(
      `/callback/${provider}?code=${provider}-fixture-code&state=${encodeURIComponent(state)}`,
      undefined,
      "7d",
    );
  }

  const identity = {
    github: { id: "github-owner", email: "github.owner@example.com", verified: true },
    twitch: { id: "twitch-owner", email: "twitch.owner@example.com", verified: true },
  };
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetchCalls++;
    const url = new URL(input instanceof Request ? input.url : String(input));
    const tokenProvider =
      url.href === "https://github.com/login/oauth/access_token"
        ? "github"
        : url.href === "https://id.twitch.tv/oauth2/token"
          ? "twitch"
          : null;
    if (tokenProvider) {
      assert.equal(init?.method, "POST");
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("client_id"), `${tokenProvider}-fixture-client`);
      assert.equal(body.get("client_secret"), `${tokenProvider}-fixture-secret`);
      assert.equal(body.get("code"), `${tokenProvider}-fixture-code`);
      assert.equal(body.get("redirect_uri"), `${origin}/api/auth/callback/${tokenProvider}`);
      if (tokenProvider === "github") {
        const verifier = body.get("code_verifier");
        assert.ok(verifier);
        assert.equal(
          createHash("sha256").update(verifier).digest("base64url"),
          authorization.get("github")!.searchParams.get("code_challenge"),
        );
      } else assert.equal(body.has("code_verifier"), false);
      const claims = {
        sub: identity.twitch.id,
        email: identity.twitch.email,
        email_verified: identity.twitch.verified,
        preferred_username: "Fixture creator",
        picture: "https://images.example/avatar.png",
      };
      // The ID token is an HTTP token-endpoint fixture, never a client credential.
      const fixtureIdToken = `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture-signature`;
      return Response.json({
        access_token: `${tokenProvider}-fixture-access-token`,
        refresh_token: `${tokenProvider}-fixture-refresh-token`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: tokenProvider === "github" ? "read:user user:email" : "openid user:read:email",
        ...(tokenProvider === "twitch" ? { id_token: fixtureIdToken } : {}),
      });
    }
    if (url.href === "https://api.github.com/user")
      return Response.json({
        id: identity.github.id,
        login: "fixture-owner",
        name: "Fixture owner",
        email: null,
        avatar_url: "https://images.example/avatar.png",
      });
    if (url.href === "https://api.github.com/user/emails")
      return Response.json(
        identity.github.email
          ? [{ email: identity.github.email, primary: true, verified: identity.github.verified }]
          : [],
      );
    throw new Error(`Unexpected provider fixture HTTP request: ${url.origin}${url.pathname}`);
  };
  try {
    for (const provider of ["github", "twitch"] as const) {
      const state = await start(provider);
      const result = await callback(provider, state);
      assert.equal(result.status, 302);
      assert.equal(result.location, "/login");
      const session = (await request("/get-session")).body;
      assert.equal(session.user.email, identity[provider].email);
      assert.equal(session.user.emailVerified, true);
      const remaining = new Date(session.session.expiresAt).getTime() - Date.now();
      assert.ok(
        remaining > 3_570_000 && remaining <= 3_600_000,
        "callback cannot expand the signed selected duration",
      );
      const account = database.account.find((row) => row.providerId === provider)!;
      assert.equal(account.accountId, identity[provider].id);
      assert.notEqual(
        account.accessToken,
        `${provider}-fixture-access-token`,
        "provider tokens remain encrypted",
      );
      const callsBeforeReplay = fetchCalls;
      const replayed = await callback(provider, state);
      assert.match(replayed.location!, /error=(state_mismatch|state_not_found|state_invalid)/);
      assert.equal(fetchCalls, callsBeforeReplay, "replayed callbacks never reach the provider");
      await request("/sign-out", {});
    }
    const callsBeforeInvalid = fetchCalls;
    await start("github");
    assert.match((await callback("github", "forged-state")).location!, /error=state_mismatch/);
    assert.equal(fetchCalls, callsBeforeInvalid);
    assert.equal(
      (
        await request("/sign-in/social", {
          provider: "twitch",
          idToken: { token: "client-supplied-token" },
        })
      ).status,
      404,
    );
    assert.equal((await request("/sign-in/social", { provider: "google" })).status, 404);

    identity.twitch.id = "twitch-unverified-email";
    identity.twitch.email = "unverified.twitch@example.com";
    identity.twitch.verified = false;
    assert.equal((await callback("twitch", await start("twitch"))).location, "/login");
    assert.equal(
      (await request("/get-session")).body.user.emailVerified,
      false,
      "an unverified provider mailbox is never promoted to verified",
    );
    await request("/sign-out", {});

    const password = randomBytes(24).toString("hex");
    const signup = await request("/sign-up/email", {
      email: "local.owner@example.com",
      password,
      name: "Local owner",
    });
    const localUserId = signup.body.user.id;
    database.user.find((row) => row.id === localUserId)!.emailVerified = true;
    identity.github.id = "github-to-link";
    identity.github.email = "different.owner@example.com";
    assert.match(
      (await callback("github", await start("github", true))).location!,
      /error=email_doesn/,
    );
    assert.equal(
      database.account.some((row) => row.accountId === identity.github.id),
      false,
    );
    identity.github.email = "local.owner@example.com";
    identity.github.verified = false;
    assert.match(
      (await callback("github", await start("github", true))).location!,
      /error=unable_to_link_account/,
    );
    assert.equal(
      database.account.some((row) => row.accountId === identity.github.id),
      false,
    );
    identity.github.verified = true;
    assert.equal((await callback("github", await start("github", true))).location, "/login");
    const linked = database.account.find((row) => row.accountId === identity.github.id)!;
    assert.equal(linked.userId, localUserId);
    assert.ok(
      database.account.some((row) => row.userId === localUserId && row.providerId === "credential"),
      "password recovery remains independent",
    );
    await request("/sign-out", {});
    identity.github.id = "unlinked-provider-with-same-email";
    const implicit = await callback("github", await start("github"));
    assert.match(implicit.location!, /error=account_not_linked/);
    assert.equal(
      database.account.some((row) => row.accountId === identity.github.id),
      false,
    );
    assert.equal((await request("/get-session")).body, null);
    identity.github.email = "";
    assert.match(
      (await callback("github", await start("github"))).location!,
      /error=email_not_found/,
    );
    identity.twitch.email = "";
    assert.match(
      (await callback("twitch", await start("twitch"))).location!,
      /error=email_not_found/,
    );
    assert.equal(
      database.user.some((row) => String(row.email).includes("unlinked-provider")),
      false,
    );
    console.log(
      "GitHub/Twitch official-adapter HTTP fixtures only; registered-app live OAuth is not exercised.",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
