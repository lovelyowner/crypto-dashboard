import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createJSONStorage } from "zustand/middleware";
import type { WatchedAddress, LocalWallet } from "./ledger-store";

let ledger: (typeof import("./ledger-store"))["useLedger"];
let fallbackStorage: Storage | undefined;
before(async () => {
  // Shared-process suites may install another storage while the store import is resolving.
  // Delegate to that replacement instead of capturing an obsolete test-only backing map.
  if (!("localStorage" in globalThis)) {
    const data = new Map<string, string>();
    fallbackStorage = {
      get length() {
        return data.size;
      },
      key: (index) => [...data.keys()][index] ?? null,
      clear: () => {
        data.clear();
      },
      getItem: (name) =>
        globalThis.localStorage === fallbackStorage
          ? (data.get(name) ?? null)
          : globalThis.localStorage.getItem(name),
      setItem: (name, value) => {
        if (globalThis.localStorage === fallbackStorage) data.set(name, value);
        else globalThis.localStorage.setItem(name, value);
      },
      removeItem: (name) => {
        if (globalThis.localStorage === fallbackStorage) data.delete(name);
        else globalThis.localStorage.removeItem(name);
      },
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: fallbackStorage,
    });
  }
  ledger = (await import("./ledger-store")).useLedger;
});
after(() => {
  if (fallbackStorage && globalThis.localStorage === fallbackStorage)
    Reflect.deleteProperty(globalThis, "localStorage");
});

const publicAddress = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const watch = (n: number, extra: Partial<WatchedAddress> = {}): WatchedAddress => ({
  id: `watch-${n}`,
  chain: "ethereum",
  address: publicAddress(n),
  label: `Address ${n}`,
  addedAt: n,
  ...extra,
});
const wallet: LocalWallet = {
  id: "wallet-1",
  label: "Local wallet",
  createdAt: 1,
  custody: "device",
  addresses: {
    bitcoin: "not used by these store tests",
    ethereum: publicAddress(1),
    solana: "not used",
  },
  encrypted: {
    kdf: "pbkdf2",
    ciphertext: "unchanged-encrypted-data",
    salt: "unchanged-salt",
    iv: "unchanged-iv",
    iterations: 600000,
  },
};

async function withStore(
  entries: WatchedAddress[],
  wallets: LocalWallet[],
  run: (storage: {
    reject: () => void;
    saved: () => string | undefined;
    writes: () => number;
  }) => void | Promise<void>,
) {
  const oldState = ledger.getState();
  const oldStorage = ledger.persist.getOptions().storage;
  const values = new Map<string, string>();
  let reject = false;
  let writes = 0;
  const storage = createJSONStorage<unknown>(() => ({
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      if (reject) throw new Error("Browser storage is full");
      writes += 1;
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  }));
  ledger.persist.setOptions({ storage });
  ledger.setState({ watched: entries, wallets, hydrated: true });
  writes = 0;
  try {
    await run({
      reject: () => {
        reject = true;
      },
      saved: () => values.get("fathom.ledger.v1"),
      writes: () => writes,
    });
  } finally {
    reject = false;
    ledger.setState(oldState);
    ledger.persist.setOptions({ storage: oldStorage });
  }
}

test("bulk removal deduplicates selection, ignores missing IDs and changes only public watches once", async () => {
  await withStore([watch(1, { walletId: wallet.id }), watch(2), watch(3)], [wallet], (storage) => {
    const walletsBefore = ledger.getState().wallets;
    const result = ledger
      .getState()
      .removeWatchedBatch(["watch-1", "watch-1", "missing", "watch-3"]);
    assert.equal(result.error, null);
    assert.deepEqual(
      result.removed.map((entry) => entry.id),
      ["watch-1", "watch-3"],
    );
    assert.deepEqual(
      ledger.getState().watched.map((entry) => entry.id),
      ["watch-2"],
    );
    assert.equal(ledger.getState().wallets, walletsBefore);
    assert.equal(ledger.getState().wallets[0]!.encrypted, wallet.encrypted);
    assert.equal(storage.writes(), 1);
    assert.equal(ledger.getState().removeWatchedBatch([]).error, null);
    assert.equal(storage.writes(), 1);
    const before = ledger.getState().watched;
    assert.match(ledger.getState().removeWatchedBatch(["watch-2", " "]).error!, /valid addresses/);
    assert.equal(ledger.getState().watched, before);
    assert.equal(ledger.getState().removeWatched("watch-2"), null);
    assert.equal(ledger.getState().watched.length, 0);
  });
});

