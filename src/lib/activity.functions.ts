import { base58 } from "@scure/base";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { CHAINS, type ChainId, isChainId, isValidAddress, normalizeAddress } from "./chains.ts";

export type ActivityTx = {
  hash: string;
  time: number;
  direction: "in" | "out" | "self";
  amount: string;
  symbol: string;
  counterparty: string;
  status: "ok" | "failed" | "pending";
};

export type ChainActivity = {
  chain: ChainId;
  address: string;
  ok: boolean;
  error?: string;
  history: "full" | "balance-only";
  historyNote?: string;
  balance: string;
  symbol: string;
  usd: number | null;
  txs: ActivityTx[];
  fetchedAt?: number;
};

type WatchRequest = { chain: ChainId; address: string };

const HEADERS = { accept: "application/json" };

const BLOCKSCOUT: Partial<Record<ChainId, string>> = {
  ethereum: "https://eth.blockscout.com",
  optimism: "https://explorer.optimism.io",
  base: "https://base.blockscout.com",
  polygon: "https://polygon.blockscout.com",
  arbitrum: "https://arbitrum.blockscout.com",
  gnosis: "https://gnosis.blockscout.com",
  celo: "https://celo.blockscout.com",
  scroll: "https://scroll.blockscout.com",
  linea: "https://explorer.linea.build",
};

const BALANCE_RPC: Partial<Record<ChainId, string>> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  optimism: "https://optimism-rpc.publicnode.com",
  bnb: "https://bsc-rpc.publicnode.com",
  gnosis: "https://gnosis-rpc.publicnode.com",
  celo: "https://forno.celo.org",
  scroll: "https://rpc.scroll.io",
  zksync: "https://mainnet.era.zksync.io",
  linea: "https://rpc.linea.build",
  base: "https://mainnet.base.org",
  polygon: "https://polygon-bor-rpc.publicnode.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
};

