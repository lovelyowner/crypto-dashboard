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

test("generic HTTP failures never imply missing account or OAuth configuration", () => {
  for (const status of [404, 503]) {
    assert.equal(
      socialAuthError("google", { status, message: "Account service is temporarily unavailable." }),
      "Account service is temporarily unavailable.",
    );
    const fallback = socialAuthError("google", { status });
    assert.match(fallback, /^Could not start Google sign-in/);
    assert.doesNotMatch(fallback, /not enabled|not set up|register|configure/);
  }
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
