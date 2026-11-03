import { activityKey, isChainId, isValidAddress, normalizeAddress, type ChainId } from "./chains";

export const MAX_WATCHED_ADDRESSES = 100;
export type WatchedInput = {
  chain: ChainId;
  address: string;
  label: string;
  walletId?: string;
  pinned?: boolean;
};
export type BatchAddResult = { added: number; skipped: number; error: string | null };
export type WatchBatchPlan = { fresh: WatchedInput[]; skipped: number };

export function normalizeWatchLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("Use a text label for this address.");
  const label = value.trim();
  if (label.length > 80) throw new Error("Address labels can contain up to 80 characters.");
  return label;
}

function normalizeWatchInput(input: WatchedInput, index: number): WatchedInput {
  const line = index + 1;
  if (!input || typeof input.chain !== "string" || !isChainId(input.chain)) {
    throw new Error(`Entry ${line}: choose a supported network.`);
  }
  if (typeof input.address !== "string" || !isValidAddress(input.chain, input.address)) {
    throw new Error(`Entry ${line}: check the public address and selected network.`);
  }
  const label = normalizeWatchLabel(input.label);
  if (input.pinned !== undefined && typeof input.pinned !== "boolean") {
    throw new Error(`Entry ${line}: invalid pinned-address setting.`);
  }
  if (
    input.walletId !== undefined &&
    (typeof input.walletId !== "string" || input.walletId.length > 120)
  ) {
    throw new Error(`Entry ${line}: invalid wallet association.`);
  }
  return {
    chain: input.chain,
    address: normalizeAddress(input.chain, input.address),
    label,
    ...(input.walletId !== undefined ? { walletId: input.walletId } : {}),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
  };
}

/** Validate the complete batch before exposing changes; duplicates never consume capacity. */
export function planWatchBatch(
  existing: ReadonlyArray<{ chain: ChainId; address: string }>,
  inputs: ReadonlyArray<WatchedInput>,
): WatchBatchPlan {
  if (!Array.isArray(inputs) || inputs.length === 0)
    throw new Error("Add at least one public address.");
  if (inputs.length > MAX_WATCHED_ADDRESSES) throw new Error("Add up to 100 addresses at a time.");
  const normalized = inputs.map(normalizeWatchInput);
  const known = new Set(existing.map((entry) => activityKey(entry.chain, entry.address)));
  const fresh: WatchedInput[] = [];
  let skipped = 0;
  for (const entry of normalized) {
    const key = activityKey(entry.chain, entry.address);
    if (known.has(key)) {
      skipped += 1;
      continue;
    }
    known.add(key);
    fresh.push(entry);
  }
  if (existing.length + fresh.length > MAX_WATCHED_ADDRESSES) {
    throw new Error(
      "This batch would exceed the workspace limit of 100 addresses. No addresses were added.",
    );
  }
  return { fresh, skipped };
}

/** One public address per nonempty line; an optional label follows the first comma. */
export function parseAddressLines(text: string, defaultChain: ChainId): WatchedInput[] {
  if (typeof text !== "string" || text.length > 200_000)
    throw new Error("Address input is too large.");
  if (!isChainId(defaultChain)) throw new Error("Choose a supported network.");
  const lines = text
    .split(/\r?\n/)
    .map((value, index) => ({ value: value.trim(), line: index + 1 }))
    .filter(({ value }) => value.length > 0);
  if (lines.length === 0) throw new Error("Paste at least one public address.");
  if (lines.length > MAX_WATCHED_ADDRESSES) throw new Error("Paste up to 100 addresses at a time.");
  return lines.map(({ value, line }) => {
    const comma = value.indexOf(",");
    const address = (comma < 0 ? value : value.slice(0, comma)).trim();
    const rawLabel = comma < 0 ? "" : value.slice(comma + 1);
    if (!isValidAddress(defaultChain, address)) {
      throw new Error(
        `Line ${line}: check the public address and selected network. No addresses were added.`,
      );
    }
    let label: string;
    try {
      label = normalizeWatchLabel(rawLabel);
    } catch {
      throw new Error(
        `Line ${line}: labels can contain up to 80 characters. No addresses were added.`,
      );
    }
    return { chain: defaultChain, address: normalizeAddress(defaultChain, address), label };
  });
}
