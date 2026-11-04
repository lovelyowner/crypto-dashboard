import assert from "node:assert/strict";
import test from "node:test";
import { safeAccountReturnPath } from "./return-to";

test("sign-in returns only to a canonical public creator path", () => {
  assert.equal(safeAccountReturnPath("/Creator-name/"), "/creator-name");
  assert.equal(safeAccountReturnPath("/u/Creator-name"), "/creator-name");
  assert.equal(safeAccountReturnPath("/u/login"), "/u/login");
  for (const value of [
    null,
    "https://evil.com/alice",
    "//evil.com",
    "/\\evil.com",
    "/login",
    "/inbox",
    "/api/auth/sign-out",
    "/assets/main.js",
    "/alice?token=private",
    "/alice#private",
    "/%2f%2fevil.com",
    "/alice\n",
    "/u/%FF",
  ]) {
    assert.equal(safeAccountReturnPath(value), null, String(value));
  }
});
