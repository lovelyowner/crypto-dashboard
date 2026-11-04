import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CREATOR_PROFILE } from "./creator-profile";
import {
  normalizePublicHandle,
  validatePublishableProfile,
  validatePublicCreatorProfile,
  validatePublication,
  validatePublicationResponse,
} from "./public-profile";

const profile = { ...structuredClone(DEFAULT_CREATOR_PROFILE), displayName: "Creator 🌙" };
const publication = {
  handle: "creator_name",
  profile,
  updatedAt: "2026-11-04T00:00:00.000Z",
  published: true,
};

test("public handles are portable, normalized and separate from Unicode sign-in names", () => {
  assert.equal(normalizePublicHandle(" Creator_Name "), "creator_name");
  assert.equal(normalizePublicHandle("a-b"), "a-b");
  assert.equal(normalizePublicHandle("0".repeat(32)), "0".repeat(32));
  for (const invalid of [
    null,
    undefined,
    12,
    "",
    "ab",
    "a".repeat(33),
    "_name",
    "name-",
    "a/b",
    "a%2fb",
    "a.b",
    "creator @ name",
    "mira🌙",
    "Kelvin",
    "na\nme",
    "../name",
  ]) {
    assert.throws(() => normalizePublicHandle(invalid), Error, String(invalid));
  }
});

test("publishing requires a display name and still strips credential-shaped fields", () => {
  assert.throws(() => validatePublishableProfile(DEFAULT_CREATOR_PROFILE), /display name/);
  assert.throws(() => validatePublishableProfile({ ...profile, displayName: " \t " }), Error);
  assert.deepEqual(
    validatePublishableProfile({
      ...profile,
      userId: "hidden",
      email: "hidden@example.com",
      privateKey: "hidden",
    }),
    profile,
  );
});

test("public and private publication response validators allow only explicit public fields", () => {
  const value = {
    ...publication,
    userId: "must-not-leak",
    email: "must-not-leak",
    verified: true,
    providerTokens: "must-not-leak",
  };
  assert.deepEqual(validatePublication(value), publication);
  assert.deepEqual(validatePublicationResponse({ publication: value, session: "hidden" }), {
    publication,
  });
  assert.deepEqual(validatePublicationResponse({ publication: null }), { publication: null });
  const publicValue = validatePublicCreatorProfile(value);
  assert.deepEqual(publicValue, {
    handle: publication.handle,
    profile,
    updatedAt: publication.updatedAt,
  });
  assert.doesNotMatch(
    JSON.stringify(publicValue),
    /must-not-leak|published|userId|verified|providerTokens/,
  );
  for (const invalid of [
    { ...publication, handle: "CREATOR_NAME" },
    { ...publication, updatedAt: "invalid" },
    { ...publication, published: "true" },
    null,
    [],
  ]) {
    assert.throws(() => validatePublication(invalid), Error);
  }
  assert.throws(() => validatePublicationResponse({}), Error);
});
