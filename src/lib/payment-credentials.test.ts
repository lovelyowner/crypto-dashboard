import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import {
  decryptPaymentCredentials,
  encryptPaymentCredentials,
  validatePaymentCredentials,
} from "./payment-credentials";

const credentials = {
  apiKey: "merchant-fixture-key-12345",
  ipnSecret: "fixture-ipn-secret-at-least-sixteen",
};
test("merchant secrets use randomized authenticated encryption bound to creator and credential version", () => {
  const secret = randomBytes(32).toString("hex");
  const first = encryptPaymentCredentials(credentials, secret, "creator-a", "version-1");
  const second = encryptPaymentCredentials(credentials, secret, "creator-a", "version-1");
  assert.notEqual(first, second);
  assert.equal(first.includes(credentials.apiKey), false);
  assert.equal(first.includes(credentials.ipnSecret), false);
  assert.deepEqual(decryptPaymentCredentials(first, secret, "creator-a", "version-1"), credentials);
  for (const [key, owner, version] of [
    [secret, "creator-b", "version-1"],
    [secret, "creator-a", "version-2"],
    [randomBytes(32).toString("hex"), "creator-a", "version-1"],
  ]) {
    assert.throws(
      () => decryptPaymentCredentials(first, key, owner, version),
      /could not be unlocked/,
    );
  }
  const parts = first.split(".");
  const ciphertext = Buffer.from(parts[2], "base64url");
  ciphertext[0] ^= 1;
  parts[2] = ciphertext.toString("base64url");
  assert.throws(
    () => decryptPaymentCredentials(parts.join("."), secret, "creator-a", "version-1"),
    /could not be unlocked/,
  );
});
test("merchant credentials reject concealed controls, unsupported fields and weak encryption configuration", () => {
  assert.deepEqual(validatePaymentCredentials(credentials), credentials);
  for (const input of [
    null,
    [],
    { ...credentials, userId: "other" },
    { ...credentials, apiKey: "short" },
    { ...credentials, apiKey: "merchant\nkey" },
    { ...credentials, ipnSecret: "short" },
    { ...credentials, ipnSecret: " padded secret for callback " },
  ]) {
    assert.throws(() => validatePaymentCredentials(input));
  }
  assert.throws(
    () => encryptPaymentCredentials(credentials, "short", "creator-a", "version-1"),
    /unavailable/,
  );
  for (const source of ["", "v1.bad.bad.bad", "v2.a.b.c", "x".repeat(5000)])
    assert.throws(
      () => decryptPaymentCredentials(source, "x".repeat(32), "a", "b"),
      /could not be unlocked/,
    );
});
