import test from "node:test";
import assert from "node:assert/strict";
import { formatTransactionDate } from "./format";
import { CHAIN_IDS, CHAINS, chainLabel, chainTokenStandard } from "./chains";

test("transaction dates use zero-padded day.month.two-digit-year in UTC", () => {
  assert.equal(formatTransactionDate(Date.UTC(2026, 0, 1)), "01.01.26");
  assert.equal(formatTransactionDate(Date.UTC(2026, 10, 3, 23, 59, 59)), "03.11.26");
  assert.equal(formatTransactionDate(Date.UTC(2024, 1, 29, 12)), "29.02.24");
  assert.equal(formatTransactionDate(Date.UTC(2030, 11, 31)), "31.12.30");
});

test("UTC dates remain stable at timezone and year boundaries", () => {
  assert.equal(formatTransactionDate(Date.parse("2026-01-01T00:30:00+02:00")), "31.12.25");
  assert.equal(formatTransactionDate(Date.parse("2025-12-31T23:30:00-02:00")), "01.01.26");
});

test("missing and out-of-range transaction times never fabricate a date", () => {
  for (const value of [0, -1, NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
    assert.equal(formatTransactionDate(value), "Unconfirmed");
  }
});

test("network labels identify native tickers and token standards without changing native symbols", () => {
  assert.equal(chainLabel("ethereum"), "Ethereum · ETH (ERC20)");
  assert.equal(chainLabel("bnb"), "BNB Smart Chain · BNB (BEP20)");
  assert.equal(chainLabel("solana"), "Solana · SOL (SPL)");
  assert.equal(chainLabel("bitcoin"), "Bitcoin · BTC");
  assert.equal(chainLabel("base"), "Base · ETH (ERC20)");
  assert.equal(chainTokenStandard("cosmos"), null);
  assert.equal(CHAINS.ethereum.symbol, "ETH");
  assert(CHAIN_IDS.every((id) => chainLabel(id).includes(CHAINS[id].symbol)));
});
