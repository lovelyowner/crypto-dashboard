import test from "node:test";
import assert from "node:assert/strict";
import { bech32, base58 } from "@scure/base";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createActivityClient, formatUnits } from "./activity.functions.ts";
import type { ChainId } from "./chains.ts";

const BTC = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const ETH = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SOL = "11111111111111111111111111111111";
const XRP = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const ATOM = bech32.encode("cosmos", bech32.toWords(new Uint8Array(20).fill(7)));

function client(handler: (url: string, payload: Record<string, unknown> | unknown[]) => unknown) {
  return createActivityClient(async (input, init) => {
    const url = String(input);
    if (url.includes("api.coingecko"))
      return Response.json({ bitcoin: { usd: 100 }, ethereum: { usd: 200 }, near: { usd: 3 } });
    if (url.endsWith("/api/v1/prices")) return Response.json({ USD: 100 });
    const value = handler(url, init?.body ? JSON.parse(String(init.body)) : {});
    return value instanceof Response ? value : Response.json(value);
  });
}
const one = (chain: ChainId, address: string) => ({ data: { items: [{ chain, address }] } });

test("integer units preserve every satoshi, wei, and yoctoNEAR", () => {
  assert.equal(formatUnits(1n, 24), "0.000000000000000000000001");
  assert.equal(formatUnits(123456789012345678901234n, 18), "123456.789012345678901234");
  assert.equal(formatUnits(-100000001n, 8), "-1.00000001");
  assert.equal(formatUnits(50n, 0), "50");
  assert.throws(() => formatUnits(1n, 99));
});

test("Bitcoin native balance and unconfirmed transfers use exact values", async () => {
  const api = client((url) =>
    url.endsWith("/txs")
      ? [
          {
            txid: "pending-hash",
            status: { confirmed: false },
            vin: [],
            vout: [{ scriptpubkey_address: BTC, value: 1 }],
          },
        ]
      : {
          chain_stats: { funded_txo_sum: 5_000_000_000, spent_txo_sum: 0 },
          mempool_stats: { funded_txo_sum: 1, spent_txo_sum: 0 },
        },
  );
  const [row] = await api.fetchActivity(one("bitcoin", BTC));
  assert.equal(row!.ok, true);
  assert.equal(row!.balance, "50.00000001");
  assert.equal(row!.txs[0]!.amount, "0.00000001");
  assert.equal(row!.txs[0]!.status, "pending");
  assert.equal(row!.txs[0]!.direction, "in");
});

test("malformed endpoint data is unavailable and never masquerades as zero", async () => {
  const api = client(() => ({}));
  const [row] = await api.fetchActivity(one("bitcoin", BTC));
  assert.equal(row!.ok, false);
  assert.equal(row!.balance, "—");
  assert.equal(row!.usd, null);
  assert.match(row!.error!, /invalid account/);
});

test("EVM RPC fallback keeps native balance and labels missing history", async () => {
  const api = client((url, payload) =>
    url.includes("blockscout")
      ? new Response("blocked", { status: 429 })
      : {
          jsonrpc: "2.0",
          result:
            (payload as Record<string, unknown>).method === "eth_getBalance"
              ? "0xde0b6b3a7640001"
              : null,
        },
  );
  const [row] = await api.fetchActivity(one("ethereum", ETH));
  assert.equal(row!.ok, true);
  assert.equal(row!.balance, "1.000000000000000001");
  assert.equal(row!.history, "balance-only");
  assert.match(row!.historyNote!, /unavailable/);
});

