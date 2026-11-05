import test from "node:test";
import assert from "node:assert/strict";
import type { WatchedAddress } from "./ledger-store";
import {
  MAX_TOKEN_WATCHES,
  TOKEN_WATCH_STORAGE_KEY,
  createTokenWatch,
  parseTokenWatches,
  saveTokenWatches,
  serializeTokenWatches,
  tokenWatchOwner,
  type TokenWatch,
} from "./token-watch";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const owner: WatchedAddress = {
  id: "owner-1",
  chain: "ethereum",
  address: address(1),
  label: "Public owner",
  addedAt: 1,
  walletId: "private-local-association",
};
const token = (n = 2, id = `token-${n}`): TokenWatch => ({
  id,
  ownerId: owner.id,
  chain: "ethereum",
  ownerAddress: owner.address,
  tokenAddress: address(n),
  label: "",
});
const envelope = (entries: unknown) => JSON.stringify({ version: 1, entries });

test("token watch configuration contains only explicit public fields and preserves IDs", () => {
  const created = createTokenWatch(
    [],
    { ownerId: owner.id, tokenAddress: address(2), label: "  Savings 🌙  " },
    [owner],
    "stable-token-id",
  );
  assert.equal(created.skipped, false);
  assert.deepEqual(created.entries, [{ ...token(2, "stable-token-id"), label: "Savings 🌙" }]);
  const serialized = serializeTokenWatches(created.entries);
  assert.deepEqual(Object.keys(JSON.parse(serialized).entries[0]), [
    "id", "ownerId", "chain", "ownerAddress", "tokenAddress", "label",
  ]);
  assert(!serialized.includes("walletId"));
  assert(!serialized.includes("private-local-association"));
  assert.deepEqual(parseTokenWatches(serialized), created.entries);
  assert.deepEqual(parseTokenWatches(null), []);
});

test("configuration refuses unknown fields rather than persisting account or wallet data", () => {
  for (const field of ["privateKey", "seed", "walletId", "accountId", "balance", "rpcUrl"]) {
    assert.throws(() => parseTokenWatches(envelope([{ ...token(), [field]: "untrusted" }])));
    assert.throws(() => serializeTokenWatches([{ ...token(), [field]: "untrusted" }]));
  }
  assert.throws(() => parseTokenWatches(JSON.stringify({ version: 1, entries: [], account: {} })));
  assert.throws(() => createTokenWatch(
    [],
    { ownerId: owner.id, tokenAddress: address(2), privateKey: "untrusted" } as never,
    [owner],
    "id",
  ));
});

test("token contracts use checksum validation before canonicalization", () => {
  const checksum = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const mixedOwner = { ...owner, address: checksum };
  const created = createTokenWatch([], {
    ownerId: owner.id,
    tokenAddress: checksum,
  }, [mixedOwner], "id");
  assert.equal(created.entries[0]!.tokenAddress, checksum.toLowerCase());
  assert.equal(created.entries[0]!.ownerAddress, checksum.toLowerCase());
  const invalidChecksum = "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  assert.throws(() => createTokenWatch([], {
    ownerId: owner.id,
    tokenAddress: invalidChecksum,
  }, [owner], "id"), /contract or mint/);
  assert.throws(() => parseTokenWatches(envelope([{ ...token(), ownerAddress: invalidChecksum }])));
  assert.throws(() => createTokenWatch([], {
    ownerId: owner.id,
    tokenAddress: address(2),
  }, [{ ...owner, address: invalidChecksum }], "id"), /public owner/);
});

test("adding duplicate canonical owner and contract skips without replacing identity or labels", () => {
  const existing = [token()];
  const result = createTokenWatch(existing, {
    ownerId: owner.id,
    tokenAddress: address(2),
    label: "Replacement label",
  }, [owner], "different-id");
  assert.equal(result.skipped, true);
  assert.deepEqual(result.entries, existing);
  assert.deepEqual(existing, [token()]);
  const alias = { ...owner, id: "same-owner-another-watch" };
  assert.equal(createTokenWatch(existing, {
    ownerId: alias.id,
    tokenAddress: address(2),
  }, [owner, alias], "different-id").skipped, true);
  assert.throws(() => createTokenWatch(existing, {
    ownerId: owner.id,
    tokenAddress: address(3),
  }, [owner], existing[0]!.id), /identifier/);
});

