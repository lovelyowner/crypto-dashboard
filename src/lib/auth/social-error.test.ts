import assert from "node:assert/strict";
import test from "node:test";
import { socialAuthError } from "./social-error.js";

test("an explicit account setup error points to website setup rather than provider login", () => {
  const message = socialAuthError("google", {
    code: "ACCOUNT_SETUP_REQUIRED",
    status: 503,
    message: "Server configuration is incomplete.",
  });
  assert.match(message, /Account sign-in is not set up on this website/);
  assert.match(message, /Open Website sign-in setup/);
  assert.doesNotMatch(message, /Google sign-in is not enabled/);
});

test("missing-provider failures identify the service and registered application requirement", () => {
  for (const [provider, label] of [
    ["google", "Google"],
    ["discord", "Discord"],
    ["twitter", "Twitter / X"],
  ]) {
    const message = socialAuthError(provider, {
      code: "PROVIDER_NOT_FOUND",
      status: 404,
      message: "Provider not found",
    });
    assert.ok(message.startsWith(`${label} sign-in is not enabled on this website.`));
    assert.match(message, /register and configure its OAuth application/);
  }
});

test("explicit HTTP error messages retain their meaning instead of implying missing configuration", () => {
  for (const status of [401, 403, 404, 429, 500, 503]) {
    assert.equal(
      socialAuthError("google", { status, message: "Account service is temporarily unavailable." }),
      "Account service is temporarily unavailable.",
    );
  }
});

test("non-JSON access failures identify the HTTP status without guessing a missing OAuth application", () => {
  for (const status of [401, 403]) {
    const message = socialAuthError("google", { status });
    assert.match(message, /^Google sign-in was blocked by this website/);
    assert.ok(message.includes(`HTTP ${status}`));
    assert.match(message, /full browser tab|deployment access/);
    assert.doesNotMatch(message, /not enabled|not set up|register|credentials are missing/);
  }
});

test("non-JSON missing routes, rate limits, and server failures have distinct actionable errors", () => {
  const missing = socialAuthError("discord", { status: 404 });
  assert.match(missing, /Discord.*account API.*HTTP 404/);
  assert.match(missing, /API routing/);
  const limited = socialAuthError("twitter", { status: 429 });
  assert.match(limited, /Twitter \/ X.*too many attempts.*HTTP 429/);
  assert.match(limited, /Wait before trying again/);
  for (const status of [500, 502, 503, 504, 599]) {
    const failed = socialAuthError("github", { status });
    assert.match(failed, /GitHub.*account server is unavailable/);
    assert.ok(failed.includes(`HTTP ${status}`));
    assert.match(failed, /function logs/);
    assert.doesNotMatch(failed, /not enabled|not set up|register|credentials are missing/);
  }
});

test("unknown and invalid HTTP statuses get a safe provider-labelled retry fallback", () => {
  assert.match(socialAuthError("google", { status: 400 }), /Google.*HTTP 400.*try again/);
  for (const status of [undefined, 0, NaN, Infinity, -1, 200, 999])
    assert.equal(
      socialAuthError("google", { status }),
      "Could not start Google sign-in. Please try again.",
    );
});

test("existing policy errors remain actionable and empty failures get the provider label", () => {
  assert.equal(
    socialAuthError("discord", {
      code: "FORBIDDEN",
      message: "Verify your email before linking a social account.",
    }),
    "Verify your email before linking a social account.",
  );
  assert.equal(
    socialAuthError("twitter", { message: "   " }),
    "Could not start Twitter / X sign-in. Please try again.",
  );
  assert.equal(
    socialAuthError("another-service", {}),
    "Could not start another-service sign-in. Please try again.",
  );
});