test("Cosmos native bank messages deduplicate sender and receiver queries", async () => {
  const tx = {
    txhash: "COSMOS-TX",
    timestamp: "2026-11-02T10:00:00Z",
    code: 0,
    tx: {
      body: {
        messages: [
          {
            "@type": "/cosmos.bank.v1beta1.MsgSend",
            from_address: "other",
            to_address: ATOM,
            amount: [{ denom: "uatom", amount: "1234567" }],
          },
        ],
      },
    },
  };
  const api = client((url) =>
    url.includes("/balances/")
      ? {
          balances: [
            { denom: "uatom", amount: "9999999" },
            { denom: "uosmo", amount: "1000000000000000000" },
          ],
        }
      : { tx_responses: [tx] },
  );
  const [row] = await api.fetchActivity(one("cosmos", ATOM));
  assert.equal(row!.balance, "9.999999");
  assert.equal(row!.txs.length, 1);
  assert.equal(row!.txs[0]!.amount, "1.234567");
  assert.equal(row!.txs[0]!.direction, "in");
  assert.match(row!.historyNote!, /Staked assets/);
});

test("Cosmos search failure preserves balance with an explicit partial-history note", async () => {
  const api = client((url) =>
    url.includes("/balances/")
      ? { balances: [] }
      : new Response("indexing disabled", { status: 501 }),
  );
  const [row] = await api.fetchActivity(one("cosmos", ATOM));
  assert.equal(row!.ok, true);
  assert.equal(row!.balance, "0");
  assert.equal(row!.history, "balance-only");
  assert.match(row!.historyNote!, /does not provide complete/);
});

test("NEAR account and transaction values retain all 24 decimal places", async () => {
  const api = client((url) =>
    url.includes("nearblocks")
      ? {
          txns: [
            {
              transaction_hash: "NEAR-HASH",
              block_timestamp: "1793613600000000000",
              predecessor_account_id: "alice.near",
              receiver_account_id: "bob.near",
              actions_agg: { deposit: "1000000000000000000000001" },
              outcomes: { status: true },
            },
          ],
        }
      : { jsonrpc: "2.0", result: { amount: "2000000000000000000000001" } },
  );
  const [row] = await api.fetchActivity(one("near", "alice.near"));
  assert.equal(row!.balance, "2.000000000000000000000001");
  assert.equal(row!.txs[0]!.amount, "1.000000000000000000000001");
  assert.equal(row!.txs[0]!.time, 1793613600000);
  assert.equal(row!.txs[0]!.direction, "out");
});

test("XRP uses delivered amount for partial payments and excludes issued currencies", async () => {
  const api = client((_url, payload) =>
    (payload as Record<string, unknown>).method === "account_info"
      ? { result: { account_data: { Balance: "50000000" } } }
      : {
          result: {
            transactions: [
              {
                tx: {
                  hash: "xrp-native",
                  TransactionType: "Payment",
                  Account: "other",
                  Destination: XRP,
                  Amount: "999999999",
                  date: 1,
                },
                meta: { delivered_amount: "1234567", TransactionResult: "tesSUCCESS" },
              },
              {
                tx: {
                  hash: "issued",
                  TransactionType: "Payment",
                  Account: XRP,
                  Destination: "other",
                  Amount: { currency: "USD", value: "12" },
                },
                meta: {
                  delivered_amount: { currency: "USD", value: "12" },
                  TransactionResult: "tesSUCCESS",
                },
              },
            ],
          },
        },
  );
  const [row] = await api.fetchActivity(one("xrp", XRP));
  assert.equal(row!.balance, "50");
  assert.equal(row!.txs.length, 1);
  assert.equal(row!.txs[0]!.amount, "1.234567");
  assert.equal(row!.txs[0]!.direction, "in");
});

test("Solana matches unordered batch IDs and reports native balance changes", async () => {
  const api = client((_url, payload) => {
    if (Array.isArray(payload))
      return [
        {
          id: 0,
          result: {
            transaction: { message: { accountKeys: [SOL, "other"] } },
            meta: { preBalances: [100, 0], postBalances: [99, 1] },
          },
        },
      ];
    if (payload.method === "getBalance") return { result: { value: 99 } };
    return { result: [{ signature: "SOL-TX", blockTime: 1793613600, err: null }] };
  });
  const [row] = await api.fetchActivity(one("solana", SOL));
  assert.equal(row!.balance, "0.000000099");
  assert.equal(row!.txs[0]!.amount, "0.000000001");
  assert.equal(row!.txs[0]!.direction, "out");
});

