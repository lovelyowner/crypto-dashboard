import test from "node:test";
import assert from "node:assert/strict";
import { base58 } from "@scure/base";
import { isValidAddress } from "./chains";
import type { WatchedAddress } from "./ledger-store";
import type { TokenWatch } from "./token-watch";
import {
  exportTokenWatchBackup,
  MAX_TOKEN_BACKUP_BYTES,
  planTokenWatchImport,
} from "./token-watch-backup";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const owner: WatchedAddress = {
  id: "current-owner-id",
  chain: "ethereum",
  address: address(1),
  label: "Current public owner",
  addedAt: 1,
  walletId: "local-wallet-association",
};
const token = (n = 2, id = `existing-token-${n}`): TokenWatch => ({
  id,
  ownerId: owner.id,
  chain: "ethereum",
  ownerAddress: owner.address,
  tokenAddress: address(n),
  label: `Existing ${n}`,
});
const publicRow = (n = 2) => ({
  chain: "ethereum",
  ownerAddress: owner.address,
  tokenAddress: address(n),
  label: `Imported ${n}`,
});
const backup = (entries: unknown) =>
  JSON.stringify({
    version: 1,
    kind: "fathom-public-token-watches",
    entries,
  });

function countUuid<T>(run: (count: () => number) => T): T {
  const cryptoObject = globalThis.crypto;
  const descriptor = Object.getOwnPropertyDescriptor(cryptoObject, "randomUUID");
  let calls = 0;
  Object.defineProperty(cryptoObject, "randomUUID", {
    configurable: true,
    value: () => `00000000-0000-4000-8000-${String(++calls).padStart(12, "0")}`,
  });
  try {
    return run(() => calls);
  } finally {
    if (descriptor) Object.defineProperty(cryptoObject, "randomUUID", descriptor);
    else Reflect.deleteProperty(cryptoObject, "randomUUID");
  }
}

test("token backup export contains only portable public fields, never local identity or balances", () => {
  const entries = [token()];
  const before = structuredClone(entries);
  const raw = exportTokenWatchBackup(entries);
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed).sort(), ["entries", "kind", "version"]);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.kind, "fathom-public-token-watches");
  assert.deepEqual(parsed.entries, [{ ...publicRow(), label: token().label }]);
  assert.deepEqual(Object.keys(parsed.entries[0]).sort(), [
    "chain",
    "label",
    "ownerAddress",
    "tokenAddress",
  ]);
  assert.doesNotMatch(
    raw,
    /existing-token|current-owner-id|walletId|accountId|rawAmount|balance|privateKey/,
  );
  assert.deepEqual(entries, before);
  assert(new TextEncoder().encode(raw).length <= MAX_TOKEN_BACKUP_BYTES);
  assert.throws(() => exportTokenWatchBackup([{ ...token(), privateKey: "untrusted" }] as never));
});

test("import normalizes checksummed addresses and maps to the currently watched owner ID", () => {
  const checksum = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const watched = [{ ...owner, id: "replacement-current-id", address: checksum }];
  const before = structuredClone(watched);
  countUuid((count) => {
    const result = planTokenWatchImport(
      backup([
        {
          chain: "ethereum",
          ownerAddress: checksum,
          tokenAddress: checksum,
          label: "  Restored 🌙  ",
        },
      ]),
      [],
      watched,
    );
    assert.equal(result.added, 1);
    assert.equal(result.duplicates, 0);
    assert.equal(result.unmatched, 0);
    assert.equal(count(), 1);
    assert.deepEqual(result.entries, [
      {
        id: "00000000-0000-4000-8000-000000000001",
        ownerId: "replacement-current-id",
        chain: "ethereum",
        ownerAddress: checksum.toLowerCase(),
        tokenAddress: checksum.toLowerCase(),
        label: "Restored 🌙",
      },
    ]);
  });
  assert.deepEqual(watched, before);
});

