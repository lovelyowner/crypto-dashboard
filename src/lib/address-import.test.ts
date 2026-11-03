import test from "node:test";
import assert from "node:assert/strict";
import { base58, bech32 } from "@scure/base";
import { blake2b } from "@noble/hashes/blake2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { detectAddressCandidates, parseAddressText, resolveAddressImport } from "./address-import";

const BTC = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ETH = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const XRP = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const SOL = "11111111111111111111111111111111";
const cosmos = (prefix: string) =>
  bech32.encode(prefix, bech32.toWords(new Uint8Array(20).fill(17)));
function ss58(prefix: number) {
  const payload = Uint8Array.from([prefix, ...new Uint8Array(32).fill(123)]);
  const checksum = blake2b(Uint8Array.from([...utf8ToBytes("SS58PRE"), ...payload]), {
    dkLen: 64,
  }).slice(0, 2);
  return base58.encode(Uint8Array.from([...payload, ...checksum]));
}

test("mixed TXT detects checked public formats and keeps original line numbers and Unicode labels", () => {
  const rows = parseAddressText(
    `\uFEFF# wallets\r\n\r\n${BTC}, Genesis 🌙\r\n${SOL}\r\n${XRP}\r\n${cosmos("cosmos")}, Cosmos, long term\r\n${cosmos("osmo")}\r\n${cosmos("celestia")}\r\nalice.near`,
  );
  assert.deepEqual(
    rows.map((row) => row.suggestedChain),
    ["bitcoin", "solana", "xrp", "cosmos", "osmosis", "celestia", "near"],
  );
  assert.equal(rows[0]!.line, 3);
  assert.equal(rows[0]!.label, "Genesis 🌙");
  assert.equal(rows[3]!.label, "Cosmos, long term");
  assert.equal(resolveAddressImport(rows).length, 7);
});

test("an EVM address remains unresolved until the user explicitly selects a compatible network", () => {
  const rows = parseAddressText(`${BTC}\n${ETH}`);
  assert.equal(rows[1]!.suggestedChain, undefined);
  assert(rows[1]!.candidates.includes("ethereum"));
  assert(rows[1]!.candidates.includes("base"));
  assert.match(rows[1]!.warning!, /cannot identify the chain/);
  assert.throws(() => resolveAddressImport(rows), /Line 2: choose a network/);
  assert.equal(resolveAddressImport(rows, { 2: "base" })[1]!.chain, "base");
  assert.equal(resolveAddressImport(rows, {}, { evmChain: "bnb" })[1]!.chain, "bnb");
  assert.throws(() => resolveAddressImport(rows, { 2: "bitcoin" }), /compatible network/);
});

test("validated explicit network hints support chain IDs, tickers and common token-standard labels", () => {
  const rows = parseAddressText(
    `base:${ETH}, Base account\nETH (ERC20),${ETH}, Ethereum account\nnear:treasury\nBTC,${BTC}, Genesis`,
  );
  assert.deepEqual(
    rows.map((row) => row.suggestedChain),
    ["base", "ethereum", "near", "bitcoin"],
  );
  assert.equal(resolveAddressImport(rows)[0]!.address, ETH.toLowerCase());
  assert.equal(rows[0]!.label, "Base account");
  assert(parseAddressText(`bitcoin:${ETH}`)[0]!.error);
  assert(parseAddressText(`unknown:${BTC}`)[0]!.error);
});

test("specific SS58 prefixes select their network but generic SS58 requires explicit choice", () => {
  const rows = parseAddressText(`${ss58(0)}\n${ss58(2)}\n${ss58(42)}`);
  assert.equal(rows[0]!.suggestedChain, "polkadot");
  assert.equal(rows[1]!.suggestedChain, "kusama");
  assert.deepEqual(rows[2]!.candidates, ["polkadot", "kusama"]);
  assert.equal(rows[2]!.suggestedChain, undefined);
  assert.throws(() => resolveAddressImport(rows), /Line 3/);
  const resolved = resolveAddressImport(rows, {}, { substrateChain: "kusama" });
  assert.equal(resolved[2]!.address, ss58(2));
});

test("bare hexadecimal identifiers are never auto-added as NEAR and arbitrary names do not bypass detection", () => {
  const value = "a".repeat(64);
  const row = parseAddressText(value)[0]!;
  assert.deepEqual(row.candidates, ["near"]);
  assert.equal(row.suggestedChain, undefined);
  assert.match(row.warning!, /never a private key/);
  assert.throws(() => resolveAddressImport([row]), /choose a network/);
  assert.equal(resolveAddressImport([row], { 1: "near" })[0]!.chain, "near");
  assert(parseAddressText("ordinarytext")[0]!.error);
  assert.deepEqual(detectAddressCandidates(SOL), ["solana"]);
  assert(parseAddressText(`${BTC.slice(0, -1)}b`)[0]!.error);
  assert(parseAddressText(`0x${"a".repeat(64)}`)[0]!.error);
});

test("invalid rows, excessive files, and long labels fail before any import result can be used", () => {
  const rows = parseAddressText(`${BTC}\nnot an address`);
  assert.throws(() => resolveAddressImport(rows), /Line 2: fix the invalid entry/);
  assert.equal(rows[1]!.error?.includes("not an address"), false);
  assert(parseAddressText(`${BTC},${"x".repeat(81)}`)[0]!.error);
  assert.throws(() => parseAddressText(" \n# comments"), /does not contain/);
  assert.throws(() => parseAddressText(Array.from({ length: 101 }, () => BTC).join("\n")), /100/);
  assert.throws(() => parseAddressText("x".repeat(200001)), /200 KB/);
  assert.throws(() => parseAddressText("🌙".repeat(60000)), /200 KB/);
  assert.throws(() => resolveAddressImport([]), /Choose a text file/);
});
