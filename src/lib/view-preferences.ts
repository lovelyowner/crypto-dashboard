import { useSyncExternalStore } from "react";
import { isChainId, type ChainId } from "./chains";

export type WorkspaceTab = "Overview" | "Activity" | "Wallets" | "Networks" | "Profile" | "Inbox";
export type AddressSort = "recent" | "label" | "balance";
export type TransactionDirection = "all" | "in" | "out" | "self";
export type TransactionStatus = "all" | "ok" | "pending" | "failed";
export type ViewTimeRange = "all" | "24h" | "7d" | "30d";
export type WorkspaceView = {
  tab: WorkspaceTab;
  sort: AddressSort;
  network: "all" | ChainId;
  direction: TransactionDirection;
  status: TransactionStatus;
  range: ViewTimeRange;
};

const STORAGE_KEY = "fathom.view.v1";
export const DEFAULT_WORKSPACE_VIEW: Readonly<WorkspaceView> = Object.freeze({
  tab: "Overview",
  sort: "recent",
  network: "all",
  direction: "all",
  status: "all",
  range: "all",
});
const tabs: readonly string[] = ["Overview", "Activity", "Wallets", "Networks", "Profile", "Inbox"];
const sorts: readonly string[] = ["recent", "label", "balance"];
const directions: readonly string[] = ["all", "in", "out", "self"];
const statuses: readonly string[] = ["all", "ok", "pending", "failed"];
const ranges: readonly string[] = ["all", "24h", "7d", "30d"];

/** Only known display choices are restored. Search and selected public addresses are never retained. */
export function parseWorkspaceView(raw: string | null): WorkspaceView {
  const defaults = { ...DEFAULT_WORKSPACE_VIEW };
  if (!raw || raw.length > 8192) return defaults;
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
    tab:
      typeof row.tab === "string" && tabs.includes(row.tab)
        ? (row.tab as WorkspaceTab)
        : defaults.tab,
    sort:
      typeof row.sort === "string" && sorts.includes(row.sort)
        ? (row.sort as AddressSort)
        : defaults.sort,
    network:
      typeof row.network === "string" && (row.network === "all" || isChainId(row.network))
        ? row.network
        : defaults.network,
    direction:
      typeof row.direction === "string" && directions.includes(row.direction)
        ? (row.direction as TransactionDirection)
        : defaults.direction,
    status:
      typeof row.status === "string" && statuses.includes(row.status)
        ? (row.status as TransactionStatus)
        : defaults.status,
    range:
      typeof row.range === "string" && ranges.includes(row.range)
        ? (row.range as ViewTimeRange)
        : defaults.range,
  };
}

/** Build a strict allowlist rather than serializing any caller or session state. */
export function serializeWorkspaceView(view: WorkspaceView): string {
  return JSON.stringify({
    version: 1,
    tab: view.tab,
    sort: view.sort,
    network: view.network,
    direction: view.direction,
    status: view.status,
    range: view.range,
  });
}

type Snapshot = WorkspaceView & { hydrated: boolean; storageError: string | null };
const SERVER_SNAPSHOT: Snapshot = {
  ...DEFAULT_WORKSPACE_VIEW,
  hydrated: false,
  storageError: null,
};
let snapshot = SERVER_SNAPSHOT;
const listeners = new Set<() => void>();
const getSnapshot = () => snapshot;
const getServerSnapshot = () => SERVER_SNAPSHOT;
function notify() {
  for (const listener of listeners) listener();
}
function hydrateView() {
  if (typeof window === "undefined" || snapshot.hydrated) return;
  try {
    snapshot = {
      ...parseWorkspaceView(window.localStorage.getItem(STORAGE_KEY)),
      hydrated: true,
      storageError: null,
    };
  } catch {
    snapshot = {
      ...snapshot,
      hydrated: true,
      storageError: "Your view works in this tab, but browser storage is unavailable.",
    };
  }
  notify();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  hydrateView();
  // Navigation stays local to the current tab: storage events never change another tab's view.
  return () => listeners.delete(listener);
}
function updateView(patch: Partial<WorkspaceView>) {
  if (typeof window === "undefined") return;
  hydrateView();
  const next: Snapshot = { ...snapshot, ...patch, hydrated: true, storageError: null };
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeWorkspaceView(next));
  } catch {
    next.storageError =
      "Your view is active in this tab, but could not be saved in browser storage.";
  }
  snapshot = next;
  notify();
}
function setTab(value: string) {
  if (tabs.includes(value)) updateView({ tab: value as WorkspaceTab });
}
function setSort(value: string) {
  if (sorts.includes(value)) updateView({ sort: value as AddressSort });
}
function setNetwork(value: string) {
  if (value === "all" || isChainId(value)) updateView({ network: value });
}
function setDirection(value: string) {
  if (directions.includes(value)) updateView({ direction: value as TransactionDirection });
}
function setStatus(value: string) {
  if (statuses.includes(value)) updateView({ status: value as TransactionStatus });
}
function setRange(value: string) {
  if (ranges.includes(value)) updateView({ range: value as ViewTimeRange });
}
function resetView() {
  updateView({ ...DEFAULT_WORKSPACE_VIEW });
}

/** SSR paints stable defaults; display preferences are restored after the browser subscribes. */
export function useWorkspaceView() {
  const view = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { ...view, setTab, setSort, setNetwork, setDirection, setStatus, setRange, resetView };
}
