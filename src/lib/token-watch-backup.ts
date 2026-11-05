import { isValidAddress, normalizeAddress } from "./chains";
import type { WatchedAddress } from "./ledger-store";
import {
  MAX_TOKEN_WATCHES,
  normalizeTokenWatchLabel,
  parseTokenWatches,
  serializeTokenWatches,
  type TokenWatch,
} from "./token-watch";

export const MAX_TOKEN_BACKUP_BYTES = 65_536;
const BACKUP_KIND = "fathom-public-token-watches";
const ENVELOPE_KEYS = ["version", "kind", "entries"];
const PUBLIC_ENTRY_KEYS = ["chain", "ownerAddress", "tokenAddress", "label"];

type PublicTokenWatch = Pick<TokenWatch, "chain" | "ownerAddress" | "tokenAddress" | "label">;
export type TokenWatchImportPlan = {
  entries: TokenWatch[];
  added: number;
  duplicates: number;
  unmatched: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
function checkSize(raw: string): void {
  if (
    typeof raw !== "string" ||
    raw.length > MAX_TOKEN_BACKUP_BYTES ||
    new TextEncoder().encode(raw).byteLength > MAX_TOKEN_BACKUP_BYTES
  )
    throw new Error("Token backups must contain at most 65,536 UTF-8 bytes.");
}
function publicEntry(value: unknown): PublicTokenWatch {
  if (!record(value) || !exactKeys(value, PUBLIC_ENTRY_KEYS))
    throw new Error(
      "Token backups may contain only the network, public owner, token address, and label for each token.",
    );
  if (value.chain !== "ethereum" && value.chain !== "solana")
    throw new Error("Token backups support only Ethereum/ERC20 and Solana/SPL watches.");
  const chain = value.chain;
  if (
    typeof value.ownerAddress !== "string" ||
    typeof value.tokenAddress !== "string" ||
    !isValidAddress(chain, value.ownerAddress) ||
    !isValidAddress(chain, value.tokenAddress)
  )
    throw new Error("A token backup contains an invalid public owner, contract, or mint address.");
  return {
    chain,
    ownerAddress: normalizeAddress(chain, value.ownerAddress),
    tokenAddress: normalizeAddress(chain, value.tokenAddress),
    label: normalizeTokenWatchLabel(value.label),
  };
}
function tokenKey(entry: PublicTokenWatch): string {
  return `${entry.chain}:${normalizeAddress(entry.chain, entry.ownerAddress)}:${normalizeAddress(entry.chain, entry.tokenAddress)}`;
}
function ownerKey(chain: PublicTokenWatch["chain"], address: string): string {
  return `${chain}:${normalizeAddress(chain, address)}`;
}

/** Portable public configuration only; device IDs and fetched balances are never exported. */
export function exportTokenWatchBackup(entries: readonly TokenWatch[]): string {
  // Validate runtime fields as well as the TypeScript shape before selecting public fields.
  const normalized = parseTokenWatches(serializeTokenWatches(entries));
  const raw = JSON.stringify({
    version: 1,
    kind: BACKUP_KIND,
    entries: normalized.map(({ chain, ownerAddress, tokenAddress, label }) => ({
      chain,
      ownerAddress,
      tokenAddress,
      label,
    })),
  });
  checkSize(raw);
  return raw;
}

/** Plan an append-only local import. The caller persists the complete plan before changing state. */
export function planTokenWatchImport(
  raw: string,
  existing: readonly TokenWatch[],
  watched: readonly WatchedAddress[],
): TokenWatchImportPlan {
  checkSize(raw);
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error("The token backup is not valid JSON.");
  }
  if (
    !record(envelope) ||
    !exactKeys(envelope, ENVELOPE_KEYS) ||
    envelope.version !== 1 ||
    envelope.kind !== BACKUP_KIND
  )
    throw new Error("Choose a version 1 Fathom public token-watch backup.");
  if (!Array.isArray(envelope.entries) || envelope.entries.length > MAX_TOKEN_WATCHES)
    throw new Error("A token backup may contain up to 50 token watches.");
  // Validate every row, including duplicates and unmatched owners, before allocating IDs.
  const incoming = envelope.entries.map(publicEntry);
  serializeTokenWatches(existing);
  const owners = new Map<string, WatchedAddress>();
  for (const owner of watched) {
    if (
      (owner.chain !== "ethereum" && owner.chain !== "solana") ||
      typeof owner.id !== "string" ||
      !owner.id ||
      owner.id.length > 120 ||
      owner.id.trim() !== owner.id ||
      /\p{Cc}/u.test(owner.id) ||
      typeof owner.address !== "string" ||
      !isValidAddress(owner.chain, owner.address)
    )
      continue;
    const key = ownerKey(owner.chain, owner.address);
    if (!owners.has(key)) owners.set(key, owner);
  }
  const known = new Set(existing.map(tokenKey));
  const pending: (PublicTokenWatch & { ownerId: string })[] = [];
  let duplicates = 0;
  let unmatched = 0;
  for (const entry of incoming) {
    const key = tokenKey(entry);
    if (known.has(key)) {
      duplicates++;
      continue;
    }
    known.add(key);
    const owner = owners.get(ownerKey(entry.chain, entry.ownerAddress));
    if (!owner) {
      unmatched++;
      continue;
    }
    pending.push({ ...entry, ownerId: owner.id });
  }
  if (existing.length + pending.length > MAX_TOKEN_WATCHES)
    throw new Error(
      "Importing these tokens would exceed this browser's limit of 50 token watches. No tokens were imported.",
    );
  const ids = new Set(existing.map((entry) => entry.id));
  const added = pending.map((entry): TokenWatch => {
    let id: string | undefined;
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = crypto.randomUUID();
        if (!ids.has(candidate)) {
          id = candidate;
          break;
        }
      }
    } catch {
      // Never expose an exception from browser entropy providers in imported configuration.
    }
    if (!id)
      throw new Error("Could not create token watch identifiers. Please try importing again.");
    ids.add(id);
    return {
      id,
      ownerId: entry.ownerId,
      chain: entry.chain,
      ownerAddress: entry.ownerAddress,
      tokenAddress: entry.tokenAddress,
      label: entry.label,
    };
  });
  return { entries: [...existing, ...added], added: added.length, duplicates, unmatched };
}
