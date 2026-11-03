import test from "node:test";
import assert from "node:assert/strict";
import { activityKey } from "./chains";
import {
  filterTransactions,
  transactionsCsv,
  transactionTimeIso,
  type ExplorerTransaction,
  type TransactionWatch,
} from "./transactions";

const now = Date.UTC(2026, 10, 3, 12);
const hour = 60 * 60 * 1000;
const day = 24 * hour;
const first = "0x0000000000000000000000000000000000000001";
const second = "0x0000000000000000000000000000000000000002";
const btc = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const watches: TransactionWatch[] = [
  { chain: "ethereum", address: first, label: "Long term 🪐" },
  { chain: "ethereum", address: second, label: "Trading" },
  { chain: "base", address: first, label: "Layer two" },
  { chain: "bitcoin", address: btc, label: "Genesis" },
];
function row(patch: Partial<ExplorerTransaction>): ExplorerTransaction {
  return {
    id: "recent",
    chain: "ethereum",
    address: first,
    hash: "hash-recent",
    time: now - hour,
    direction: "in",
    amount: "0.123456789012345678",
    symbol: "ETH",
    counterparty: "0xOtherReceiver",
    status: "ok",
    ...patch,
  };
}
const transactions = [
  row({ counterparty: "0xBridgeReceiver" }),
  row({
    id: "failed",
    address: second,
    hash: "hash-failed",
    time: now - 8 * day,
    direction: "out",
    status: "failed",
  }),
  row({
    id: "pending",
    chain: "bitcoin",
    address: btc,
    hash: "hash-pending",
    time: 0,
    direction: "out",
    symbol: "BTC",
    status: "pending",
  }),
  row({ id: "base", chain: "base", hash: "hash-base", time: now - 2 * day, direction: "self" }),
];

test("transaction filters combine network, canonical watched address, direction, and status", () => {
  assert.deepEqual(
    filterTransactions(
      transactions,
      watches,
      {
        network: "ethereum",
        address: activityKey("ethereum", second),
        direction: "out",
        status: "failed",
      },
      now,
    ).map((tx) => tx.id),
    ["failed"],
  );
  assert.equal(
    filterTransactions(
      transactions,
      watches,
      { address: activityKey("base", first), status: "failed" },
      now,
    ).length,
    0,
  );
  assert.deepEqual(
    filterTransactions(transactions, watches, { status: "pending" }, now).map((tx) => tx.id),
    ["pending"],
  );
});

test("search includes full hash, counterparty, public address, label, asset and chain", () => {
  for (const search of ["HASH-RECENT", "bridgereceiver", "long term 🪐"]) {
    assert.deepEqual(
      filterTransactions(transactions, watches, { search }, now).map((tx) => tx.id),
      ["recent"],
    );
  }
  assert.deepEqual(
    filterTransactions(transactions, watches, { search: " layer TWO " }, now).map((tx) => tx.id),
    ["base"],
  );
  assert.deepEqual(
    filterTransactions(transactions, watches, { search: second }, now).map((tx) => tx.id),
    ["failed"],
  );
  assert.deepEqual(
    filterTransactions(transactions, watches, { search: "bitcoin" }, now).map((tx) => tx.id),
    ["pending"],
  );
  assert.deepEqual(
    filterTransactions(transactions, watches, { search: "BTC" }, now).map((tx) => tx.id),
    ["pending"],
  );
  assert.equal(
    filterTransactions(transactions, watches, { search: "does not exist" }, now).length,
    0,
  );
});

test("bounded time windows include boundaries but exclude unknown, future and invalid timestamps", () => {
  const mixed = [
    ...transactions,
    row({ id: "boundary", time: now - 7 * day }),
    row({ id: "future", time: now + 1 }),
    row({ id: "invalid", time: NaN }),
  ];
  assert.deepEqual(
    filterTransactions(mixed, watches, { range: "24h" }, now).map((tx) => tx.id),
    ["recent"],
  );
  assert.deepEqual(
    filterTransactions(mixed, watches, { range: "7d" }, now).map((tx) => tx.id),
    ["recent", "base", "boundary"],
  );
  assert.deepEqual(
    filterTransactions(transactions, watches, { range: "30d" }, now).map((tx) => tx.id),
    ["recent", "base", "failed"],
  );
  assert(
    filterTransactions(transactions, watches, { range: "all" }, now).some(
      (tx) => tx.id === "pending",
    ),
  );
});

test("filtering sorts recent rows without mutating the fetched input", () => {
  const ids = transactions.map((tx) => tx.id);
  assert.deepEqual(
    filterTransactions(transactions, watches, {}, now).map((tx) => tx.id),
    ["recent", "base", "failed", "pending"],
  );
  assert.deepEqual(
    transactions.map((tx) => tx.id),
    ids,
  );
});

test("CSV exports exactly the filtered rows with exact amounts and formula-safe labels", () => {
  const csvWatches = watches.map((watch) =>
    watch.chain === "bitcoin" ? { ...watch, label: '=HYPERLINK("bad")' } : watch,
  );
  const filtered = filterTransactions(transactions, csvWatches, { status: "pending" }, now);
  const csv = transactionsCsv(filtered, csvWatches);
  assert.equal(csv.split("\r\n").length, 2);
  assert(csv.includes('"hash-pending"'));
  assert(!csv.includes('"hash-recent"'));
  assert(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert(csv.includes('"Unconfirmed"'));
  assert(csv.includes('"pending"'));
  const recentCsv = transactionsCsv([transactions[0]], watches);
  assert(recentCsv.includes('"0.123456789012345678"'));
  assert(recentCsv.includes(new Date(now - hour).toISOString()));
  assert(recentCsv.includes('"Date (dd.mm.yy, UTC)"'));
  assert(recentCsv.includes('"Timestamp (UTC)"'));
  assert(recentCsv.includes('"03.11.26"'));
  assert(recentCsv.includes('"Ethereum · ETH (ERC20)"'));
});

test("invalid provider timestamps cannot crash transaction rendering or CSV export", () => {
  for (const time of [NaN, Infinity, -1, 0, Number.MAX_VALUE]) {
    assert.equal(transactionTimeIso(time), undefined);
    assert(transactionsCsv([row({ time })], watches).includes('"Unconfirmed"'));
  }
  assert.equal(transactionTimeIso(now), new Date(now).toISOString());
});