test("Solana transaction failures preserve native balance", async () => {
  const api = client((_url, payload) =>
    !Array.isArray(payload) && payload.method === "getBalance"
      ? { result: { value: 42 } }
      : { error: { message: "rate limited" } },
  );
  const [row] = await api.fetchActivity(one("solana", SOL));
  assert.equal(row!.ok, true);
  assert.equal(row!.balance, "0.000000042");
  assert.equal(row!.history, "balance-only");
});

function dotAddress(): string {
  const payload = new Uint8Array(33);
  payload.set(new Uint8Array(32).fill(3), 1);
  const prefix = new TextEncoder().encode("SS58PRE");
  const combined = new Uint8Array(prefix.length + payload.length);
  combined.set(prefix);
  combined.set(payload, prefix.length);
  const encoded = new Uint8Array(35);
  encoded.set(payload);
  encoded.set(blake2b(combined).slice(0, 2), 33);
  return base58.encode(encoded);
}

test("Polkadot finalized System.Account free balance decodes SCALE u128 little-endian", async () => {
  const accountInfo = new Uint8Array(80);
  let units = 123450000001n;
  for (let index = 16; index < 32; index++) {
    accountInfo[index] = Number(units & 255n);
    units >>= 8n;
  }
  const hash = `0x${"ab".repeat(32)}`;
  const api = client((_url, payload) => {
    const query = payload as Record<string, unknown>;
    if (query.method === "chain_getFinalizedHead") return { result: hash };
    const params = query.params as string[];
    const pubkey = new Uint8Array(32).fill(3);
    assert.equal(
      params[0],
      `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9${bytesToHex(blake2b(pubkey, { dkLen: 16 }))}${bytesToHex(pubkey)}`,
    );
    assert.equal(params[1], hash);
    return { result: `0x${bytesToHex(accountInfo)}` };
  });
  const [row] = await api.fetchActivity(one("polkadot", dotAddress()));
  assert.equal(row!.ok, true);
  assert.equal(row!.balance, "12.3450000001");
  assert.equal(row!.history, "balance-only");
  assert.match(row!.historyNote!, /indexer/);
});

test("unexpected Substrate storage layout reports unavailable without fabricating a balance", async () => {
  const api = client((_url, payload) => ({
    result:
      (payload as Record<string, unknown>).method === "chain_getFinalizedHead"
        ? `0x${"aa".repeat(32)}`
        : "0x1234",
  }));
  const [row] = await api.fetchActivity(one("polkadot", dotAddress()));
  assert.equal(row!.ok, false);
  assert.equal(row!.balance, "—");
  assert.match(row!.error!, /storage layout/);
});

test("CORS/network errors are explicit, and request validation rejects invalid addresses", async () => {
  const api = client(() => {
    throw new TypeError("Failed to fetch");
  });
  const [row] = await api.fetchActivity(one("bitcoin", BTC));
  assert.equal(row!.balance, "—");
  assert.match(row!.error!, /browser access/);
  await assert.rejects(api.fetchActivity(one("xrp", "invalid")), /Bad address/);
  await assert.rejects(
    api.fetchActivity({ data: { items: Array(101).fill({ chain: "bitcoin", address: BTC }) } }),
    /100 addresses/,
  );
});

test("cache is per client and explicit refresh bypasses it", async () => {
  let reads = 0;
  const api = client(() => {
    reads++;
    return { result: "0x1" };
  });
  await api.fetchActivity(one("bnb", ETH));
  await api.fetchActivity(one("bnb", ETH));
  assert.equal(reads, 1);
  await api.fetchActivity({ ...one("bnb", ETH), force: true });
  assert.equal(reads, 2);
});