test("import skips canonical duplicates without overwriting existing IDs, owner links or labels", () => {
  const existing = [{ ...token(), ownerId: "orphaned-old-owner-id" }];
  const before = structuredClone(existing);
  countUuid((count) => {
    const result = planTokenWatchImport(
      backup([
        { ...publicRow(), label: "Do not overwrite" },
        publicRow(3),
        { ...publicRow(3), label: "Duplicate in file" },
      ]),
      existing,
      [owner],
    );
    assert.equal(result.added, 1);
    assert.equal(result.duplicates, 2);
    assert.equal(result.unmatched, 0);
    assert.equal(count(), 1);
    assert.deepEqual(result.entries.slice(0, existing.length), before);
    assert.equal(result.entries[1]!.tokenAddress, address(3));
    assert.equal(result.entries[1]!.ownerId, owner.id);
    assert.equal(result.entries[1]!.label, "Imported 3");
  });
  assert.deepEqual(existing, before);
});

test("repeated unmatched rows deduplicate first and never add or alter public owners", () => {
  const absent = address(99);
  const watched = [{ ...owner }];
  const before = structuredClone(watched);
  countUuid((count) => {
    const result = planTokenWatchImport(
      backup([
        { ...publicRow(), ownerAddress: absent },
        { ...publicRow(), ownerAddress: absent, label: "Same unmatched token" },
        { ...publicRow(3), ownerAddress: absent },
      ]),
      [],
      watched,
    );
    assert.deepEqual(result, { entries: [], added: 0, duplicates: 1, unmatched: 2 });
    assert.equal(count(), 0);
  });
  assert.deepEqual(watched, before);
  assert.deepEqual(
    planTokenWatchImport(
      backup([publicRow()]),
      [],
      [
        {
          ...owner,
          chain: "base",
        },
      ],
    ),
    { entries: [], added: 0, duplicates: 0, unmatched: 1 },
  );
});

test("Solana owners and mints retain case and distinct case-sensitive addresses", () => {
  const ownerAddress = base58.encode(new Uint8Array(32).fill(1));
  const tokenAddress = base58.encode(new Uint8Array(32).fill(2));
  const changeCase = (value: string) =>
    value.replace(/[A-HJ-KM-NP-Z]/, (letter) => letter.toLowerCase());
  const differentOwner = changeCase(ownerAddress);
  const differentMint = changeCase(tokenAddress);
  assert.notEqual(differentOwner, ownerAddress);
  assert.notEqual(differentMint, tokenAddress);
  assert(isValidAddress("solana", differentOwner));
  assert(isValidAddress("solana", differentMint));
  const solOwner: WatchedAddress = {
    ...owner,
    id: "current-sol-id",
    chain: "solana",
    address: ownerAddress,
  };
  const result = planTokenWatchImport(
    backup([
      { chain: "solana", ownerAddress, tokenAddress, label: "First mint" },
      { chain: "solana", ownerAddress, tokenAddress: differentMint, label: "Distinct mint" },
      { chain: "solana", ownerAddress: differentOwner, tokenAddress, label: "Absent owner" },
    ]),
    [],
    [solOwner],
  );
  assert.equal(result.added, 2);
  assert.equal(result.duplicates, 0);
  assert.equal(result.unmatched, 1);
  assert.deepEqual(
    result.entries.map((entry) => entry.tokenAddress),
    [tokenAddress, differentMint],
  );
  assert(
    result.entries.every(
      (entry) => entry.ownerId === solOwner.id && entry.ownerAddress === ownerAddress,
    ),
  );
});

