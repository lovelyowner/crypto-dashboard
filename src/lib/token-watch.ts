import { isValidAddress, normalizeAddress } from "./chains";
import type { WatchedAddress } from "./ledger-store";

export const TOKEN_WATCH_STORAGE_KEY = "fathom.token-watch.v1";
export const MAX_TOKEN_WATCHES = 50;
const MAX_STORAGE_LENGTH = 65_536;

export type TokenWatch = {
  id: string;
  ownerId: string;
  chain: "ethereum" | "solana";
  ownerAddress: string;
  tokenAddress: string;
  label: string;
};

export type TokenWatchInput = {
  ownerId: string;
  tokenAddress: string;
  label?: string;
};

const ENTRY_KEYS = ["id", "ownerId", "chain", "ownerAddress", "tokenAddress", "label"];
const INPUT_KEYS = ["ownerId", "tokenAddress", "label"];
const CONTROLS = /\p{Cc}/u;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 120 &&
    value.trim() === value &&
    !CONTROLS.test(value)
  );
}

export function normalizeTokenWatchLabel(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || CONTROLS.test(value)) {
    throw new Error("Token labels can contain up to 64 characters without control characters.");
  }
  return value.trim();
}

function normalizeEntry(value: unknown): TokenWatch {
  if (
    !record(value) ||
    !onlyKeys(value, ENTRY_KEYS) ||
    !identifier(value.id) ||
    !identifier(value.ownerId) ||
    (value.chain !== "ethereum" && value.chain !== "solana")
  ) {
    throw new Error("The saved token watch configuration is invalid.");
  }
  const chain = value.chain;
  if (
    typeof value.ownerAddress !== "string" ||
    typeof value.tokenAddress !== "string" ||
    !isValidAddress(chain, value.ownerAddress) ||
    !isValidAddress(chain, value.tokenAddress)
  ) {
    throw new Error("Check the token contract or mint and its public owner address.");
  }
  return {
    id: value.id,
    ownerId: value.ownerId,
    chain,
    ownerAddress: normalizeAddress(chain, value.ownerAddress),
    tokenAddress: normalizeAddress(chain, value.tokenAddress),
    label: normalizeTokenWatchLabel(value.label),
  };
}

function tokenKey(entry: TokenWatch): string {
  return `${entry.chain}:${entry.ownerAddress}:${entry.tokenAddress}`;
}

function normalizeEntries(value: unknown): TokenWatch[] {
  if (!Array.isArray(value) || value.length > MAX_TOKEN_WATCHES) {
    throw new Error("Watch up to 50 tokens in this browser.");
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  return Array.from(value, (raw) => {
    const entry = normalizeEntry(raw);
    const key = tokenKey(entry);
    if (ids.has(entry.id) || keys.has(key)) {
      throw new Error("The saved token watch configuration contains duplicate entries.");
    }
    ids.add(entry.id);
    keys.add(key);
    return entry;
  });
}

/** Public configuration only. Balances and wallet/account data are never persisted here. */
export function parseTokenWatches(raw: string | null): TokenWatch[] {
  if (raw === null) return [];
  if (typeof raw !== "string" || raw.length > MAX_STORAGE_LENGTH) {
    throw new Error("The saved token watch configuration is too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The saved token watch configuration could not be read.");
  }
  if (
    !record(value) ||
    !onlyKeys(value, ["version", "entries"]) ||
    value.version !== 1
  ) {
    throw new Error("The saved token watch configuration has an unsupported format.");
  }
  return normalizeEntries(value.entries);
}

export function serializeTokenWatches(entries: readonly TokenWatch[]): string {
  return JSON.stringify({ version: 1, entries: normalizeEntries(entries) });
}

/** Persist before changing component state so failed writes cannot add an unsaved watch. */
export function saveTokenWatches(
  storage: Pick<Storage, "setItem">,
  entries: readonly TokenWatch[],
): void {
  storage.setItem(TOKEN_WATCH_STORAGE_KEY, serializeTokenWatches(entries));
}

/** An ID alone cannot authorize a read after a watched owner address changes or is removed. */
export function tokenWatchOwner(
  entry: TokenWatch,
  watched: readonly WatchedAddress[],
): WatchedAddress | null {
  if (
    !entry ||
    (entry.chain !== "ethereum" && entry.chain !== "solana") ||
    typeof entry.ownerAddress !== "string" ||
    !isValidAddress(entry.chain, entry.ownerAddress)
  ) {
    return null;
  }
  return (
    watched.find(
      (owner) =>
        owner.id === entry.ownerId &&
        owner.chain === entry.chain &&
        typeof owner.address === "string" &&
        isValidAddress(entry.chain, owner.address) &&
        normalizeAddress(entry.chain, owner.address) ===
          normalizeAddress(entry.chain, entry.ownerAddress),
    ) ?? null
  );
}

export function createTokenWatch(
  existing: readonly TokenWatch[],
  input: TokenWatchInput,
  watched: readonly WatchedAddress[],
  id: string = crypto.randomUUID(),
): { entries: TokenWatch[]; skipped: boolean } {
  const entries = normalizeEntries(existing);
  if (!record(input) || !onlyKeys(input, INPUT_KEYS) || !identifier(input.ownerId)) {
    throw new Error("Choose an existing public owner from your watchlist.");
  }
  const owner = watched.find((entry) => entry.id === input.ownerId);
  if (
    !owner ||
    (owner.chain !== "ethereum" && owner.chain !== "solana") ||
    typeof owner.address !== "string" ||
    !isValidAddress(owner.chain, owner.address)
  ) {
    throw new Error("Choose a watched Ethereum or Solana public owner.");
  }
  const entry = normalizeEntry({
    id,
    ownerId: owner.id,
    chain: owner.chain,
    ownerAddress: owner.address,
    tokenAddress: input.tokenAddress,
    label: input.label === undefined ? "" : input.label,
  });
  if (entries.some((known) => tokenKey(known) === tokenKey(entry))) {
    return { entries, skipped: true };
  }
  if (entries.some((known) => known.id === entry.id)) {
    throw new Error("This token watch identifier is already in use.");
  }
  if (entries.length >= MAX_TOKEN_WATCHES) {
    throw new Error("Watch up to 50 tokens in this browser.");
  }
  return { entries: [...entries, entry], skipped: false };
}
