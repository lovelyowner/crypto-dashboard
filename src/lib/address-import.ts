import {
  CHAINS,
  CHAIN_IDS,
  isChainId,
  isValidAddress,
  normalizeAddress,
  type ChainId,
} from "./chains";
import { MAX_WATCHED_ADDRESSES, normalizeWatchLabel, type WatchedInput } from "./watchlist";

export const MAX_IMPORT_BYTES = 200_000;

export type AddressImportRow = {
  /** Original one-based line number, including blank lines and comments. */
  line: number;
  address: string;
  label: string;
  candidates: ChainId[];
  suggestedChain?: ChainId;
  error?: string;
  warning?: string;
};
export type AddressImportDefaults = {
  evmChain?: ChainId;
  substrateChain?: ChainId;
  /** Explicit confirmation for bare NEAR implicit-account identifiers. */
  nearChain?: "near";
};

const hintKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s()/_-]+/g, "");
const aliases: Record<string, ChainId> = {
  btc: "bitcoin",
  eth: "ethereum",
  erc20: "ethereum",
  etherc20: "ethereum",
  bnb: "bnb",
  bep20: "bnb",
  bnbbep20: "bnb",
  bsc: "bnb",
  sol: "solana",
  spl: "solana",
  solspl: "solana",
  atom: "cosmos",
  osmo: "osmosis",
  tia: "celestia",
  dot: "polkadot",
  ksm: "kusama",
  xmr: "monero",
  pol: "polygon",
  avax: "avalanche",
};
function chainHint(value: string): ChainId | undefined {
  const key = hintKey(value);
  if (isChainId(key)) return key;
  if (Object.hasOwn(aliases, key)) return aliases[key];
  return CHAIN_IDS.find((id) => hintKey(CHAINS[id].name) === key);
}

/**
 * Detect syntax compatibility only. EVM chains cannot be distinguished from an address;
 * generic SS58 addresses fit both supported Substrate networks. Bare 64-digit hexadecimal
 * values require explicit NEAR confirmation because private keys have the same shape.
 */
export function detectAddressCandidates(address: string): ChainId[] {
  const value = address.trim();
  // Named/checksummed chain formats are more specific than Solana's generic base58 key.
  // For example, an Osmosis bech32 address can incidentally decode to 32 base58 bytes.
  const specific = CHAIN_IDS.filter(
    (id) => id !== "near" && id !== "solana" && isValidAddress(id, value),
  );
  const candidates = specific.length
    ? specific
    : isValidAddress("solana", value)
      ? ["solana" as const]
      : [];
  if ((value.endsWith(".near") || /^[a-f0-9]{64}$/.test(value)) && isValidAddress("near", value)) {
    candidates.push("near");
  }
  return candidates;
}

function parseLine(value: string, line: number): AddressImportRow {
  let source = value;
  let explicit: ChainId | undefined;
  let invalidHint = false;
  const colon = /^([^,:]+):\s*(.*)$/.exec(source);
  if (colon) {
    explicit = chainHint(colon[1]!);
    invalidHint = explicit === undefined;
    source = colon[2]!;
  } else {
    const comma = source.indexOf(",");
    if (comma >= 0) {
      const hint = chainHint(source.slice(0, comma));
      if (hint) {
        explicit = hint;
        source = source.slice(comma + 1).trim();
      }
    }
  }
  const comma = source.indexOf(",");
  const address = (comma < 0 ? source : source.slice(0, comma)).trim();
  const rawLabel = comma < 0 ? "" : source.slice(comma + 1);
  let label = "";
  const row: AddressImportRow = { line, address, label, candidates: [] };
  if (invalidHint) return { ...row, error: `Line ${line}: the network hint is not supported.` };
  try {
    label = normalizeWatchLabel(rawLabel);
  } catch {
    return { ...row, error: `Line ${line}: labels can contain up to 80 characters.` };
  }
  row.label = label;
  if (explicit) {
    if (!isValidAddress(explicit, address))
      return { ...row, error: `Line ${line}: the public address does not match its network hint.` };
    return { ...row, candidates: [explicit], suggestedChain: explicit };
  }
  row.candidates = detectAddressCandidates(address);
  if (!row.candidates.length)
    return {
      ...row,
      error: `Line ${line}: unrecognized public address. Check the address or add a supported network hint.`,
    };
  if (/^[a-f0-9]{64}$/.test(address))
    return {
      ...row,
      warning:
        "A 64-digit hexadecimal value needs explicit NEAR confirmation. Only import it if it is a public implicit-account address, never a private key.",
    };
  if (row.candidates.length === 1) return { ...row, suggestedChain: row.candidates[0] };
  return {
    ...row,
    warning: row.candidates.every((id) => CHAINS[id].family === "evm")
      ? "This address fits several EVM networks. Choose the intended network; its format cannot identify the chain."
      : "This address fits several networks. Choose the intended network before adding it.",
  };
}

/**
 * Read one public address per line with optional comma-separated labels. Accepts a
 * network:address or network,address hint, UTF-8 BOM, CRLF, blanks and # comment lines.
 * No provider requests or storage writes occur while parsing the text.
 */
export function parseAddressText(text: string): AddressImportRow[] {
  if (
    typeof text !== "string" ||
    text.length > MAX_IMPORT_BYTES ||
    new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES
  )
    throw new Error("Address text must be smaller than 200 KB.");
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r\n?|\n/)
    .map((value, index) => ({ value: value.trim(), line: index + 1 }))
    .filter(({ value }) => value.length > 0 && !value.startsWith("#"));
  if (!lines.length) throw new Error("The text file does not contain any public addresses.");
  if (lines.length > MAX_WATCHED_ADDRESSES)
    throw new Error("Import up to 100 address entries at a time.");
  return lines.map(({ value, line }) => parseLine(value, line));
}

/** Resolve every row before handing the complete list to the atomic watchlist batch store. */
export function resolveAddressImport(
  rows: readonly AddressImportRow[],
  choices: Partial<Record<number, ChainId>> = {},
  defaults: AddressImportDefaults = {},
): WatchedInput[] {
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error("Choose a text file with public addresses first.");
  if (rows.length > MAX_WATCHED_ADDRESSES)
    throw new Error("Import up to 100 address entries at a time.");
  return rows.map((row: AddressImportRow) => {
    if (row.error)
      throw new Error(
        `Line ${row.line}: fix the invalid entry before importing. No addresses were added.`,
      );
    const family =
      row.candidates.length && row.candidates.every((id) => CHAINS[id].family === "evm")
        ? "evm"
        : row.candidates.length && row.candidates.every((id) => CHAINS[id].family === "substrate")
          ? "substrate"
          : row.candidates.length === 1 && row.candidates[0] === "near"
            ? "near"
            : null;
    const fallback =
      family === "evm"
        ? defaults.evmChain
        : family === "substrate"
          ? defaults.substrateChain
          : family === "near"
            ? defaults.nearChain
            : undefined;
    const chain = choices[row.line] ?? row.suggestedChain ?? fallback;
    if (!chain)
      throw new Error(
        `Line ${row.line}: choose a network before importing. No addresses were added.`,
      );
    if (!row.candidates.includes(chain) || !isValidAddress(chain, row.address))
      throw new Error(`Line ${row.line}: choose a compatible network. No addresses were added.`);
    return {
      chain,
      address: normalizeAddress(chain, row.address),
      label: normalizeWatchLabel(row.label),
    };
  });
}