test("undo restores IDs, Unicode labels, pins, timestamps and existing wallet associations", async () => {
  const first = watch(1, {
    label: "冷钱包 🌙",
    pinned: true,
    addedAt: 1762185600000,
    walletId: wallet.id,
  });
  await withStore([first, watch(2)], [wallet], (storage) => {
    const result = ledger.getState().removeWatchedBatch([first.id]);
    const restored = ledger.getState().restoreWatchedBatch(result.removed);
    assert.deepEqual(restored, { restored: 1, skipped: 0, error: null });
    assert.deepEqual(ledger.getState().watched[0], first);
    assert.equal(ledger.getState().wallets[0], wallet);
    assert.deepEqual(JSON.parse(storage.saved()!).state.watched[0], first);
  });
});

test("undo skips duplicate IDs or normalized addresses without replacing current edits", async () => {
  const checksum = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  await withStore(
    [watch(1, { address: checksum.toLowerCase(), label: "Current label" })],
    [],
    (storage) => {
      const result = ledger
        .getState()
        .restoreWatchedBatch([
          watch(2, { address: checksum }),
          watch(1, { label: "Old label" }),
          watch(3),
          watch(3),
        ]);
      assert.deepEqual(result, { restored: 1, skipped: 3, error: null });
      assert.equal(ledger.getState().watched.length, 2);
      assert.equal(
        ledger.getState().watched.find((entry) => entry.id === "watch-1")!.label,
        "Current label",
      );
      assert.equal(storage.writes(), 1);
    },
  );
});

test("restoring after wallet deletion keeps only the public watch and never recreates keys", async () => {
  await withStore([], [], () => {
    const result = ledger.getState().restoreWatchedBatch([watch(1, { walletId: wallet.id })]);
    assert.deepEqual(result, { restored: 1, skipped: 0, error: null });
    assert.equal(ledger.getState().watched[0]!.walletId, undefined);
    assert.equal(ledger.getState().wallets.length, 0);
  });
});

test("invalid or over-capacity undo payloads fail atomically before storage changes", async () => {
  await withStore(
    Array.from({ length: 99 }, (_, n) => watch(n)),
    [],
    (storage) => {
      const before = ledger.getState().watched;
      assert.match(
        ledger.getState().restoreWatchedBatch([watch(100), watch(101)]).error!,
        /limit of 100/,
      );
      assert.equal(ledger.getState().watched, before);
      assert.match(
        ledger.getState().restoreWatchedBatch([watch(100), watch(101, { addedAt: NaN })]).error!,
        /invalid/,
      );
      assert.match(
        ledger.getState().restoreWatchedBatch([watch(100, { address: "bad" })]).error!,
        /public address/,
      );
      assert.equal(ledger.getState().watched, before);
      assert.equal(storage.writes(), 0);
      assert.deepEqual(ledger.getState().restoreWatchedBatch([]), {
        restored: 0,
        skipped: 0,
        error: null,
      });
    },
  );
});

test("rejected browser writes roll back removal and undo while preserving persisted wallets", async () => {
  await withStore([watch(1, { walletId: wallet.id }), watch(2)], [wallet], (storage) => {
    const before = ledger.getState().watched;
    const saved = storage.saved();
    storage.reject();
    assert.match(
      ledger.getState().removeWatchedBatch(["watch-1"]).error!,
      /No addresses were removed/,
    );
    assert.equal(ledger.getState().watched, before);
    assert.equal(storage.saved(), saved);
    assert.match(ledger.getState().removeWatched("watch-2")!, /No addresses were removed/);
    assert.match(ledger.getState().restoreWatchedBatch([watch(3)]).error!, /browser storage/);
    assert.equal(ledger.getState().watched, before);
    assert.equal(storage.saved(), saved);
    assert.equal(ledger.getState().wallets[0], wallet);
  });
});