test("import rejects malformed envelopes, private or unknown fields, invalid rows and checksum errors", () => {
  const invalidRows: unknown[] = [
    null,
    [],
    { ...publicRow(), chain: "base" },
    { ...publicRow(), chain: "Ethereum" },
    { ...publicRow(), ownerAddress: "invalid" },
    { ...publicRow(), tokenAddress: "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
    { ...publicRow(), label: "x".repeat(65) },
    { ...publicRow(), label: "bad\nlabel" },
    { ...publicRow(), label: null },
    { chain: "ethereum", ownerAddress: owner.address, tokenAddress: address(2) },
    ...[
      "id",
      "ownerId",
      "walletId",
      "accountId",
      "rawAmount",
      "decimals",
      "privateKey",
      "rpcUrl",
    ].map((field) => ({ ...publicRow(), [field]: "untrusted" })),
  ];
  const invalidRaw = [
    "{",
    "null",
    "[]",
    JSON.stringify({ version: 2, kind: "fathom-public-token-watches", entries: [] }),
    JSON.stringify({ version: 1, kind: "wrong-kind", entries: [] }),
    JSON.stringify({
      version: 1,
      kind: "fathom-public-token-watches",
      entries: [],
      accountId: "untrusted",
    }),
    backup(null),
    backup({}),
    ...invalidRows.map((row) => backup([publicRow(3), row])),
  ];
  countUuid((count) => {
    for (const raw of invalidRaw) assert.throws(() => planTokenWatchImport(raw, [], [owner]));
    assert.equal(count(), 0, "validate every row before allocating any local token identity");
  });
});

test("UTF-8 file bound counts bytes and permits exactly the inclusive size limit", () => {
  assert.equal(MAX_TOKEN_BACKUP_BYTES, 65_536);
  const raw = backup([{ ...publicRow(), label: "界".repeat(64) }]);
  const bytes = new TextEncoder().encode(raw).length;
  const atLimit = raw + " ".repeat(MAX_TOKEN_BACKUP_BYTES - bytes);
  const overLimit = atLimit + " ";
  assert.equal(new TextEncoder().encode(atLimit).length, MAX_TOKEN_BACKUP_BYTES);
  assert(
    overLimit.length < MAX_TOKEN_BACKUP_BYTES,
    "multibyte label keeps code units below byte bound",
  );
  assert.equal(planTokenWatchImport(atLimit, [], [owner]).added, 1);
  countUuid((count) => {
    assert.throws(() => planTokenWatchImport(overLimit, [], [owner]));
    assert.equal(count(), 0);
  });
});

test("incoming and combined token limits reject atomically while duplicates fit a full workspace", () => {
  const full = Array.from({ length: 50 }, (_, n) => token(n + 2));
  const before = structuredClone(full);
  countUuid((count) => {
    assert.throws(() => planTokenWatchImport(backup([publicRow(100)]), full, [owner]));
    assert.throws(() =>
      planTokenWatchImport(backup(Array.from({ length: 51 }, () => publicRow())), [], [owner]),
    );
    assert.equal(count(), 0);
    const duplicate = planTokenWatchImport(backup([publicRow()]), full, [owner]);
    assert.equal(duplicate.added, 0);
    assert.equal(duplicate.duplicates, 1);
    assert.deepEqual(duplicate.entries, before);
    assert.equal(count(), 0);
    const almostFull = full.slice(0, 49);
    assert.throws(() =>
      planTokenWatchImport(backup([publicRow(100), publicRow(101)]), almostFull, [owner]),
    );
    assert.equal(count(), 0);
  });
  assert.deepEqual(full, before);
});

test("import validates existing configuration and leaves both inputs unchanged after any failure", () => {
  const existing = [token()];
  const watched = [owner];
  const beforeEntries = structuredClone(existing);
  const beforeOwners = structuredClone(watched);
  countUuid((count) => {
    assert.throws(() =>
      planTokenWatchImport(
        backup([publicRow(3), { ...publicRow(4), label: 5 }]),
        existing,
        watched,
      ),
    );
    assert.throws(() =>
      planTokenWatchImport(
        backup([publicRow(3)]),
        [{ ...token(), accountId: "untrusted" }] as never,
        watched,
      ),
    );
    assert.throws(() => planTokenWatchImport(backup([publicRow(3)]), [token(), token()], watched));
    assert.equal(count(), 0);
  });
  assert.deepEqual(existing, beforeEntries);
  assert.deepEqual(watched, beforeOwners);
});
