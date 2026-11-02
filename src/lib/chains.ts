import { base58, bech32, bech32m } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export type ChainFamily =
  "bitcoin" | "evm" | "solana" | "cosmos" | "near" | "xrp" | "substrate" | "monero";
export type TrackingCapability = "full" | "balance-only" | "indexer-required" | "private";

type ChainSpec = {
  name: string;
  symbol: string;
  monogram: string;
  decimals: number;
  family: ChainFamily;
  color: string;
  priceId: string;
  tracking: TrackingCapability;
  note: string;
  addressUrl: (address: string) => string;
  txUrl: (hash: string) => string;
};

function network(
  id: string,
  name: string,
  symbol: string,
  decimals: number,
  family: ChainFamily,
  color: string,
  priceId: string,
  explorer: string,
  tracking: TrackingCapability = "full",
  note = "Native balance and recent activity via public APIs.",
): ChainSpec & { id: string } {
  return {
    id,
    name,
    symbol,
    monogram: symbol,
    decimals,
    family,
    color,
    priceId,
    tracking,
    note,
    addressUrl: (address) => `${explorer}/address/${encodeURIComponent(address)}`,
    txUrl: (hash) => `${explorer}/tx/${encodeURIComponent(hash)}`,
  };
}

export const CHAINS = {
  bitcoin: network(
    "bitcoin",
    "Bitcoin",
    "BTC",
    8,
    "bitcoin",
    "#f4a340",
    "bitcoin",
    "https://mempool.space",
  ),
  ethereum: network(
    "ethereum",
    "Ethereum",
    "ETH",
    18,
    "evm",
    "#9699e8",
    "ethereum",
    "https://eth.blockscout.com",
  ),
  base: network(
    "base",
    "Base",
    "ETH",
    18,
    "evm",
    "#477bff",
    "ethereum",
    "https://base.blockscout.com",
  ),
  optimism: network(
    "optimism",
    "Optimism",
    "ETH",
    18,
    "evm",
    "#ff5269",
    "ethereum",
    "https://explorer.optimism.io",
  ),
  arbitrum: network(
    "arbitrum",
    "Arbitrum",
    "ETH",
    18,
    "evm",
    "#77b9eb",
    "ethereum",
    "https://arbitrum.blockscout.com",
  ),
  polygon: network(
    "polygon",
    "Polygon",
    "POL",
    18,
    "evm",
    "#b18af5",
    "polygon-ecosystem-token",
    "https://polygon.blockscout.com",
  ),
  avalanche: network(
    "avalanche",
    "Avalanche",
    "AVAX",
    18,
    "evm",
    "#ed7078",
    "avalanche-2",
    "https://snowtrace.io",
  ),
  solana: {
    ...network("solana", "Solana", "SOL", 9, "solana", "#8ce5c7", "solana", "https://solscan.io"),
    addressUrl: (address: string) => `https://solscan.io/account/${encodeURIComponent(address)}`,
  },
  cosmos: {
    ...network(
      "cosmos",
      "Cosmos Hub",
      "ATOM",
      6,
      "cosmos",
      "#bec0ff",
      "cosmos",
      "https://www.mintscan.io/cosmos",
    ),
    addressUrl: (address: string) =>
      `https://www.mintscan.io/cosmos/address/${encodeURIComponent(address)}`,
  },
  osmosis: network(
    "osmosis",
    "Osmosis",
    "OSMO",
    6,
    "cosmos",
    "#a785ed",
    "osmosis",
    "https://www.mintscan.io/osmosis",
  ),
  celestia: network(
    "celestia",
    "Celestia",
    "TIA",
    6,
    "cosmos",
    "#ba97f6",
    "celestia",
    "https://www.mintscan.io/celestia",
  ),
  near: {
    ...network("near", "NEAR", "NEAR", 24, "near", "#d3e9dc", "near", "https://nearblocks.io"),
    addressUrl: (address: string) => `https://nearblocks.io/address/${encodeURIComponent(address)}`,
    txUrl: (hash: string) => `https://nearblocks.io/txns/${encodeURIComponent(hash)}`,
  },
  xrp: {
    ...network(
      "xrp",
      "XRP Ledger",
      "XRP",
      6,
      "xrp",
      "#c6dbe4",
      "ripple",
      "https://livenet.xrpl.org",
    ),
    addressUrl: (address: string) =>
      `https://livenet.xrpl.org/accounts/${encodeURIComponent(address)}`,
    txUrl: (hash: string) => `https://livenet.xrpl.org/transactions/${encodeURIComponent(hash)}`,
  },
  polkadot: {
    ...network(
      "polkadot",
      "Polkadot",
      "DOT",
      10,
      "substrate",
      "#ed73ad",
      "polkadot",
      "https://polkadot.subscan.io",
      "balance-only",
      "Native free balance from finalized public RPC. Frozen restrictions may apply; transaction history needs an indexer.",
    ),
    addressUrl: (address: string) =>
      `https://polkadot.subscan.io/account/${encodeURIComponent(address)}`,
    txUrl: (hash: string) => `https://polkadot.subscan.io/extrinsic/${encodeURIComponent(hash)}`,
  },
  kusama: {
    ...network(
      "kusama",
      "Kusama",
      "KSM",
      12,
      "substrate",
      "#c5c9ca",
      "kusama",
      "https://kusama.subscan.io",
      "balance-only",
      "Native free balance from finalized public RPC. Frozen restrictions may apply; transaction history needs an indexer.",
    ),
    addressUrl: (address: string) =>
      `https://kusama.subscan.io/account/${encodeURIComponent(address)}`,
    txUrl: (hash: string) => `https://kusama.subscan.io/extrinsic/${encodeURIComponent(hash)}`,
  },
  monero: {
    ...network(
      "monero",
      "Monero",
      "XMR",
      12,
      "monero",
      "#f5a56f",
      "monero",
      "https://xmrchain.net",
      "private",
      "Monero balances and transactions cannot be read from a public address. Use a trusted local wallet with a private view key; never paste that key here.",
    ),
    // Public Monero explorers cannot search private balances by address.
    addressUrl: (_address: string) =>
      "https://www.getmonero.org/resources/user-guides/view_only.html",
  },
  bnb: network(
    "bnb",
    "BNB Smart Chain",
    "BNB",
    18,
    "evm",
    "#e9c66b",
    "binancecoin",
    "https://bscscan.com",
    "balance-only",
    "Native balance via public RPC. Open the explorer for transaction history.",
  ),
  gnosis: network(
    "gnosis",
    "Gnosis",
    "XDAI",
    18,
    "evm",
    "#8ad7b1",
    "xdai",
    "https://gnosis.blockscout.com",
  ),
  celo: network(
    "celo",
    "Celo",
    "CELO",
    18,
    "evm",
    "#d3e897",
    "celo",
    "https://celo.blockscout.com",
  ),
  scroll: network(
    "scroll",
    "Scroll",
    "ETH",
    18,
    "evm",
    "#dfb995",
    "ethereum",
    "https://scrollscan.com",
    "balance-only",
    "Native balance via public RPC. Open the explorer for transaction history.",
  ),
  zksync: network(
    "zksync",
    "ZKsync Era",
    "ETH",
    18,
    "evm",
    "#adb3ff",
    "ethereum",
    "https://explorer.zksync.io",
    "balance-only",
    "Native balance via public RPC. Open the explorer for transaction history.",
  ),
  linea: network(
    "linea",
    "Linea",
    "ETH",
    18,
    "evm",
    "#b7c1d6",
    "ethereum",
    "https://lineascan.build",
    "balance-only",
    "Native balance via public RPC. Open the explorer for transaction history.",
  ),
} as const;

