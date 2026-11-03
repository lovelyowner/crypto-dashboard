import test from "node:test";
import assert from "node:assert/strict";
import type { ChainActivity } from "./activity.functions";
import { summarizeSyncHealth, formatSyncTimestamp, STALE_BALANCE_MS } from "./sync-health";

const now = Date.UTC(2026, 0, 1, 12);
const ethereum = "0x0000000000000000000000000000000000000001";
function result(patch: Partial<ChainActivity> = {}): ChainActivity {
  return {
    chain: "ethereum",
    address: ethereum,
    ok: true,
    history: "full",
    balance: "87654321.123456789",
    symbol: "ETH",
    usd: 987654321,
    txs: [],
    fetchedAt: now - 1000,
    ...patch,
  };
}

test("coverage separates complete recent pages, limited history, denied providers, private networks and missing results", () => {
  const rows = [
    result(),
    result({ chain: "base", history: "balance-only", historyNote: "Native balance only." }),
    result({
      chain: "solana",
      address: "11111111111111111111111111111111",
      ok: false,
      error: "HTTP429",
      balance: "—",
      usd: null,
    }),
    result({
      chain: "monero",
      address: "private-public-address",
      ok: false,
      error: "Private balance",
      balance: "—",
      usd: null,
    }),
  ];
  const summary = summarizeSyncHealth(rows, 5, { now });
  assert.equal(summary.state, "unavailable");
  assert.deepEqual(
    {
      available: summary.available,
      limited: summary.limited,
      unavailable: summary.unavailable,
      private: summary.privateCount,
      missing: summary.missing,
    },
    { available: 2, limited: 1, unavailable: 1, private: 1, missing: 1 },
  );
  assert.match(summary.rows.find((row) => row.chain === "solana")!.detail, /rate limiting/);
  assert.match(summary.rows.find((row) => row.chain === "monero")!.detail, /cannot reveal/);
  assert.equal(summary.rows.find((row) => row.chain === "base")!.detail, "Native balance only.");
});

test("cached response timestamps never replace original balance-check times or make old data fresh", () => {
  const old = now - STALE_BALANCE_MS;
  const summary = summarizeSyncHealth([result({ fetchedAt: old })], 1, { now, updatedAt: now });
  assert.equal(summary.state, "stale");
  assert.equal(summary.stale, 1);
  assert.equal(summary.oldestBalanceAt, old);
  assert.equal(summary.responseAt, now);
  assert.equal(summarizeSyncHealth([result({ fetchedAt: old + 1 })], 1, { now }).stale, 0);
});

test("offline, pause, and active refresh states take priority while keeping last result coverage visible", () => {
  const rows = [result()];
  assert.equal(
    summarizeSyncHealth(rows, 1, { now, online: false, paused: true, fetching: true }).state,
    "offline",
  );
  assert.equal(
    summarizeSyncHealth(rows, 1, { now, online: true, paused: true, fetching: true }).state,
    "paused",
  );
  const fetching = summarizeSyncHealth(rows, 1, { now, fetching: true });
  assert.equal(fetching.state, "fetching");
  assert.equal(fetching.available, 1);
  assert.equal(summarizeSyncHealth(rows, 1, { now }).state, "available");
  assert.equal(
    summarizeSyncHealth([result({ history: "balance-only" })], 1, { now }).state,
    "limited",
  );
  assert.equal(
    summarizeSyncHealth([result({ chain: "monero", ok: false })], 1, { now }).state,
    "private",
  );
});

test("unknown and future check times are labeled unknown instead of silently using the query update clock", () => {
  for (const fetchedAt of [undefined, NaN, Infinity, 0, now + 1, Number.MAX_VALUE]) {
    const summary = summarizeSyncHealth([result({ fetchedAt })], 1, { now, updatedAt: now });
    assert.equal(summary.oldestBalanceAt, null);
    assert.equal(summary.latestAttemptAt, null);
    assert.equal(summary.unknownBalanceTimes, 1);
    assert.equal(summary.stale, 0);
  }
  assert.equal(summarizeSyncHealth([], 2, { now }).state, "incomplete");
  assert.equal(summarizeSyncHealth([result()], 0, { now }).rows.length, 0);
});

test("duplicate chain-address results use the latest completed result and do not inflate coverage", () => {
  const summary = summarizeSyncHealth(
    [
      result({ ok: false, fetchedAt: now - 5000 }),
      result({ fetchedAt: now - 1000 }),
      result({ address: ethereum.toUpperCase().replace("0X", "0x"), fetchedAt: now - 2000 }),
    ],
    1,
    { now },
  );
  assert.equal(summary.checked, 1);
  assert.equal(summary.available, 1);
  assert.equal(summary.unavailable, 0);
  assert.equal(summary.oldestBalanceAt, now - 1000);
});

test("health output contains request coverage but does not include balances, valuations or transaction payloads", () => {
  const summary = summarizeSyncHealth(
    [
      result({
        txs: [
          {
            hash: "sensitive-fixture-hash",
            time: now,
            direction: "in",
            amount: "246810.13579",
            symbol: "ETH",
            counterparty: "counterparty",
            status: "ok",
          },
        ],
      }),
    ],
    1,
    { now },
  );
  const text = JSON.stringify(summary);
  for (const value of ["87654321.123456789", "987654321", "246810.13579", "sensitive-fixture-hash"])
    assert(!text.includes(value));
  assert(!("balance" in summary.rows[0]!));
  assert(!("usd" in summary.rows[0]!));
  assert(!("txs" in summary.rows[0]!));
});

test("sync times use explicit day.month.year and UTC time with safe invalid handling", () => {
  assert.equal(formatSyncTimestamp(now), "01.01.26 12:00 UTC");
  for (const value of [null, 0, NaN, Infinity, Number.MAX_VALUE])
    assert.equal(formatSyncTimestamp(value), "Check time unavailable");
});
