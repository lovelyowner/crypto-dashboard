import { activityKey, isChainId, isValidAddress, normalizeAddress, type ChainId } from "./chains";
import {
  DEFAULT_CREATOR_PROFILE,
  validateCreatorProfile,
  type DonationAddress,
} from "./creator-profile";

/** Only networks actually derived by the local wallet are offered for that wallet. */
const LOCAL_WALLET_CHAINS = ["bitcoin", "ethereum", "solana", "cosmos", "xrp", "near"] as const;
export type ProfileWalletOption = {
  key: string;
  chain: ChainId;
  address: string;
  label: string;
  source: "wallet" | "watchlist" | "wallet-and-watchlist";
};
export type PublicWalletSource = { readonly label?: unknown; readonly addresses?: unknown };
export type PublicWatchSource = {
  readonly chain?: unknown;
  readonly address?: unknown;
  readonly label?: unknown;
};
export type ProfileWalletSelection = {
  fresh: Array<Pick<DonationAddress, "chain" | "address" | "label">>;
  skipped: number;
};

function label(value: unknown): string {
  if (typeof value !== "string") return "";
  // Profile labels are short public text. Preserve Unicode names and emoji,
  // without carrying line breaks, hidden direction controls, or lone surrogates.
  return [...value.replace(/[\p{Cc}\p{Cs}\u200b\u202a-\u202e\u2066-\u2069\ufeff]/gu, "").trim()]
    .slice(0, 80)
    .join("");
}

/** Whitelist public fields; never inspect a wallet's encrypted or recovery data. */
export function collectProfileWalletOptions(
  wallets: readonly PublicWalletSource[],
  watched: readonly PublicWatchSource[],
): ProfileWalletOption[] {
  const options = new Map<string, ProfileWalletOption>();
  const add = (
    chain: unknown,
    address: unknown,
    description: unknown,
    source: "wallet" | "watchlist",
  ) => {
    if (
      typeof chain !== "string" ||
      !isChainId(chain) ||
      typeof address !== "string" ||
      !isValidAddress(chain, address)
    )
      return;
    const normalized = normalizeAddress(chain, address);
    const key = activityKey(chain, normalized);
    const prior = options.get(key);
    if (prior) {
      if (prior.source !== source) prior.source = "wallet-and-watchlist";
      if (!prior.label) prior.label = label(description);
      return;
    }
    options.set(key, { key, chain, address: normalized, label: label(description), source });
  };
  for (const wallet of wallets) {
    if (!wallet || typeof wallet !== "object") continue;
    const addresses = wallet.addresses;
    if (!addresses || typeof addresses !== "object" || Array.isArray(addresses)) continue;
    for (const chain of LOCAL_WALLET_CHAINS) {
      add(chain, (addresses as Record<string, unknown>)[chain], wallet.label, "wallet");
    }
  }
  for (const entry of watched) {
    if (!entry || typeof entry !== "object") continue;
    add(entry.chain, entry.address, entry.label, "watchlist");
  }
  return [...options.values()];
}

/** Validate the complete selection before the editor changes or generates IDs. */
export function planProfileWalletSelection(
  existing: readonly DonationAddress[],
  selected: readonly ProfileWalletOption[],
): ProfileWalletSelection {
  if (!Array.isArray(existing) || existing.length > 10)
    throw new Error("Use up to 10 crypto receiving addresses.");
  if (!Array.isArray(selected) || selected.length === 0)
    throw new Error("Choose at least one wallet address.");
  const known = new Set<string>();
  for (const entry of existing) {
    if (
      entry &&
      isChainId(entry.chain) &&
      typeof entry.address === "string" &&
      isValidAddress(entry.chain, entry.address)
    ) {
      known.add(activityKey(entry.chain, normalizeAddress(entry.chain, entry.address)));
    }
  }
  const fresh: ProfileWalletSelection["fresh"] = [];
  let skipped = 0;
  for (const option of selected) {
    // Apply the same address and public-text rules used for saving/publishing.
    const checked = validateCreatorProfile({
      ...DEFAULT_CREATOR_PROFILE,
      donations: {
        bankLink: "",
        crypto: [
          { id: "selection", chain: option?.chain, address: option?.address, label: option?.label },
        ],
      },
    }).donations.crypto[0];
    const key = activityKey(checked.chain, checked.address);
    if (known.has(key)) {
      skipped += 1;
      continue;
    }
    known.add(key);
    fresh.push({ chain: checked.chain, address: checked.address, label: checked.label });
  }
  if (existing.length + fresh.length > 10) {
    throw new Error(
      `This selection exceeds the 10-address profile limit. You have room for ${10 - existing.length} more.`,
    );
  }
  return { fresh, skipped };
}
