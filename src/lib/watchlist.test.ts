import test from "node:test";
import assert from "node:assert/strict";
import { parseAddressLines, planWatchBatch } from "./watchlist";
import type { WatchedAddress, LocalWallet } from "./ledger-store";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const input = (n: number) => ({ chain: "ethereum" as const, address: address(n), label: "" });
const watched = (n: number): WatchedAddress => ({ ...input(n), id: `watch-${n}`, addedAt: n });

test("bulk text accepts public addresses and optional Unicode labels without changing order", () => {
  assert.deepEqual(
    parseAddressLines(`\n${address(1)},  Savings 🌙, long term \r\n\n${address(2)}\n`, "ethereum"),
    [{ ...input(1), label: "Savings 🌙, long term" }, input(2)],
  );
  assert.throws(() => parseAddressLines(" \n", "ethereum"), /at least one/);
  assert.throws(
    () => parseAddressLines(`${address(1)}\nthis is not an address`, "ethereum"),
    /Line 2/,
  );
  assert.throws(
    () =>
      parseAddressLines(Array.from({ length: 101 }, (_, n) => address(n)).join("\n"), "ethereum"),
    /100/,
  );
  assert.throws(() => parseAddressLines(`${address(1)},${"x".repeat(81)}`, "ethereum"), /Line 1/);
  assert.throws(() => parseAddressLines("0x" + "a".repeat(64), "ethereum"), /public address/);
});

test("batch planning normalizes addresses, skips duplicates, and keeps networks distinct", () => {
  const checksum = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const result = planWatchBatch(
    [{ chain: "ethereum", address: checksum }],
    [
      { chain: "ethereum", address: checksum.toLowerCase(), label: "Existing" },
      { chain: "base", address: checksum, label: "  Other network  " },
      { chain: "base", address: checksum.toLowerCase(), label: "Duplicate in batch" },
    ],
  );
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.fresh, [
    { chain: "base", address: checksum.toLowerCase(), label: "Other network" },
  ]);
  assert.equal(
    planWatchBatch(
      Array.from({ length: 100 }, (_, n) => watched(n)),
      [input(0)],
    ).skipped,
    1,
  );
});

const storage = new Map<string, string>();
let rejectStorageWrites = false;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => {
      if (rejectStorageWrites) throw new Error("Storage capacity exceeded");
      storage.set(name, value);
    },
    removeItem: (name: string) => {
      storage.delete(name);
    },
  },
});
const { useLedger } = await import("./ledger-store");
function reset(entries: WatchedAddress[] = []) {
  useLedger.setState({ watched: entries, wallets: [], hydrated: true });
}

test("invalid and overflowing batches leave the complete existing workspace unchanged", () => {
  reset([watched(0)]);
  const before = useLedger.getState().watched;
  const invalid = useLedger
    .getState()
    .addWatchedBatch([input(1), { ...input(2), address: "bad address" }]);
  assert.equal(invalid.added, 0);
  assert.match(invalid.error!, /Entry 2/);
  assert.equal(useLedger.getState().watched, before);
  reset(Array.from({ length: 99 }, (_, n) => watched(n)));
  const nearlyFull = useLedger.getState().watched;
  const overflow = useLedger.getState().addWatchedBatch([input(100), input(101)]);
  assert.match(overflow.error!, /exceed/);
  assert.equal(useLedger.getState().watched, nearlyFull);
});

test("batch addition performs one persisted update and reports only actual additions", () => {
  reset([watched(0)]);
  let updates = 0;
  const unsubscribe = useLedger.subscribe(() => {
    updates += 1;
  });
  try {
    const result = useLedger.getState().addWatchedBatch([input(0), input(1), input(1), input(2)]);
    assert.deepEqual(result, { added: 2, skipped: 2, error: null });
    assert.equal(updates, 1);
    assert.equal(new Set(useLedger.getState().watched.map((row) => row.id)).size, 3);
    const persisted = JSON.parse(storage.get("fathom.ledger.v1")!);
    assert.equal(persisted.state.watched.length, 3);
    assert.deepEqual(
      useLedger.getState().watched.map((row) => row.address),
      [address(1), address(2), address(0)],
    );
  } finally {
    unsubscribe();
  }
});

test("single-address addition retains its duplicate-error contract and normalizes labels", () => {
  reset();
  assert.equal(useLedger.getState().addWatched({ ...input(1), label: "  Savings 🌙  " }), null);
  assert.equal(useLedger.getState().watched[0]!.label, "Savings 🌙");
  assert.match(useLedger.getState().addWatched(input(1))!, /Already watching/);
  const before = useLedger.getState().watched;
  assert.match(useLedger.getState().addWatched({ ...input(2), label: "x".repeat(81) })!, /80/);
  assert.equal(useLedger.getState().watched, before);
});

test("label editing and pinning preserve identity, wallet association, and encryption", () => {
  reset([{ ...watched(0), walletId: "wallet-1" }]);
  const wallet = {
    id: "wallet-1",
    label: "Local wallet",
    createdAt: 1,
    custody: "device",
    addresses: { bitcoin: "unused in this store test", ethereum: address(0), solana: "unused" },
    encrypted: null,
  } satisfies LocalWallet;
  useLedger.getState().addWallet(wallet);
  assert.equal(useLedger.getState().updateWatchedLabel("watch-0", "  冷钱包 🌙  "), null);
  assert.equal(useLedger.getState().togglePinned("watch-0"), null);
  assert.deepEqual(useLedger.getState().watched[0], {
    ...watched(0),
    walletId: "wallet-1",
    label: "冷钱包 🌙",
    pinned: true,
  });
  assert.equal(useLedger.getState().wallets[0], wallet);
  assert.match(useLedger.getState().updateWatchedLabel("watch-0", "x".repeat(81))!, /80/);
  assert.equal(useLedger.getState().watched[0]!.label, "冷钱包 🌙");
  assert.equal(useLedger.getState().togglePinned("watch-0"), null);
  assert.equal(useLedger.getState().watched[0]!.pinned, false);
  assert.match(useLedger.getState().updateWatchedLabel("missing", "x")!, /no longer/);
  const beforeMissing = useLedger.getState().watched;
  assert.match(useLedger.getState().togglePinned("missing")!, /no longer/);
  assert.equal(useLedger.getState().watched, beforeMissing);
});

test("storage write failures roll back batch additions, label edits, and pins", () => {
  reset([watched(0)]);
  const before = useLedger.getState().watched;
  const saved = storage.get("fathom.ledger.v1");
  rejectStorageWrites = true;
  try {
    const result = useLedger.getState().addWatchedBatch([input(1), input(2)]);
    assert.equal(result.added, 0);
    assert.match(result.error!, /Could not save/);
    assert.equal(useLedger.getState().watched, before);
    assert.equal(storage.get("fathom.ledger.v1"), saved);
    assert.match(
      useLedger.getState().updateWatchedLabel("watch-0", "Unsaved label")!,
      /Could not save/,
    );
    assert.equal(useLedger.getState().watched, before);
    assert.match(useLedger.getState().togglePinned("watch-0")!, /Could not save/);
    assert.equal(useLedger.getState().watched, before);
    assert.equal(storage.get("fathom.ledger.v1"), saved);
    assert.equal(useLedger.getState().watched[0]!.pinned, undefined);
  } finally {
    rejectStorageWrites = false;
  }
});