/** Public network calls stay in the browser; no wallet secrets are sent here. */
export function createActivityClient(fetcher: typeof fetch = (...args) => fetch(...args)) {
  const resultCache = new Map<string, { at: number; value: ChainActivity }>();
  let priceCache: { at: number; prices: Record<string, number> } | null = null;
  let pricePending: Promise<Record<string, number>> | null = null;

  async function fetchActivity(request: {
    data: { items: WatchRequest[] };
    force?: boolean;
  }): Promise<ChainActivity[]> {
    const raw = request?.data?.items;
    if (!Array.isArray(raw)) throw new Error("Missing addresses.");
    if (raw.length > 100) throw new Error("Watch up to 100 addresses at a time.");
    const items = raw.map((item) => {
      if (!item || typeof item.chain !== "string" || !isChainId(item.chain))
        throw new Error("Unknown network.");
      if (typeof item.address !== "string" || !isValidAddress(item.chain, item.address))
        throw new Error("Bad address.");
      return { chain: item.chain, address: normalizeAddress(item.chain, item.address) };
    });
    if (request.force) resultCache.clear();
    // Price-service latency never prevents native balances/history from loading.
    let prices = priceCache && Date.now() - priceCache.at < 300_000 ? priceCache.prices : {};
    void loadPrices().then((loaded) => {
      prices = loaded;
    });
    const rows = await mapPool(items, 4, (item) => loadOne(item, prices));
    return rows.map((row) => {
      const price = priceFor(row.chain, prices);
      const units = Number(row.balance);
      return {
        ...row,
        usd: row.ok && price !== null && Number.isFinite(units) ? units * price : null,
      };
    });
  }

  async function loadOne(
    item: WatchRequest,
    prices: Record<string, number>,
  ): Promise<ChainActivity> {
    const key = `${item.chain}:${item.address}`;
    const hit = resultCache.get(key);
    if (hit && Date.now() - hit.at < (hit.value.ok ? 20_000 : 8_000)) return hit.value;
    let value: ChainActivity;
    try {
      value = await loadFresh(item, prices);
    } catch (error) {
      value = {
        chain: item.chain,
        address: item.address,
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not reach this network. Public APIs may limit requests or block browser access.",
        history: "full",
        balance: "—",
        symbol: CHAINS[item.chain].symbol,
        usd: null,
        txs: [],
      };
    }
    value.fetchedAt = Date.now();
    resultCache.set(key, { at: Date.now(), value });
    if (resultCache.size > 300) resultCache.clear();
    return value;
  }

  async function loadFresh(
    item: WatchRequest,
    prices: Record<string, number>,
  ): Promise<ChainActivity> {
    if (item.chain === "bitcoin") return loadBitcoin(item.address, prices);
    if (item.chain === "solana") return loadSolana(item.address, prices);
    if (item.chain === "avalanche") return loadAvalanche(item.address, prices);
    if (["cosmos", "osmosis", "celestia"].includes(item.chain))
      return loadCosmos(item.chain, item.address, prices);
    if (item.chain === "near") return loadNear(item.address, prices);
    if (item.chain === "xrp") return loadXrp(item.address, prices);
    if (item.chain === "monero")
      throw new Error(
        "Monero hides balances and transactions. An address alone cannot reveal activity. Use a trusted local wallet with a private view key; never paste that key into this dashboard.",
      );
    if (item.chain === "polkadot" || item.chain === "kusama")
      return loadSubstrate(item.chain, item.address, prices);
    return loadEvm(item.chain, item.address, prices);
  }

  async function loadBitcoin(
    address: string,
    prices: Record<string, number>,
  ): Promise<ChainActivity> {
    const [info, txs] = await Promise.all([
      getJson(`https://mempool.space/api/address/${encodeURIComponent(address)}`),
      getJson(`https://mempool.space/api/address/${encodeURIComponent(address)}/txs`),
    ]);
    if (!Array.isArray(txs) || !asRecord(info).chain_stats || !asRecord(info).mempool_stats)
      throw new Error("Bitcoin explorer returned an invalid account response.");
    const stats = asRecord(asRecord(info).chain_stats);
    const mem = asRecord(asRecord(info).mempool_stats);
    const funded =
      requiredBig(stats.funded_txo_sum, "Confirmed funded balance") +
      requiredBig(mem.funded_txo_sum, "Pending funded balance");
    const spent =
      requiredBig(stats.spent_txo_sum, "Confirmed spent balance") +
      requiredBig(mem.spent_txo_sum, "Pending spent balance");
    const balance = funded - spent;
    const parsed = (Array.isArray(txs) ? txs : []).slice(0, 20).map((tx) => bitcoinTx(tx, address));
    return finish(
      "bitcoin",
      address,
      balance,
      parsed.filter((tx) => tx.amount !== "0"),
      prices,
      "full",
    );
  }

  function bitcoinTx(tx: unknown, address: string): ActivityTx {
    const row = asRecord(tx);
    const status = asRecord(row.status);
    let received = 0n;
    let spent = 0n;
    let sender = "";
    let recipient = "";
    for (const vin of asArray(row.vin)) {
      const prev = asRecord(asRecord(vin).prevout);
      const owner = String(prev.scriptpubkey_address ?? "");
      const value = asBig(prev.value);
      if (owner === address) spent += value;
      else if (owner) sender = owner;
    }
    for (const vout of asArray(row.vout)) {
      const out = asRecord(vout);
      const owner = String(out.scriptpubkey_address ?? "");
      const value = asBig(out.value);
      if (owner === address) received += value;
      else if (owner) recipient = owner;
    }
    const blockTime = Number(asBig(status.block_time));
    const confirmed = status.confirmed === true;
    const net = received - spent;
    return {
      hash: String(row.txid ?? ""),
      time: confirmed && blockTime > 0 ? blockTime * 1000 : 0,
      direction: net > 0n ? "in" : net < 0n ? "out" : "self",
      amount: formatUnits(net < 0n ? -net : net, 8),
      symbol: "BTC",
      counterparty: (net >= 0n ? sender || recipient : recipient || sender) || "—",
      status: confirmed ? "ok" : "pending",
    };
  }

  async function loadSolana(
    address: string,
    prices: Record<string, number>,
  ): Promise<ChainActivity> {
    const rpc = "https://solana-rpc.publicnode.com";
    const balanceResult = asRecord(await rpcCall(rpc, "getBalance", [address]));
    const balance = requiredBig(balanceResult.value, "Solana balance");
    let detailAvailable = true;
    let signatures: unknown[] = [];
    try {
      const result = await rpcCall(rpc, "getSignaturesForAddress", [address, { limit: 8 }]);
      if (!Array.isArray(result)) throw new Error("No signatures in response");
      signatures = result;
    } catch {
      detailAvailable = false;
    }
    const txs: ActivityTx[] = [];
    if (signatures.length) {
      const batch = signatures.map((sig, index) => ({
        jsonrpc: "2.0",
        id: index,
        method: "getTransaction",
        params: [
          asRecord(sig).signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ],
      }));
      let parsed: unknown[] = [];
      try {
        const response = await postJson(rpc, batch);
        parsed = Array.isArray(response) ? response : [];
      } catch {
        parsed = [];
        detailAvailable = false;
      }
      signatures.forEach((sig, index) => {
        const meta = asRecord(sig);
        const hash = String(meta.signature ?? "");
        const time = Number(meta.blockTime ?? 0) * 1000;
        const wrapped = asRecord(parsed.find((row) => asRecord(row).id === index) ?? {});
        const tx = asRecord(wrapped.result);
        const delta = solanaDelta(tx, address);
        if (!delta) detailAvailable = false;
        txs.push({
          hash,
          time: Number.isFinite(time) ? time : 0,
          direction: delta ? (delta.net > 0n ? "in" : delta.net < 0n ? "out" : "self") : "self",
          amount: delta ? formatUnits(delta.net < 0n ? -delta.net : delta.net, 9) : "—",
          symbol: "SOL",
          counterparty: delta?.other || "—",
          status: meta.err || asRecord(tx.meta).err ? "failed" : "ok",
        });
      });
    }
    return {
      ...finish("solana", address, balance, txs, prices, detailAvailable ? "full" : "balance-only"),
      historyNote: detailAvailable
        ? "Recent SOL balance changes include fees and rent; SPL-token holdings are excluded."
        : "Native SOL balance is live. Some transaction details are unavailable; SPL-token holdings are excluded.",
    };
  }

  function solanaDelta(
    tx: Record<string, unknown>,
    address: string,
  ): { net: bigint; other: string } | null {
    const message = asRecord(asRecord(tx.transaction).message);
    const meta = asRecord(tx.meta);
    const keys = asArray(message.accountKeys).map((key) =>
      typeof key === "string" ? key : String(asRecord(key).pubkey ?? ""),
    );
    const index = keys.indexOf(address);
    const pre = meta.preBalances;
    const post = meta.postBalances;
    if (index < 0 || !Array.isArray(pre) || !Array.isArray(post)) return null;
    const net = asBig(post[index]) - asBig(pre[index]);
    let best = 0n;
    let other = "";
    keys.forEach((key, keyIndex) => {
      if (keyIndex === index || !key) return;
      const change = asBig(post[keyIndex]) - asBig(pre[keyIndex]);
      const size = change < 0n ? -change : change;
      if (size > best) {
        best = size;
        other = key;
      }
    });
    return { net, other };
  }

  async function loadAvalanche(
    address: string,
    prices: Record<string, number>,
  ): Promise<ChainActivity> {
    const rpc = BALANCE_RPC.avalanche!;
    const hex = await rpcCall(rpc, "eth_getBalance", [address, "latest"]);
    const balance = requiredBig(hex, "Balance");
    let txs: ActivityTx[] = [];
    let history: ChainActivity["history"] = "full";
    let historyNote: string | undefined;
    try {
      const body = await getJson(
        `https://api.routescan.io/v2/network/mainnet/evm/43114/address/${address}/transactions?limit=12`,
      );
      txs = asArray(asRecord(body).items)
        .map((item) => routescanTx(item, address, "AVAX"))
        .filter((tx) => tx.amount !== "0");
    } catch {
      history = "balance-only";
      historyNote = "Balance is live. Avalanche history didn't respond.";
    }
    const activity = finish("avalanche", address, balance, txs, prices, history);
    return historyNote ? { ...activity, historyNote } : activity;
  }

  function routescanTx(item: unknown, address: string, symbol: string): ActivityTx {
    const row = asRecord(item);
    const from = String(row.from ?? "").toLowerCase();
    const to = String(row.to ?? "").toLowerCase();
    const mine = address.toLowerCase();
    const value = asBig(row.value);
    const direction = from === mine && to === mine ? "self" : from === mine ? "out" : "in";
    return {
      hash: String(row.id ?? ""),
      time: Date.parse(String(row.timestamp ?? "")) || 0,
      direction,
      amount: formatUnits(value, 18),
      symbol,
      counterparty: direction === "out" ? String(row.to ?? "—") : String(row.from ?? "—"),
      status: row.status === false ? "failed" : "ok",
    };
  }

  async function loadEvm(
    chain: ChainId,
    address: string,
    prices: Record<string, number>,
  ): Promise<ChainActivity> {
    const scout = BLOCKSCOUT[chain];
    if (scout) {
      try {
        return await loadBlockscout(chain, scout, address, prices);
      } catch {
        /* Fall back to native JSON-RPC without inventing history. */
      }
    }
    const rpc = BALANCE_RPC[chain];
    if (!rpc) throw new Error("This network needs a configured public RPC.");
    const balance = requiredBig(
      await rpcCall(rpc, "eth_getBalance", [address, "latest"]),
      "Balance",
    );
    return {
      ...finish(chain, address, balance, [], prices, "balance-only"),
      historyNote:
        "Native balance is live. Transaction history is unavailable from this browser; open the explorer.",
    };
  }

  async function loadBlockscout(
    chain: ChainId,
    base: string,
    address: string,
    prices: Record<string, number>,
  ): Promise<ChainActivity> {
    const [account, transactions, transfers] = await Promise.all([
      getJson(`${base}/api/v2/addresses/${address}`),
      getJson(`${base}/api/v2/addresses/${address}/transactions`),
      getJson(`${base}/api/v2/addresses/${address}/token-transfers?type=ERC-20`).catch(() => null),
    ]);
    const balance = requiredBig(asRecord(account).coin_balance, "Account balance");
    if (!Array.isArray(asRecord(transactions).items))
      throw new Error("Explorer returned invalid transaction history.");
    const native = asArray(asRecord(transactions).items).map((item) =>
      blockscoutNative(item, address, CHAINS[chain].symbol),
    );
    const tokens = asArray(asRecord(transfers).items)
      .map((item) => blockscoutToken(item, address))
      .filter((tx): tx is ActivityTx => tx !== null);
    const txs = [...native, ...tokens].sort((a, b) => b.time - a.time).slice(0, 12);
    const tokenHistoryAvailable = Array.isArray(asRecord(transfers).items);
    return {
      ...finish(chain, address, balance, txs, prices, "full"),
      historyNote: tokenHistoryAvailable
        ? "Recent native transactions and ERC-20 transfers. NFT, internal transfers, and token holdings are excluded."
        : "Recent native transactions. ERC-20 history is unavailable; NFT, internal transfers, and token holdings are excluded.",
    };
  }

  function blockscoutNative(item: unknown, address: string, symbol: string): ActivityTx {
    const row = asRecord(item);
    const from = String(asRecord(row.from).hash ?? "").toLowerCase();
    const to = String(asRecord(row.to).hash ?? "").toLowerCase();
    const mine = address.toLowerCase();
    const value = asBig(row.value);
    const direction = from === mine && to === mine ? "self" : from === mine ? "out" : "in";
    return {
      hash: String(row.hash ?? ""),
      time: Date.parse(String(row.timestamp ?? "")) || 0,
      direction,
      amount: formatUnits(value, 18),
      symbol,
      counterparty: direction === "out" ? to || "Contract" : from || "—",
      status:
        row.result === "error" || row.status === "error" || row.revert_reason ? "failed" : "ok",
    };
  }

  function blockscoutToken(item: unknown, address: string): ActivityTx | null {
    const row = asRecord(item);
    const token = asRecord(row.token);
    const symbol = String(token.symbol ?? "")
      .trim()
      .slice(0, 24);
    if (!symbol) return null;
    const total = asRecord(row.total);
    const decimals = Number(total.decimals ?? token.decimals ?? 18);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
    const raw = asBig(total.value);
    const amount = formatUnits(raw, Number.isFinite(decimals) ? decimals : 18);
    const from = String(asRecord(row.from).hash ?? "").toLowerCase();
    const to = String(asRecord(row.to).hash ?? "").toLowerCase();
    const mine = address.toLowerCase();
    const direction = from === mine && to === mine ? "self" : from === mine ? "out" : "in";
    return {
      hash: String(row.transaction_hash ?? ""),
      time: Date.parse(String(row.timestamp ?? "")) || 0,
      direction,
      amount,
      symbol,
      counterparty: direction === "out" ? to || "—" : from || "—",
      status: "ok",
    };
  }

  async function loadSubstrate(
    chain: "polkadot" | "kusama",
    address: string,
    prices: Record<string, number>,
  ): Promise<ChainActivity> {
    const endpoint = `https://${chain}-rpc.publicnode.com`;
    // System.Account uses Blake2_128Concat, with two fixed Twox128 storage prefixes.
    // Validated SS58 AccountId32 has a one-byte DOT/KSM prefix and two-byte checksum.
    const account = base58.decode(address).slice(1, 33);
    const key = `0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9${bytesToHex(blake2b(account, { dkLen: 16 }))}${bytesToHex(account)}`;
    const finalized = await rpcCall(endpoint, "chain_getFinalizedHead", []);
    if (typeof finalized !== "string" || !/^0x[0-9a-f]{64}$/i.test(finalized))
      throw new Error("The public RPC returned an invalid finalized block.");
    const value = await rpcCall(endpoint, "state_getStorage", [key, finalized]);
    let balance = 0n;
    if (value !== null) {
      if (typeof value !== "string" || !/^0x[0-9a-f]{160}$/i.test(value))
        throw new Error("The account storage layout is unsupported; no balance was recorded.");
      // Current AccountInfo: nonce, consumers, providers, sufficients (4 bytes each),
      // followed by AccountData.free as a 16-byte little-endian u128.
      const data = hexToBytes(value.slice(2));
      for (let index = 31; index >= 16; index--) balance = (balance << 8n) | BigInt(data[index]!);
    }
    return {
      ...finish(chain, address, balance, [], prices, "balance-only"),
      historyNote:
        "Native free balance from a finalized block. Frozen restrictions may apply; reserved assets are excluded. Transaction history needs an indexer; open the explorer.",
    };
  }

  const COSMOS_NETWORKS: Partial<Record<ChainId, { rest: string; denom: string }>> = {
    cosmos: { rest: "https://cosmos-rest.publicnode.com", denom: "uatom" },
    osmosis: { rest: "https://osmosis-rest.publicnode.com", denom: "uosmo" },
    celestia: { rest: "https://celestia-rest.publicnode.com", denom: "utia" },
  };

  async function loadCosmos(
    chain: ChainId,
    address: string,
    prices: Record<string, number>,
  ): Promise<ChainActivity> {
    const config = COSMOS_NETWORKS[chain]!;
    const account = asRecord(
      await getJson(`${config.rest}/cosmos/bank/v1beta1/balances/${address}?pagination.limit=100`),
    );
    if (!Array.isArray(account.balances))
      throw new Error("The Cosmos REST endpoint returned no bank balances.");
    const coin = account.balances.map(asRecord).find((row) => row.denom === config.denom);
    const balance = coin ? requiredBig(coin.amount, "Bank balance") : 0n;
    const searches = await Promise.allSettled(
      ["message.sender", "transfer.recipient"].map(async (event) => {
        const query = encodeURIComponent(`${event}='${address}'`);
        const response = asRecord(
          await getJson(
            `${config.rest}/cosmos/tx/v1beta1/txs?query=${query}&pagination.limit=12&order_by=ORDER_BY_DESC`,
          ),
        );
        if (!Array.isArray(response.tx_responses))
          throw new Error("Transaction search is unavailable.");
        return response.tx_responses;
      }),
    );
    const seen = new Set<string>();
    const txs: ActivityTx[] = [];
    for (const result of searches) {
      if (result.status !== "fulfilled") continue;
      for (const item of result.value) {
        const row = asRecord(item);
        const hash = String(row.txhash ?? "");
        if (!hash || seen.has(hash)) continue;
        seen.add(hash);
        let received = 0n;
        let spent = 0n;
        let other = "Contract / staking";
        const messages = asArray(asRecord(asRecord(row.tx).body).messages);
        for (const raw of messages) {
          const message = asRecord(raw);
          if (message["@type"] !== "/cosmos.bank.v1beta1.MsgSend") continue;
          const amount = asArray(message.amount)
            .map(asRecord)
            .find((value) => value.denom === config.denom);
          if (!amount) continue;
          const units = requiredBig(amount.amount, "Transaction amount");
          if (message.from_address === address) {
            spent += units;
            other = String(message.to_address ?? "—");
          }
          if (message.to_address === address) {
            received += units;
            other = String(message.from_address ?? "—");
          }
        }
        const net = received - spent;
        txs.push({
          hash,
          time: Date.parse(String(row.timestamp ?? "")) || 0,
          direction: net > 0n ? "in" : net < 0n ? "out" : "self",
          amount: formatUnits(net < 0n ? -net : net, CHAINS[chain].decimals),
          symbol: CHAINS[chain].symbol,
          counterparty: other,
          status: Number(row.code ?? 0) === 0 ? "ok" : "failed",
        });
      }
    }
    const complete = searches.every((result) => result.status === "fulfilled");
    return {
      ...finish(
        chain,
        address,
        balance,
        txs.sort((a, b) => b.time - a.time).slice(0, 24),
        prices,
        complete ? "full" : "balance-only",
      ),
      historyNote: complete
        ? "Recent bank transfers and account messages. Staked assets, IBC balances, and other denominations are excluded."
        : "Native bank balance is live. This public node does not provide complete transaction search; staking and IBC assets are excluded.",
    };
  }

  async function loadNear(address: string, prices: Record<string, number>): Promise<ChainActivity> {
    const response = asRecord(
      await rpcCall("https://rpc.mainnet.near.org", "query", {
        request_type: "view_account",
        finality: "final",
        account_id: address,
      }),
    );
    const balance = requiredBig(response.amount, "NEAR account balance");
    let txs: ActivityTx[] = [];
    let history: ChainActivity["history"] = "full";
    try {
      const payload = asRecord(
        await getJson(
          `https://api.nearblocks.io/v1/account/${encodeURIComponent(address)}/txns?per_page=12&order=desc`,
        ),
      );
      if (!Array.isArray(payload.txns)) throw new Error("NEAR indexer returned no transactions.");
      txs = payload.txns.map((item) => {
        const tx = asRecord(item);
        const from = String(tx.predecessor_account_id ?? tx.signer_account_id ?? "");
        const to = String(tx.receiver_account_id ?? "");
        const direction =
          from === address && to === address ? "self" : from === address ? "out" : "in";
        const action = asRecord(tx.actions_agg);
        const units =
          action.deposit === undefined ? null : requiredBig(action.deposit, "NEAR transfer amount");
        const nanoseconds = requiredBig(tx.block_timestamp, "NEAR block timestamp");
        return {
          hash: String(tx.transaction_hash ?? ""),
          time: Number(nanoseconds / 1_000_000n),
          direction,
          amount: units === null ? "—" : formatUnits(units, 24),
          symbol: "NEAR",
          counterparty: direction === "out" ? to : from,
          status: asRecord(tx.outcomes).status === false ? "failed" : "ok",
        } as ActivityTx;
      });
    } catch {
      history = "balance-only";
    }
    return {
      ...finish("near", address, balance, txs, prices, history),
      historyNote:
        history === "full"
          ? "Native account balance and recent transactions; storage reserves and locked funds are not spendable balance."
          : "Native account balance is live. The NEAR transaction indexer is unavailable; locked funds and storage reserves are excluded.",
    };
  }

  async function loadXrp(address: string, prices: Record<string, number>): Promise<ChainActivity> {
    const endpoint = "https://s1.ripple.com:51234/";
    const info = asRecord(
      await rpcCall(endpoint, "account_info", [
        { account: address, ledger_index: "validated", strict: true },
      ]),
    );
    if (info.error === "actNotFound")
      return {
        ...finish("xrp", address, 0n, [], prices, "full"),
        historyNote: "This XRP account is not activated on the validated ledger.",
      };
    if (info.error) throw new Error(String(info.error_message ?? info.error));
    const balance = requiredBig(asRecord(info.account_data).Balance, "XRP balance");
    let txs: ActivityTx[] = [];
    let history: ChainActivity["history"] = "full";
    try {
      const body = asRecord(
        await rpcCall(endpoint, "account_tx", [
          {
            account: address,
            ledger_index_min: -1,
            ledger_index_max: -1,
            binary: false,
            forward: false,
            limit: 20,
          },
        ]),
      );
      if (body.error || !Array.isArray(body.transactions))
        throw new Error("XRP transaction history is unavailable.");
      txs = body.transactions.flatMap((raw) => {
        const item = asRecord(raw);
        const tx = asRecord(item.tx_json ?? item.tx);
        const meta = asRecord(item.meta);
        const from = String(tx.Account ?? "");
        const to = String(tx.Destination ?? "");
        if (tx.TransactionType !== "Payment" || (from !== address && to !== address)) return [];
        // delivered_amount handles partial payments; an object is an issued currency,
        // which cannot be mislabeled as XRP.
        const delivered = meta.delivered_amount ?? meta.DeliveredAmount;
        const rawAmount = delivered === undefined ? tx.Amount : delivered;
        if (typeof rawAmount !== "string" || !/^\d+$/.test(rawAmount)) return [];
        const direction =
          from === address && to === address ? "self" : from === address ? "out" : "in";
        return [
          {
            hash: String(item.hash ?? tx.hash ?? ""),
            time: (Number(tx.date ?? 0) + 946_684_800) * 1000,
            direction,
            amount: formatUnits(BigInt(rawAmount), 6),
            symbol: "XRP",
            counterparty: direction === "out" ? to : from,
            status: meta.TransactionResult === "tesSUCCESS" ? "ok" : "failed",
          } as ActivityTx,
        ];
      });
    } catch {
      history = "balance-only";
    }
    return {
      ...finish("xrp", address, balance, txs, prices, history),
      historyNote:
        history === "full"
          ? "Validated XRP payments. Native balance includes account reserve; issued currencies are excluded."
          : "Native XRP balance is live; payment history is unavailable. Balance includes the account reserve.",
    };
  }

  function finish(
    chain: ChainId,
    address: string,
    balance: bigint,
    txs: ActivityTx[],
    prices: Record<string, number>,
    history: ChainActivity["history"],
  ): ChainActivity {
    const symbol = CHAINS[chain].symbol;
    const human = formatUnits(balance < 0n ? 0n : balance, CHAINS[chain].decimals);
    const price = priceFor(chain, prices);
    const numeric = Number(human);
    return {
      chain,
      address,
      ok: true,
      history,
      balance: human,
      symbol,
      usd: price != null && Number.isFinite(numeric) ? numeric * price : null,
      txs,
    };
  }

  function priceFor(chain: ChainId, prices: Record<string, number>): number | null {
    const id = CHAINS[chain].priceId;
    return typeof prices[id] === "number" ? prices[id] : null;
  }

  async function loadPrices(): Promise<Record<string, number>> {
    if (priceCache && Date.now() - priceCache.at < 60_000) return priceCache.prices;
    pricePending ??= refreshPrices().finally(() => {
      pricePending = null;
    });
    return pricePending;
  }

  async function refreshPrices(): Promise<Record<string, number>> {
    const prices: Record<string, number> = {};
    try {
      const body = await getJson(
        `https://api.coingecko.com/api/v3/simple/price?ids=${[...new Set(Object.values(CHAINS).map((chain) => chain.priceId))].join(",")}&vs_currencies=usd`,
      );
      for (const [id, row] of Object.entries(asRecord(body))) {
        const usd = asRecord(row).usd;
        if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) prices[id] = usd;
      }
    } catch {
      /* Optional valuation is omitted when a provider is unavailable. */
    }
    if (typeof prices.bitcoin !== "number") {
      try {
        const body = await getJson("https://mempool.space/api/v1/prices");
        const usd = asRecord(body).USD;
        if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) prices.bitcoin = usd;
      } catch {
        /* still optional */
      }
    }
    priceCache = { at: Date.now(), prices };
    return prices;
  }

  async function rpcCall(url: string, method: string, params: unknown): Promise<unknown> {
    const body = await postJson(url, { jsonrpc: "2.0", id: 1, method, params });
    const row = asRecord(body);
    if (row.error) throw new Error(String(asRecord(row.error).message ?? row.error));
    if (!("result" in row)) throw new Error("RPC returned an invalid response.");
    return row.result;
  }

  async function request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetcher(url, init);
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      )
        throw new Error("The public endpoint timed out. Try refreshing later.");
      throw new Error(
        "Cannot reach the public endpoint. It may block browser access (CORS), be offline, or rate limit requests.",
      );
    }
  }

  async function postJson(url: string, payload: unknown): Promise<unknown> {
    const response = await request(url, {
      method: "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { ...HEADERS, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Network ${response.status}`);
    return parseLoose(text);
  }

  async function getJson(url: string): Promise<unknown> {
    const response = await request(url, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: HEADERS,
      signal: AbortSignal.timeout(12_000),
    });
    const text = await response.text();
    if (!response.ok || text.trim().startsWith("<")) {
      throw new Error(response.ok ? "Explorer blocked the request" : `Explorer ${response.status}`);
    }
    return parseLoose(text);
  }

  return { fetchActivity };
}

const defaultClient = createActivityClient();
export const fetchActivity = defaultClient.fetchActivity;

function parseLoose(text: string): unknown {
  const quoted = text.replace(/([:[,]\s*)(-?\d{15,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(quoted);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asBig(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)) return BigInt(value);
  return 0n;
}

async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
  return out;
}

/** Preserve every base unit; amounts never pass through floating point. */
export function formatUnits(raw: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new Error("Invalid decimal precision.");
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const fraction = decimals
    ? (value % base).toString().padStart(decimals, "0").replace(/0+$/, "")
    : "";
  return `${negative ? "-" : ""}${value / base}${fraction ? `.${fraction}` : ""}`;
}

function requiredBig(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^(-?\d+|0x[0-9a-f]+)$/i.test(value)) return BigInt(value);
  throw new Error(`${label} was missing or invalid; no balance was recorded.`);
}
