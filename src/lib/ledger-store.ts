import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { activityKey, type ChainId } from "@/lib/chains";
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

export type RemoveWatchedResult = { removed: WatchedAddress[]; error: string | null };
export type RestoreWatchedResult = { restored: number; skipped: number; error: string | null };

type LedgerState = {
  watched: WatchedAddress[];
  wallets: LocalWallet[];
  hydrated: boolean;
  setHydrated: (value: boolean) => void;
  addWatched: (input: Omit<WatchedAddress, "id" | "addedAt">) => string | null;
  addWatchedBatch: (inputs: WatchedInput[]) => BatchAddResult;
  updateWatchedLabel: (id: string, label: string) => string | null;
  togglePinned: (id: string) => string | null;
  removeWatched: (id: string) => string | null;
  removeWatchedBatch: (ids: string[]) => RemoveWatchedResult;
  restoreWatchedBatch: (entries: WatchedAddress[]) => RestoreWatchedResult;
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
      removeWatched: (id) => get().removeWatchedBatch([id]).error,
      removeWatchedBatch: (ids) => {
        const before = get().watched;
        try {
          if (
            !Array.isArray(ids) ||
            ids.length > 1000 ||
            ids.some((id) => typeof id !== "string" || !id || id.length > 120 || id.trim() !== id)
          )
            throw new Error("Choose valid addresses from this watchlist.");
          const selected = new Set(ids);
          if (selected.size > 100) throw new Error("Remove up to 100 addresses at a time.");
          const removed = before.filter((entry) => selected.has(entry.id));
          if (removed.length) set({ watched: before.filter((entry) => !selected.has(entry.id)) });
          return { removed: removed.map((entry) => ({ ...entry })), error: null };
        } catch (error) {
          if (get().watched !== before) {
            try {
              set({ watched: before });
            } catch {
              /* The in-memory rollback precedes persistence. */
            }
            return {
              removed: [],
              error: "Could not save the watchlist in this browser. No addresses were removed.",
            };
          }
          return {
            removed: [],
            error: error instanceof Error ? error.message : "Could not remove these addresses.",
          };
        }
      },
      restoreWatchedBatch: (entries) => {
        const before = get().watched;
        try {
          if (!Array.isArray(entries) || entries.length > 100)
            throw new Error("Restore up to 100 addresses at a time.");
          const knownIds = new Set(before.map((entry) => entry.id));
          const knownAddresses = new Set(
            before.map((entry) => activityKey(entry.chain, entry.address)),
          );
          const walletIds = new Set(get().wallets.map((wallet) => wallet.id));
          const restored: WatchedAddress[] = [];
          let skipped = 0;
          // Validate the full payload, including entries that may prove to be duplicates.
          const normalized = entries.map((entry) => {
            if (
              !entry ||
              typeof entry.id !== "string" ||
              !entry.id ||
              entry.id.length > 120 ||
              entry.id.trim() !== entry.id ||
              !Number.isFinite(entry.addedAt) ||
              entry.addedAt < 0 ||
              !Number.isFinite(new Date(entry.addedAt).getTime())
            ) {
              throw new Error(
                "The removed-address snapshot is invalid. No addresses were restored.",
              );
            }
            const data = planWatchBatch([], [entry]).fresh[0]!;
            // Undo restores public watches only; it cannot restore a deleted wallet or its keys.
            const { walletId, ...publicData } = data;
            return {
              ...publicData,
              id: entry.id,
              addedAt: entry.addedAt,
              ...(walletId && walletIds.has(walletId) ? { walletId } : {}),
            };
          });
          for (const entry of normalized) {
            const key = activityKey(entry.chain, entry.address);
            if (knownIds.has(entry.id) || knownAddresses.has(key)) {
              skipped += 1;
              continue;
            }
            knownIds.add(entry.id);
            knownAddresses.add(key);
            restored.push(entry);
          }
          if (before.length + restored.length > 100)
            throw new Error(
              "Restoring these addresses would exceed the workspace limit of 100. No addresses were restored.",
            );
          if (restored.length) set({ watched: [...restored, ...before] });
          return { restored: restored.length, skipped, error: null };
        } catch (error) {
          if (get().watched !== before) {
            try {
              set({ watched: before });
            } catch {
              /* The in-memory rollback precedes persistence. */
            }
            return {
              restored: 0,
              skipped: 0,
              error: "Could not restore these addresses in browser storage.",
            };
          }
          return {
            restored: 0,
            skipped: 0,
            error: error instanceof Error ? error.message : "Could not restore these addresses.",
          };
        }
      },
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
