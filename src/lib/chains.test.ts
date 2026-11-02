import test from "node:test";
import assert from "node:assert/strict";
import { base58, bech32, bech32m } from "@scure/base";
import { blake2b } from "@noble/hashes/blake2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import {
  CHAINS,
  CHAIN_IDS,
  activityKey,
  detectFamily,
  isChainId,
  isValidAddress,
  normalizeAddress,
} from "./chains.ts";

const ETH = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

test("registry exposes capabilities and escapes explorer paths", () => {
  assert.equal(CHAIN_IDS.length, 22);
  assert.equal(CHAINS.monero.tracking, "private");
  assert.equal(CHAINS.polkadot.tracking, "balance-only");
  assert.equal(CHAINS.kusama.tracking, "balance-only");
  assert.equal(
    CHAINS.monero.addressUrl("private-address"),
    "https://www.getmonero.org/resources/user-guides/view_only.html",
  );
  assert.equal(CHAINS.bnb.tracking, "balance-only");
  assert.equal(isChainId("__proto__"), false);
  assert.equal(isChainId("cosmos"), true);
  assert.match(CHAINS.ethereum.addressUrl("a/b?x"), /a%2Fb%3Fx$/);
});

test("EVM checksum accepted and corruption rejected while network identity stays distinct", () => {
  assert.ok(isValidAddress("ethereum", ETH));
  assert.ok(isValidAddress("base", ETH.toLowerCase()));
  assert.ok(!isValidAddress("ethereum", ETH.replace("d8dA", "d8da")));
  assert.ok(!isValidAddress("ethereum", "0x" + "0".repeat(39)));
  assert.equal(normalizeAddress("ethereum", ` ${ETH} `), ETH.toLowerCase());
  assert.notEqual(activityKey("ethereum", ETH), activityKey("base", ETH));
});

test("Bitcoin validates checksums and segwit versions", () => {
  const legacy = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
  assert.ok(isValidAddress("bitcoin", legacy));
  assert.ok(!isValidAddress("bitcoin", legacy.slice(0, -1) + "b"));
  const words = bech32.toWords(new Uint8Array(20));
  const v0 = bech32.encode("bc", [0, ...words]);
  assert.ok(isValidAddress("bitcoin", v0));
  assert.ok(isValidAddress("bitcoin", v0.toUpperCase()));
  assert.ok(!isValidAddress("bitcoin", "bC" + v0.slice(2)));
  assert.ok(!isValidAddress("bitcoin", bech32m.encode("bc", [0, ...words])));
  assert.ok(
    isValidAddress("bitcoin", bech32m.encode("bc", [1, ...bech32.toWords(new Uint8Array(32))])),
  );
  assert.ok(!isValidAddress("bitcoin", bech32.encode("bc", [1, ...words])));
  assert.ok(!isValidAddress("bitcoin", bech32.encode("tb", [0, ...words])));
});

test("Cosmos networks enforce HRP and reject altered checksums", () => {
  const bytes = new Uint8Array(20).fill(17);
  for (const [chain, prefix] of [
    ["cosmos", "cosmos"],
    ["osmosis", "osmo"],
    ["celestia", "celestia"],
  ] as const) {
    const address = bech32.encode(prefix, bech32.toWords(bytes));
    assert.ok(isValidAddress(chain, address));
    assert.equal(detectFamily(address), "cosmos");
    assert.ok(!isValidAddress(chain, address.slice(0, -1) + (address.endsWith("q") ? "p" : "q")));
    assert.ok(!isValidAddress("ethereum", address));
  }
  assert.ok(!isValidAddress("osmosis", bech32.encode("cosmos", bech32.toWords(bytes))));
});

test("Solana decodes exactly 32 bytes and NEAR account grammar is bounded", () => {
  assert.ok(isValidAddress("solana", "11111111111111111111111111111111"));
  assert.ok(!isValidAddress("solana", "1111111111111111111111111111111"));
  assert.ok(!isValidAddress("solana", "0".repeat(32)));
  assert.ok(isValidAddress("near", "alice.near"));
  assert.ok(isValidAddress("near", "a".repeat(64)));
  for (const bad of ["a", "a".repeat(65), "Alice.near", "alice..near", "-alice.near", "alice@near"])
    assert.ok(!isValidAddress("near", bad), bad);
  assert.equal(detectFamily("alice.near"), "near");
  assert.equal(detectFamily("ordinarytext"), null);
});

test("XRP accepts classic account checksum and rejects damaged accounts", () => {
  const account = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
  assert.ok(isValidAddress("xrp", account));
  assert.ok(!isValidAddress("xrp", account.slice(0, -1) + "r"));
  assert.equal(detectFamily(account), "xrp");
});

function ss58(prefix: number): string {
  const payload = Uint8Array.from([prefix, ...new Uint8Array(32).fill(123)]);
  const bytes = Uint8Array.from([...utf8ToBytes("SS58PRE"), ...payload]);
  return base58.encode(Uint8Array.from([...payload, ...blake2b(bytes, { dkLen: 64 }).slice(0, 2)]));
}

test("SS58 validation uses network prefix and checksum", () => {
  const dot = ss58(0);
  const kusama = ss58(2);
  const generic = ss58(42);
  assert.ok(isValidAddress("polkadot", generic));
  assert.ok(isValidAddress("kusama", generic));
  assert.equal(normalizeAddress("polkadot", generic), dot);
  assert.equal(normalizeAddress("kusama", generic), kusama);
  assert.equal(activityKey("polkadot", generic), activityKey("polkadot", dot));
  assert.equal(activityKey("kusama", generic), activityKey("kusama", kusama));
  assert.ok(isValidAddress("polkadot", dot));
  assert.ok(isValidAddress("kusama", kusama));
  assert.ok(!isValidAddress("polkadot", kusama));
  assert.ok(!isValidAddress("kusama", dot));
  assert.ok(!isValidAddress("polkadot", dot.slice(0, -1) + (dot.endsWith("1") ? "2" : "1")));
});

function monero(version: number, integrated: boolean): string {
  const payload = Uint8Array.from([version, ...new Uint8Array(integrated ? 72 : 64).fill(17)]);
  const bytes = Uint8Array.from([...payload, ...keccak_256(payload).slice(0, 4)]);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const encodedSizes = [0, 2, 3, 5, 6, 7, 9, 10, 11];
  let result = "";
  for (let i = 0; i < bytes.length; i += 8) {
    const block = bytes.slice(i, i + 8);
    let value = 0n;
    for (const byte of block) value = value * 256n + BigInt(byte);
    let out = "";
    while (value > 0n) {
      out = alphabet[Number(value % 58n)] + out;
      value /= 58n;
    }
    result += out.padStart(encodedSizes[block.length]!, "1");
  }
  return result;
}

test("Monero checks standard, subaddress, and integrated formats without implying public tracking", () => {
  for (const address of [monero(18, false), monero(42, false), monero(19, true)]) {
    assert.ok(isValidAddress("monero", address));
    assert.equal(detectFamily(address), "monero");
    assert.ok(
      !isValidAddress("monero", address.slice(0, -1) + (address.endsWith("1") ? "2" : "1")),
    );
  }
  assert.ok(!isValidAddress("monero", monero(53, false)));
});
