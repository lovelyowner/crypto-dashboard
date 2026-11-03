import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ChainId } from "@/lib/chains";
import {
  normalizeWatchLabel,
  planWatchBatch,
  type WatchedInput,
  type BatchAddResult,
} from "./watchlist";
import type { WalletAddresses } from "@/lib/wallet/derive";
import type { StoredCipher } from "@/lib/wallet/secret";

export type WatchedAddress = {
  id: string;
  chain: ChainId;
  address: string;
  label: string;
  addedAt: number;
  walletId?: string;
  pinned?: boolean;
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
  addWatchedBatch: (inputs: WatchedInput[]) => BatchAddResult;
  updateWatchedLabel: (id: string, label: string) => string | null;
  togglePinned: (id: string) => string | null;
  removeWatched: (id: string) => void;
  addWallet: (wallet: LocalWallet) => void;
  updateWallet: (id: string, patch: Partial<LocalWallet>) => void;
  removeWallet: (id: string) => void;
};

export const useLedger = create<LedgerState>()(
  persist(
    (set, get) => ({
      watched: [],
      wallets: [],
      hydrated: false,
      setHydrated: (hydrated) => set({ hydrated }),
      addWatched: (input) => {
        const result = get().addWatchedBatch([input]);
        if (result.error) return result.error;
        return result.added ? null : "Already watching that address.";
      },
      addWatchedBatch: (inputs) => {
        const before = get().watched;
        try {
          const plan = planWatchBatch(get().watched, inputs);
          // Prepare every generated identifier before mutating the persisted workspace.
          const addedAt = Date.now();
          const rows = plan.fresh.map((entry) => ({ ...entry, id: crypto.randomUUID(), addedAt }));
          if (rows.length) set({ watched: [...rows, ...get().watched] });
          return { added: rows.length, skipped: plan.skipped, error: null };
        } catch (error) {
          if (get().watched !== before) {
            // Zustand applies in-memory state before persisting. Restore it if storage rejects the write.
            try {
              set({ watched: before });
            } catch {
              /* The state rollback precedes this second storage attempt. */
            }
            return {
              added: 0,
              skipped: 0,
              error: "Could not save the watchlist in this browser. No addresses were added.",
            };
          }
          return {
            added: 0,
            skipped: 0,
            error:
              error instanceof Error
                ? error.message
                : "Could not add these addresses. No addresses were added.",
          };
        }
      },
      updateWatchedLabel: (id, label) => {
        const before = get().watched;
        if (!before.some((entry) => entry.id === id))
          return "This address is no longer in your watchlist.";
        try {
          const normalized = normalizeWatchLabel(label);
          set({
            watched: get().watched.map((entry) =>
              entry.id === id ? { ...entry, label: normalized } : entry,
            ),
          });
          return null;
        } catch (error) {
          if (get().watched !== before) {
            try {
              set({ watched: before });
            } catch {
              /* In-memory state is already restored. */
            }
            return "Could not save this address label in browser storage.";
          }
          return error instanceof Error ? error.message : "Could not update this address label.";
        }
      },
      togglePinned: (id) => {
        const before = get().watched;
        if (!before.some((entry) => entry.id === id))
          return "This address is no longer in your watchlist.";
        try {
          set({
            watched: before.map((entry) =>
              entry.id === id ? { ...entry, pinned: !entry.pinned } : entry,
            ),
          });
          return null;
        } catch {
          if (get().watched !== before) {
            try {
              set({ watched: before });
            } catch {
              /* In-memory state is already restored. */
            }
          }
          return "Could not save this pinned-address setting in browser storage.";
        }
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
