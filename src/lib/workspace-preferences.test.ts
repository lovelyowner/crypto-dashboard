import test from "node:test";
import assert from "node:assert/strict";
import { isRefreshInterval, parseWorkspacePreferences } from "./workspace-preferences";

test("preferences retain the legacy refresh choice without inventing hidden or paused state", () => {
  assert.deepEqual(parseWorkspacePreferences(null, "300000"), {
    hideBalances: false,
    syncPaused: false,
    refreshInterval: 300000,
  });
  assert.equal(parseWorkspacePreferences(null, "0").refreshInterval, 0);
  assert.equal(parseWorkspacePreferences(null, "").refreshInterval, 60000);
});
test("invalid JSON, future versions and unsupported intervals cannot cause excessive polling", () => {
  for (const raw of [
    "{broken",
    "[]",
    "null",
    '{"version":2,"hideBalances":true,"refreshInterval":1}',
    '{"version":1,"hideBalances":"true","syncPaused":"false","refreshInterval":1}',
  ]) {
    assert.deepEqual(parseWorkspacePreferences(raw), {
      hideBalances: false,
      syncPaused: false,
      refreshInterval: 60000,
    });
  }
  for (const value of [1, -1, Infinity, NaN, "60000", null, undefined])
    assert.equal(isRefreshInterval(value), false);
});
test("current preferences preserve genuine boolean values and override a legacy interval", () => {
  assert.deepEqual(
    parseWorkspacePreferences(
      JSON.stringify({ version: 1, hideBalances: true, syncPaused: true, refreshInterval: 30000 }),
      "300000",
    ),
    { hideBalances: true, syncPaused: true, refreshInterval: 30000 },
  );
  assert.deepEqual(
    parseWorkspacePreferences('{"version":1,"hideBalances":true,"refreshInterval":999}', "0"),
    { hideBalances: true, syncPaused: false, refreshInterval: 0 },
  );
});
