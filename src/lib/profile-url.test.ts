import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  RESERVED_ROOT_HANDLES,
  ROOT_PROFILE_HANDLE_PATTERN,
  ROOT_PROFILE_ROUTE_SOURCE,
  getPublicProfilePath,
  isReservedRootHandle,
  publicHandleFromPath,
} from "./profile-url";

test("creator links use the chosen root ID and preserve reserved legacy addresses", () => {
  assert.equal(getPublicProfilePath(" Artist_123 "), "/artist_123");
  assert.equal(getPublicProfilePath("login"), "/u/login");
  assert.equal(getPublicProfilePath("INBOX"), "/u/inbox");
  assert.throws(() => getPublicProfilePath("bad/id"));
  for (const handle of RESERVED_ROOT_HANDLES) {
    assert.equal(isReservedRootHandle(handle), true);
    assert.equal(isReservedRootHandle(handle.toUpperCase()), true);
  }
  assert.equal(isReservedRootHandle("login-fan"), false);
});

test("root and legacy routes resolve safely without claiming app, asset, or local-file paths", () => {
  for (const path of ["/artist_123", "/artist_123/", "/ARTIST_123", "/%61rtist_123"]) {
    assert.equal(publicHandleFromPath(path), "artist_123", path);
  }
  assert.equal(publicHandleFromPath("/u/artist_123"), "artist_123");
  assert.equal(publicHandleFromPath("/u/login/"), "login");
  assert.equal(publicHandleFromPath("/u/bad%2Fid"), "");
  assert.equal(publicHandleFromPath("/u/%zz"), "");
  for (const path of [
    "/",
    "/login",
    "/LOGIN",
    "/%61pi",
    "/inbox",
    "/api/auth/config",
    "/assets/main.js",
    "/favicon.svg",
    "/robots.txt",
    "/artist?token=x",
    "/artist#secret",
    "/artist/other",
    "/bad%2Fid",
  ]) {
    assert.equal(publicHandleFromPath(path), null, path);
  }
  assert.equal(publicHandleFromPath("/artist", "file:"), null);
  assert.equal(publicHandleFromPath("/u/Fathom.html", "file:"), null);
});

test("Vercel's canonical route accepts IDs while excluding reserved roots and static files", async () => {
  const config = JSON.parse(
    await readFile(new URL("../../vercel.json", import.meta.url), "utf8"),
  ) as {
    rewrites: { source: string; destination: string }[];
  };
  assert.ok(
    config.rewrites.some(
      ({ source, destination }) =>
        source === ROOT_PROFILE_ROUTE_SOURCE && destination === "/index.html",
    ),
  );
  const matches = new RegExp(`^${ROOT_PROFILE_HANDLE_PATTERN}$`);
  for (const handle of ["artist", "Artist_123", "api-fan", "alice-2"])
    assert.equal(matches.test(handle), true, handle);
  for (const handle of [
    ...RESERVED_ROOT_HANDLES,
    ...RESERVED_ROOT_HANDLES.map((value) => value.toUpperCase()),
    "favicon.svg",
    "robots.txt",
    "ab",
    "_alice",
    "alice_",
    "a".repeat(33),
    "api/auth",
  ])
    assert.equal(matches.test(handle), false, handle);
  assert.ok(config.rewrites.some(({ source }) => source === "/login"));
  assert.ok(config.rewrites.some(({ source }) => source === "/u/:handle"));
});