test("token limit is bounded and duplicates do not consume capacity", () => {
  const full = Array.from({ length: MAX_TOKEN_WATCHES }, (_, n) => token(n + 2));
  assert.equal(createTokenWatch(full, {
    ownerId: owner.id,
    tokenAddress: address(2),
  }, [owner], "duplicate").skipped, true);
  assert.throws(() => createTokenWatch(full, {
    ownerId: owner.id,
    tokenAddress: address(100),
  }, [owner], "new"), /50/);
  assert.throws(() => parseTokenWatches(envelope([...full, token(100)])), /50/);
  assert.throws(() => parseTokenWatches(envelope([token(), token()])), /duplicate/);
});

test("only existing Ethereum mainnet and Solana owners can create token watches", () => {
  for (const unavailable of [[], [{ ...owner, id: "other" }], [{ ...owner, chain: "base" as const }]]) {
    assert.throws(() => createTokenWatch([], {
      ownerId: owner.id,
      tokenAddress: address(2),
    }, unavailable, "id"), /watched Ethereum or Solana/);
  }
  const solOwner: WatchedAddress = {
    ...owner,
    id: "sol-owner",
    chain: "solana",
    address: "11111111111111111111111111111111",
  };
  const mint = "So11111111111111111111111111111111111111112";
  const created = createTokenWatch([], { ownerId: solOwner.id, tokenAddress: mint }, [solOwner], "spl");
  assert.equal(created.entries[0]!.chain, "solana");
  assert.equal(created.entries[0]!.tokenAddress, mint);
  assert.throws(() => createTokenWatch([], {
    ownerId: solOwner.id,
    tokenAddress: address(2),
  }, [solOwner], "id"), /contract or mint/);
});

test("owner lookup requires the same watch ID, network, and canonical address", () => {
  const entry = token();
  assert.equal(tokenWatchOwner(entry, [owner]), owner);
  assert.equal(tokenWatchOwner(entry, []), null);
  assert.equal(tokenWatchOwner(entry, [{ ...owner, id: "new-id" }]), null);
  assert.equal(tokenWatchOwner(entry, [{ ...owner, chain: "base" }]), null);
  assert.equal(tokenWatchOwner(entry, [{ ...owner, address: address(3) }]), null);
  assert.equal(tokenWatchOwner(entry, [{ ...owner, address: "invalid" }]), null);
  const checksum = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const checksumOwner = { ...owner, address: checksum };
  assert.equal(tokenWatchOwner({ ...entry, ownerAddress: checksum.toLowerCase() }, [checksumOwner]), checksumOwner);
});

test("invalid, oversized, and unsupported saved configuration fails without partial recovery", () => {
  assert.throws(() => parseTokenWatches("{"), /could not be read/);
  assert.throws(() => parseTokenWatches(" ".repeat(65_537)), /too large/);
  assert.throws(() => parseTokenWatches(JSON.stringify({ version: 2, entries: [] })), /unsupported/);
  assert.throws(() => parseTokenWatches(envelope([token(), { ...token(3), tokenAddress: "bad" }])));
  assert.throws(() => parseTokenWatches(envelope([{ ...token(), id: "" }])));
  assert.throws(() => parseTokenWatches(envelope([{ ...token(), ownerId: "x".repeat(121) }])));
  assert.throws(() => parseTokenWatches(envelope([{ ...token(), id: "bad\nid" }])));
  assert.throws(() => parseTokenWatches(envelope([{ ...token(), label: "x".repeat(65) }])));
  assert.throws(() => parseTokenWatches(envelope([{ ...token(), label: "bad\nlabel" }])));
  assert.throws(() => parseTokenWatches(envelope([{ ...token(), chain: "base" }])));
  assert.throws(() => serializeTokenWatches(new Array<TokenWatch>(1)));
  assert.throws(() => createTokenWatch([], {
    ownerId: owner.id,
    tokenAddress: address(2),
    label: null,
  } as never, [owner], "id"), /Token labels/);
});

test("persistence validates first and surfaces storage failure before callers change state", () => {
  let savedKey = "";
  let savedValue = "";
  const storage = {
    setItem(key: string, value: string) {
      savedKey = key;
      savedValue = value;
    },
  };
  saveTokenWatches(storage, [token()]);
  assert.equal(savedKey, TOKEN_WATCH_STORAGE_KEY);
  assert.deepEqual(parseTokenWatches(savedValue), [token()]);
  let entries = [token()];
  const next = createTokenWatch(entries, {
    ownerId: owner.id,
    tokenAddress: address(3),
  }, [owner], "next").entries;
  assert.throws(() => {
    saveTokenWatches({ setItem() { throw new Error("Storage full"); } }, next);
    entries = next;
  }, /Storage full/);
  assert.deepEqual(entries, [token()]);
  assert.throws(() => saveTokenWatches(storage, [{ ...token(), label: "x".repeat(65) }]));
  assert.deepEqual(parseTokenWatches(savedValue), [token()]);
});
