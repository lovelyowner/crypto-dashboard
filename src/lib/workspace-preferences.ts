import { useSyncExternalStore } from "react";

export const REFRESH_INTERVALS = [0, 30_000, 60_000, 300_000] as const;
export type RefreshInterval = (typeof REFRESH_INTERVALS)[number];
export type WorkspacePreferences = {
  hideBalances: boolean;
  syncPaused: boolean;
  refreshInterval: RefreshInterval;
};

const STORAGE_KEY = "fathom.preferences.v1";
const LEGACY_REFRESH_KEY = "fathom.refresh";
const DEFAULT_PREFERENCES: WorkspacePreferences = {
  hideBalances: false,
  syncPaused: false,
  refreshInterval: 60_000,
};

type Snapshot = WorkspacePreferences & { hydrated: boolean; storageError: string | null };
const SERVER_SNAPSHOT: Snapshot = {
  ...DEFAULT_PREFERENCES,
  hydrated: false,
  storageError: null,
};
let snapshot = SERVER_SNAPSHOT;
const listeners = new Set<() => void>();

export function isRefreshInterval(value: unknown): value is RefreshInterval {
  return typeof value === "number" && REFRESH_INTERVALS.some((interval) => interval === value);
}

/** Invalid or outdated stored settings cannot cause excessive polling or enable privacy options. */
export function parseWorkspacePreferences(
  raw: string | null,
  legacyRefresh: string | null = null,
): WorkspacePreferences {
  const legacyNumber =
    legacyRefresh === null || legacyRefresh.trim() === "" ? NaN : Number(legacyRefresh);
  const defaults = {
    ...DEFAULT_PREFERENCES,
    refreshInterval: isRefreshInterval(legacyNumber)
      ? legacyNumber
      : DEFAULT_PREFERENCES.refreshInterval,
  };
  if (!raw) return defaults;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return defaults;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const row = value as Record<string, unknown>;
  if (row.version !== 1) return defaults;
  return {
    hideBalances: typeof row.hideBalances === "boolean" ? row.hideBalances : defaults.hideBalances,
    syncPaused: typeof row.syncPaused === "boolean" ? row.syncPaused : defaults.syncPaused,
    refreshInterval: isRefreshInterval(row.refreshInterval)
      ? row.refreshInterval
      : defaults.refreshInterval,
  };
}

function notify() {
  for (const listener of listeners) listener();
}

function readStorage() {
  if (typeof window === "undefined") return;
  try {
    snapshot = {
      ...parseWorkspacePreferences(
        window.localStorage.getItem(STORAGE_KEY),
        window.localStorage.getItem(LEGACY_REFRESH_KEY),
      ),
      hydrated: true,
      storageError: null,
    };
  } catch {
    snapshot = {
      ...snapshot,
      hydrated: true,
      storageError: "Settings are active for this tab, but browser storage is unavailable.",
    };
  }
  notify();
}

function handleStorage(event: StorageEvent) {
  if (event.key === null || event.key === STORAGE_KEY || event.key === LEGACY_REFRESH_KEY)
    readStorage();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (typeof window !== "undefined" && listeners.size === 1) {
    window.addEventListener("storage", handleStorage);
    if (!snapshot.hydrated) readStorage();
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined" && listeners.size === 0)
      window.removeEventListener("storage", handleStorage);
  };
}

function updatePreferences(patch: Partial<WorkspacePreferences>) {
  if (typeof window === "undefined") return;
  if (!snapshot.hydrated) readStorage();
  const next: Snapshot = { ...snapshot, ...patch, hydrated: true, storageError: null };
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        hideBalances: next.hideBalances,
        syncPaused: next.syncPaused,
        refreshInterval: next.refreshInterval,
      }),
    );
    // Preserve compatibility with the original workspace refresh preference.
    window.localStorage.setItem(LEGACY_REFRESH_KEY, String(next.refreshInterval));
  } catch {
    next.storageError =
      "Settings are active for this tab, but could not be saved in browser storage.";
  }
  snapshot = next;
  notify();
}

function setHideBalances(value: boolean) {
  if (typeof value === "boolean") updatePreferences({ hideBalances: value });
}
function setSyncPaused(value: boolean) {
  if (typeof value === "boolean") updatePreferences({ syncPaused: value });
}
function setRefreshInterval(value: RefreshInterval) {
  if (isRefreshInterval(value)) updatePreferences({ refreshInterval: value });
}

/** SSR uses a stable default; browser storage is read only after subscribing. */
export function useWorkspacePreferences() {
  const preferences = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => SERVER_SNAPSHOT,
  );
  return { ...preferences, setHideBalances, setSyncPaused, setRefreshInterval };
}

function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}
export function useOnlineStatus() {
  return useSyncExternalStore(
    subscribeOnline,
    () => typeof navigator === "undefined" || navigator.onLine,
    () => true,
  );
}
