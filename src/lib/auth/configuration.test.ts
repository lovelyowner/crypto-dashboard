import test from "node:test";
import assert from "node:assert/strict";
import { configuredAuthOrigin } from "./configuration.ts";

test("production accepts only a valid HTTPS origin, with an optional trailing slash", () => {
  assert.equal(
    configuredAuthOrigin("https://dashboard.example.com/", true),
    "https://dashboard.example.com",
  );
  assert.equal(
    configuredAuthOrigin(" https://dashboard.example.com ", true),
    "https://dashboard.example.com",
  );
  for (const invalid of [
    undefined,
    "https://",
    "not-a-url",
    "http://dashboard.example.com",
    "https://user:password@dashboard.example.com",
    "https://dashboard.example.com/login",
    "https://dashboard.example.com?query=1",
    "https://dashboard.example.com#fragment",
  ])
    assert.equal(configuredAuthOrigin(invalid, true), null);
  assert.equal(configuredAuthOrigin("http://localhost:8080/", false), "http://localhost:8080");
});
