import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WORKSPACE_VIEW,
  parseWorkspaceView,
  serializeWorkspaceView,
} from "./view-preferences";

test("remembered views restore supported tab, sort, network and transaction choices", () => {
  const expected = {
    tab: "Activity" as const,
    sort: "balance" as const,
    network: "base" as const,
    direction: "out" as const,
    status: "pending" as const,
    range: "7d" as const,
  };
  assert.deepEqual(parseWorkspaceView(serializeWorkspaceView(expected)), expected);
  for (const network of ["ethereum", "cosmos", "solana", "near", "xrp", "monero", "all"] as const) {
    assert.equal(parseWorkspaceView(JSON.stringify({ version: 1, network })).network, network);
  }
});

test("malformed and future saved views fall back without accepting arbitrary navigation", () => {
  for (const raw of [
    null,
    "",
    "{broken",
    "[]",
    "null",
    '{"version":2,"tab":"Wallets"}',
    "x".repeat(8193),
  ]) {
    assert.deepEqual(parseWorkspaceView(raw), DEFAULT_WORKSPACE_VIEW);
  }
  const first = parseWorkspaceView(null);
  first.tab = "Wallets";
  assert.equal(parseWorkspaceView(null).tab, "Overview");
});

test("bad enum values and unknown networks cannot affect valid neighboring choices", () => {
  assert.deepEqual(
    parseWorkspaceView(
      JSON.stringify({
        version: 1,
        tab: "https://attacker.example/",
        sort: "__proto__",
        network: "constructor",
        direction: "incoming",
        status: false,
        range: "1s",
      }),
    ),
    DEFAULT_WORKSPACE_VIEW,
  );
  assert.deepEqual(
    parseWorkspaceView(
      JSON.stringify({
        version: 1,
        tab: "Networks",
        network: "unsupported",
        status: "failed",
        range: "30d",
      }),
    ),
    {
      ...DEFAULT_WORKSPACE_VIEW,
      tab: "Networks",
      status: "failed",
      range: "30d",
    },
  );
});

test("view persistence allowlist excludes searches, address selections and unrelated sensitive state", () => {
  const extras = {
    ...DEFAULT_WORKSPACE_VIEW,
    search: "private search history",
    address: "0xprivate-address-selection",
    privateKey: "never-store-me",
    uploadedFile: "never-store-file-contents",
  };
  const saved = serializeWorkspaceView(extras);
  const keys = Object.keys(JSON.parse(saved)).sort();
  assert.deepEqual(
    keys,
    ["version", "tab", "sort", "network", "direction", "status", "range"].sort(),
  );
  assert(!saved.includes("private"));
  assert(!saved.includes("uploaded"));
  assert.deepEqual(
    parseWorkspaceView(JSON.stringify({ version: 1, ...extras })),
    DEFAULT_WORKSPACE_VIEW,
  );
});
