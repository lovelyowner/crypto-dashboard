import assert from "node:assert/strict";
import test from "node:test";
import { bech32 } from "@scure/base";
import {
  collectProfileWalletOptions,
  planProfileWalletSelection,
  type ProfileWalletOption,
} from "./profile-wallet-options";
import type { DonationAddress } from "./creator-profile";

const ETH = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const BTC = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const SOL = "11111111111111111111111111111111";
const XRP = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const COSMOS = bech32.encode("cosmos", bech32.toWords(new Uint8Array(20).fill(17)));
const wallet = () => ({
  label: "Мой кошелёк 🌙",
  addresses: {
    bitcoin: BTC,
    ethereum: ETH,
    solana: SOL,
    cosmos: COSMOS,
    xrp: XRP,
    near: "a".repeat(64),
  },
});
const option = (chain: "ethereum" | "base", address = ETH): ProfileWalletOption => ({
  key: "untrusted-input-key",
  chain,
  address,
  label: "Receiving account 🌙",
  source: "watchlist",
});

test("picker reads only public wallet fields and maps the six actually derived networks", () => {
  const source = wallet();
  for (const secret of ["encrypted", "recoveryWords", "privateKey", "vaultId", "custody", "id"]) {
    Object.defineProperty(source, secret, {
      enumerable: true,
      get() {
        throw new Error(`Private field ${secret} was read`);
      },
    });
  }
  Object.defineProperty(source.addresses, "privateKey", {
    enumerable: true,
    get() {
      throw new Error("Unrecognized address field was read");
    },
  });
  const choices = collectProfileWalletOptions([source], []);
  assert.deepEqual(
    choices.map((choice) => choice.chain),
    ["bitcoin", "ethereum", "solana", "cosmos", "xrp", "near"],
  );
  assert.equal(choices.length, 6);
  assert.ok(choices.every((choice) => choice.label === source.label && choice.source === "wallet"));
  assert.equal(choices.find((choice) => choice.chain === "ethereum")?.address, ETH.toLowerCase());
  assert.ok(
    choices.every(
      (choice) => Object.keys(choice).sort().join(",") === "address,chain,key,label,source",
    ),
  );
});

test("workspace choices normalize same-network duplicates while keeping explicit EVM networks distinct", () => {
  const choices = collectProfileWalletOptions(
    [wallet(), wallet()],
    [
      { chain: "ethereum", address: ETH.toLowerCase(), label: "Watched duplicate" },
      { chain: "base", address: ETH.toLowerCase(), label: "Base receiving address" },
      { chain: "base", address: ETH, label: "Another duplicate" },
      { chain: "bitcoin", address: "bad checksum", label: "Invalid" },
      { chain: "unknown", address: ETH, label: "Invalid network" },
    ],
  );
  assert.equal(choices.length, 7);
  const ethereum = choices.find((choice) => choice.chain === "ethereum")!;
  assert.equal(ethereum.source, "wallet-and-watchlist");
  assert.equal(ethereum.label, "Мой кошелёк 🌙");
  assert.equal(choices.find((choice) => choice.chain === "base")?.source, "watchlist");
  assert.notEqual(ethereum.key, choices.find((choice) => choice.chain === "base")?.key);
});

test("corrupt public entries are skipped and copied labels preserve meaningful Unicode without concealed controls", () => {
  const invalidWallet = {
    label: "Invalid",
    addresses: { ethereum: "0xnot-an-address", solana: "bad" },
  };
  const choices = collectProfileWalletOptions(
    [invalidWallet, { label: "  Мир 🌙\n\u202ehidden  ", addresses: { ethereum: ETH } }],
    [{ chain: "bitcoin", address: BTC, label: "🌙".repeat(100) }],
  );
  assert.equal(choices.length, 2);
  assert.equal(choices[0].label, "Мир 🌙hidden");
  assert.equal([...choices[1].label].length, 80);
  assert.deepEqual(collectProfileWalletOptions([], []), []);
});

test("selection copies only validated receiving fields and does not mutate source or existing draft", () => {
  const existing: DonationAddress[] = [
    { id: "existing", chain: "ethereum", address: ETH.toLowerCase(), label: "Existing" },
  ];
  const selected = [
    { ...option("ethereum"), walletId: "must-not-copy", encrypted: "must-not-copy" },
    { ...option("base"), accountId: "must-not-copy", key: "not-a-trusted-key" },
    option("base"),
  ];
  const before = structuredClone({ existing, selected });
  const result = planProfileWalletSelection(existing, selected);
  assert.deepEqual(result, {
    fresh: [{ chain: "base", address: ETH.toLowerCase(), label: "Receiving account 🌙" }],
    skipped: 2,
  });
  assert.deepEqual({ existing, selected }, before);
  assert.doesNotMatch(JSON.stringify(result), /must-not-copy|source|walletId|accountId|encrypted/);
});

test("selection validates every entry and enforces profile capacity atomically after duplicate removal", () => {
  const existing: DonationAddress[] = Array.from({ length: 9 }, (_, index) => ({
    id: `existing-${index}`,
    chain: "ethereum",
    address: `0x${String(index + 1).padStart(40, "0")}`,
    label: "Existing",
  }));
  const before = structuredClone(existing);
  assert.throws(
    () => planProfileWalletSelection(existing, [option("base"), option("ethereum")]),
    /10-address/,
  );
  assert.deepEqual(existing, before);
  assert.equal(
    planProfileWalletSelection(existing, [option("base"), option("base")]).fresh.length,
    1,
  );
  assert.throws(
    () =>
      planProfileWalletSelection(existing, [
        option("base"),
        { ...option("ethereum"), address: "not valid" },
      ]),
    /Donation address/,
  );
  assert.throws(
    () => planProfileWalletSelection(existing, [{ ...option("base"), label: "bad\u0000label" }]),
    /Donation label/,
  );
  assert.throws(() => planProfileWalletSelection(existing, []), /Choose at least/);
  assert.deepEqual(existing, before);
});

test("an unfinished manually entered row remains untouched while a valid saved address can be added", () => {
  const existing: DonationAddress[] = [
    { id: "unfinished", chain: "ethereum", address: "", label: "" },
  ];
  const result = planProfileWalletSelection(existing, [option("ethereum")]);
  assert.equal(result.fresh.length, 1);
  assert.equal(existing[0].address, "");
  assert.equal(existing[0].id, "unfinished");
});
