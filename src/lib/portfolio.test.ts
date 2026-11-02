import test from "node:test";
import assert from "node:assert/strict";
import { csvCell, parseWatchlist, portfolioSummary } from "./portfolio";
import type { ChainActivity } from "./activity.functions";
const eth = "0x0000000000000000000000000000000000000000";
test("public watchlist validates version, chain, address and duplicates before mutation", () => {
  assert.deepEqual(
    parseWatchlist({ version: 1, addresses: [{ chain: "ethereum", address: eth, label: "@🌙" }] }),
    [{ chain: "ethereum", address: eth, label: "@🌙" }],
  );
  for (const invalid of [
    { version: 2, addresses: [] },
    { version: 1, addresses: [{ chain: "solana", address: eth, label: "" }] },
    {
      version: 1,
      addresses: [
        { chain: "ethereum", address: eth, label: "" },
        { chain: "ethereum", address: eth, label: "" },
      ],
    },
  ])
    assert.throws(() => parseWatchlist(invalid));
});
test("portfolio total distinguishes priced native balances from unknown data", () => {
  const good: ChainActivity = {
    chain: "ethereum",
    address: eth,
    ok: true,
    balance: "1",
    symbol: "ETH",
    usd: 2000,
    history: "full",
    txs: [],
  };
  const bad = { ...good, ok: false, balance: "—", usd: null };
  assert.deepEqual(portfolioSummary([good, bad], 2), {
    knownUsd: 2000,
    priced: 1,
    loaded: 1,
    unavailable: 1,
    complete: false,
  });
  assert.equal(portfolioSummary([], 0).complete, false);
});
test("CSV cells escape quotes and prevent formula injection in exported labels/amounts", () => {
  assert.equal(csvCell('=HYPERLINK("bad")'), '"\'=HYPERLINK(""bad"")"');
  assert.equal(csvCell('a,b\n"c"'), '"a,b\n""c"""');
});