export type ChainId = keyof typeof CHAINS;
export const CHAIN_IDS = Object.keys(CHAINS) as ChainId[];
export const EVM_CHAIN_IDS = CHAIN_IDS.filter((id) => CHAINS[id].family === "evm");

export function isChainId(value: string): value is ChainId {
  return Object.prototype.hasOwnProperty.call(CHAINS, value);
}

export function normalizeAddress(chain: ChainId, address: string): string {
  const trimmed = address.trim();
  if (CHAINS[chain].family === "evm") return trimmed.toLowerCase();
  if (chain === "bitcoin" && /^bc1/i.test(trimmed)) return trimmed.toLowerCase();
  if (CHAINS[chain].family === "cosmos") return trimmed.toLowerCase();
  if (CHAINS[chain].family === "substrate") {
    const prefix = chain === "kusama" ? 2 : 0;
    if (validSs58(trimmed, prefix)) return encodeSs58(base58.decode(trimmed).slice(1, 33), prefix);
  }
  return trimmed;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function validEvm(value: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return false;
  const body = value.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const hash = bytesToHex(keccak_256(utf8ToBytes(body.toLowerCase())));
  return [...body].every(
    (c, i) =>
      !/[a-f]/i.test(c) ||
      (parseInt(hash[i]!, 16) >= 8 ? c === c.toUpperCase() : c === c.toLowerCase()),
  );
}

function validBitcoin(value: string): boolean {
  try {
    if (/^bc1/i.test(value)) {
      const normalized = value.toLowerCase();
      const decoded = normalized.startsWith("bc1q")
        ? bech32.decode(value as `${string}1${string}`)
        : bech32m.decode(value as `${string}1${string}`);
      const version = decoded.words[0];
      const bytes = bech32.fromWords(decoded.words.slice(1));
      if (decoded.prefix !== "bc" || version === undefined || version > 16) return false;
      return version === 0
        ? bytes.length === 20 || bytes.length === 32
        : bytes.length >= 2 && bytes.length <= 40;
    }
    const bytes = base58.decode(value);
    return (
      bytes.length === 25 &&
      (bytes[0] === 0 || bytes[0] === 5) &&
      sameBytes(bytes.slice(-4), sha256(sha256(bytes.slice(0, -4))).slice(0, 4))
    );
  } catch {
    return false;
  }
}

const RIPPLE_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
function decodeAlphabet58(value: string, alphabet: string): Uint8Array {
  let sum = 0n;
  for (const c of value) {
    const index = alphabet.indexOf(c);
    if (index < 0) throw new Error("Invalid base58 digit");
    sum = sum * 58n + BigInt(index);
  }
  const out: number[] = [];
  while (sum > 0n) {
    out.push(Number(sum & 255n));
    sum >>= 8n;
  }
  for (const c of value) {
    if (c !== alphabet[0]) break;
    out.push(0);
  }
  return Uint8Array.from(out.reverse());
}

function validXrp(value: string): boolean {
  try {
    const bytes = decodeAlphabet58(value, RIPPLE_ALPHABET);
    return (
      bytes.length === 25 &&
      bytes[0] === 0 &&
      sameBytes(bytes.slice(-4), sha256(sha256(bytes.slice(0, -4))).slice(0, 4))
    );
  } catch {
    return false;
  }
}

function encodeSs58(account: Uint8Array, prefix: number): string {
  const payload = Uint8Array.from([prefix, ...account]);
  const input = Uint8Array.from([...utf8ToBytes("SS58PRE"), ...payload]);
  const checksum = blake2b(input, { dkLen: 64 }).slice(0, 2);
  return base58.encode(Uint8Array.from([...payload, ...checksum]));
}

function validSs58(value: string, expectedPrefix: number): boolean {
  try {
    const bytes = base58.decode(value);
    if (bytes.length !== 35 || (bytes[0] !== expectedPrefix && bytes[0] !== 42)) return false;
    const payload = bytes.slice(0, 33);
    const pre = utf8ToBytes("SS58PRE");
    const input = new Uint8Array(pre.length + payload.length);
    input.set(pre);
    input.set(payload, pre.length);
    return sameBytes(bytes.slice(33), blake2b(input, { dkLen: 64 }).slice(0, 2));
  } catch {
    return false;
  }
}

function validMonero(value: string): boolean {
  // Monero encodes each eight-byte block separately, unlike Bitcoin base58.
  if (value.length !== 95 && value.length !== 106) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const decodedSizes: Record<number, number> = { 2: 1, 3: 2, 5: 3, 6: 4, 7: 5, 9: 6, 10: 7, 11: 8 };
  try {
    const bytes: number[] = [];
    for (let i = 0; i < value.length; i += 11) {
      const block = value.slice(i, i + 11);
      const size = decodedSizes[block.length];
      if (!size) return false;
      let number = 0n;
      for (const c of block) {
        const digit = alphabet.indexOf(c);
        if (digit < 0) return false;
        number = number * 58n + BigInt(digit);
      }
      if (number >= 1n << BigInt(size * 8)) return false;
      const decoded = new Array<number>(size);
      for (let j = size - 1; j >= 0; j--) {
        decoded[j] = Number(number & 255n);
        number >>= 8n;
      }
      bytes.push(...decoded);
    }
    const decoded = Uint8Array.from(bytes);
    const expectedSize = value.length === 106 ? 77 : 69;
    const expectedVersion = value.length === 106 ? [19] : [18, 42];
    return (
      decoded.length === expectedSize &&
      expectedVersion.includes(decoded[0]!) &&
      sameBytes(decoded.slice(-4), keccak_256(decoded.slice(0, -4)).slice(0, 4))
    );
  } catch {
    return false;
  }
}

export function isValidAddress(chain: ChainId, address: string): boolean {
  const value = address.trim();
  if (!value || value.length > 128) return false;
  const family = CHAINS[chain].family;
  if (family === "evm") return validEvm(value);
  if (family === "bitcoin") return validBitcoin(value);
  if (family === "solana") {
    try {
      return base58.decode(value).length === 32;
    } catch {
      return false;
    }
  }
  if (family === "cosmos") {
    try {
      const expectedPrefix =
        chain === "osmosis" ? "osmo" : chain === "celestia" ? "celestia" : "cosmos";
      const decoded = bech32.decode(value as `${string}1${string}`, 128);
      const size = bech32.fromWords(decoded.words).length;
      return decoded.prefix === expectedPrefix && (size === 20 || size === 32);
    } catch {
      return false;
    }
  }
  if (family === "near")
    return value.length >= 2 && value.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
  if (family === "xrp") return validXrp(value);
  if (family === "substrate") return validSs58(value, chain === "kusama" ? 2 : 0);
  if (family === "monero") return validMonero(value);
  return false;
}

export function activityKey(chain: ChainId, address: string): string {
  return `${chain}:${normalizeAddress(chain, address)}`;
}

/** Detection is a suggestion only: an EVM address can exist on many networks. */
export function detectFamily(address: string): ChainFamily | null {
  for (const chain of [
    "bitcoin",
    "ethereum",
    "cosmos",
    "osmosis",
    "celestia",
    "xrp",
    "monero",
    "polkadot",
    "kusama",
    "solana",
  ] as const) {
    if (isValidAddress(chain, address)) return CHAINS[chain].family;
  }
  // Requiring a suffix avoids interpreting arbitrary short pasted text as NEAR.
  if (
    (address.endsWith(".near") || /^[a-f0-9]{64}$/.test(address)) &&
    isValidAddress("near", address)
  )
    return "near";
  return null;
}
