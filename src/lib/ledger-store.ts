import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { type ChainId, isValidAddress, normalizeAddress } from "@/lib/chains";
import type { WalletAddresses } from "@/lib/wallet/derive";
import type { StoredCipher } from "@/lib/wallet/secret";

export type WatchedAddress = {
  id: string;
  chain: ChainId;
  address: string;
  label: string;
  addedAt: number;
  walletId?: string;
};

export type LocalWallet = {
  id: string;
  label: string;
  createdAt: number;
  custody: "device" | "identity";
  addresses: Pick<WalletAddresses, "bitcoin" | "ethereum" | "solana"> & Partial<WalletAddresses>;
  encrypted: StoredCipher | null;
  vaultId?: string;
  identityMethod?: "account" | "yoti";
};

type LedgerState = {
  watched: WatchedAddress[];
  wallets: LocalWallet[];
  hydrated: boolean;
  setHydrated: (value: boolean) => void;
  addWatched: (input: Omit<WatchedAddress, "id" | "addedAt">) => string | null;
  removeWatched: (id: string) => void;
  addWallet: (wallet: LocalWallet) => void;
  updateWallet: (id: string, patch: Partial<LocalWallet>) => void;
  removeWallet: (id: string) => void;
};

function sameWatch(chain: ChainId, a: string, b: string): boolean {
  return normalizeAddress(chain, a) === normalizeAddress(chain, b);
}

export const useLedger = create<LedgerState>()(
  persist(
    (set, get) => ({
      watched: [],
      wallets: [],
      hydrated: false,
      setHydrated: (hydrated) => set({ hydrated }),
      addWatched: (input) => {
        const address = input.address.trim();
        if (get().watched.length >= 100) return "Watch up to 100 addresses in this workspace.";
        if (!isValidAddress(input.chain, address))
          return "That address doesn't look right for this network.";
        const stored = input.chain === "bitcoin" ? normalizeAddress(input.chain, address) : address;
        if (
          get().watched.some(
            (item) => item.chain === input.chain && sameWatch(input.chain, item.address, stored),
          )
        ) {
          return "Already watching that address.";
        }
        set({
          watched: [
            {
              id: crypto.randomUUID(),
              chain: input.chain,
              address: stored,
              label: input.label,
              addedAt: Date.now(),
              walletId: input.walletId,
            },
            ...get().watched,
          ],
        });
        return null;
      },
      removeWatched: (id) => set({ watched: get().watched.filter((item) => item.id !== id) }),
      addWallet: (wallet) => set({ wallets: [wallet, ...get().wallets] }),
      updateWallet: (id, patch) =>
        set({
          wallets: get().wallets.map((wallet) =>
            wallet.id === id ? { ...wallet, ...patch } : wallet,
          ),
        }),
      removeWallet: (id) =>
        set({
          wallets: get().wallets.filter((wallet) => wallet.id !== id),
          watched: get().watched.filter((item) => item.walletId !== id),
        }),
    }),
    {
      name: "fathom.ledger.v1",
      skipHydration: true,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ watched: state.watched, wallets: state.wallets }),
    },
  ),
);
