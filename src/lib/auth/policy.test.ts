import test from "node:test";
import assert from "node:assert/strict";
import { isValidUsername, normalizeUsername, isFreshAccountSession } from "./policy.ts";

test("username accepts meaningful Unicode, punctuation, internal spaces, and @", () => {
  for (const name of ["宇宙 @ 🪐 +/?!", "user@home", "a", "Ελληνικά", "é", "recovery #1"])
    assert.equal(isValidUsername(name), true, name);
});
test("username normalizes NFC but preserves case", () => {
  assert.equal(normalizeUsername("e\u0301"), "é");
  assert.notEqual(normalizeUsername("Name"), normalizeUsername("name"));
});
test("username rejects hidden controls, surrounding whitespace, empty and overlong names", () => {
  for (const name of [
    "",
    " x",
    "x ",
    "user\nname",
    "x\u202Ey",
    "x\u200By",
    "x\ud800y",
    "a".repeat(65),
  ])
    assert.equal(isValidUsername(name), false);
});

test("adding a password rejects expired, future, and invalid session timestamps", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(isFreshAccountSession(new Date(now - 60_000), now), true);
  assert.equal(isFreshAccountSession(new Date(now - 10 * 60_000), now), false);
  assert.equal(isFreshAccountSession(new Date(now + 1), now), false);
  assert.equal(isFreshAccountSession("invalid", now), false);
});
