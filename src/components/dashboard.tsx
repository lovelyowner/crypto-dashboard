import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Activity,
  Atom,
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  CheckCheck,
  Undo2,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Pencil,
  Pin,
  Settings,
  Pause,
  WifiOff,
  ExternalLink,
  FileUp,
  Globe2,
  KeyRound,
  LayoutDashboard,
  Menu,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  Wallet,
  UserRound,
  X,
} from "lucide-react";
import { CHAINS, CHAIN_IDS, chainLabel, activityKey, type ChainId } from "@/lib/chains";
import { fetchActivity } from "@/lib/activity.functions";
import { useLedger, type WatchedAddress } from "@/lib/ledger-store";
import { formatUsd, formatTransactionDate, relativeTime, shortAddress } from "@/lib/format";
import { downloadFile, parseWatchlist, portfolioSummary } from "@/lib/portfolio";
import { AddressEntry, EditAddressLabel } from "./address-entry";
import { SyncHealth } from "./sync-health";
import { useWorkspaceView } from "@/lib/view-preferences";
import { TransactionExplorer } from "./transaction-explorer";
import { WorkspaceSettings } from "./workspace-settings";
import { useOnlineStatus, useWorkspacePreferences } from "@/lib/workspace-preferences";
import { WalletPanel } from "./wallet-panel";
import { AccountPanel } from "@/components/account-panel";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { AccountCreatorProfile } from "./account-creator-profile";

type Tab = "Overview" | "Activity" | "Wallets" | "Networks" | "Profile";
type Modal = "address" | "wallet" | "account" | "settings" | "edit" | null;
const NAV = [
  { name: "Overview", icon: LayoutDashboard },
  { name: "Activity", icon: Activity },
  { name: "Wallets", icon: Wallet },
  { name: "Networks", icon: Globe2 },
  { name: "Profile", icon: UserRound },
] as const;
const EXAMPLES = [
  {
    chain: "bitcoin" as ChainId,
    address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    label: "Bitcoin genesis",
  },
  {
    chain: "ethereum" as ChainId,
    address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    label: "vitalik.eth",
  },
];
export function Dashboard() {
  const {
    watched,
    wallets,
    hydrated,
    addWatchedBatch,
    removeWatchedBatch,
    restoreWatchedBatch,
    togglePinned,
  } = useLedger();
  const view = useWorkspaceView();
  const { tab, setTab, sort, setSort, network, setNetwork, direction, setDirection } = view;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [removedRows, setRemovedRows] = useState<WatchedAddress[]>([]);
  const preferences = useWorkspacePreferences();
  const online = useOnlineStatus();
  const canSync = preferences.hydrated && online && !preferences.syncPaused;
  const [editing, setEditing] = useState<WatchedAddress | null>(null);
  const [initialChain, setInitialChain] = useState<ChainId | undefined>();
  const [entryMode, setEntryMode] = useState<"single" | "file">("single");
  const { user } = useCurrentUserState();
  const [modal, setModal] = useState<Modal>(null);
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState("");
  const [menu, setMenu] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    if (
      !window.location.hash.startsWith("#profile=") &&
      (window.location.pathname.replace(/\/+$/, "") === "/login" ||
        (parameters.get("reset") === "1" && parameters.has("token")))
    )
      setModal("account");
  }, []);
  useEffect(() => {
    void Promise.resolve(useLedger.persist.rehydrate()).then(() =>
      useLedger.getState().setHydrated(true),
    );
  }, []);
  useEffect(() => {
    const showSharedProfile = () => {
      if (window.location.hash.startsWith("#profile=")) setTab("Profile");
    };
    showSharedProfile();
    window.addEventListener("hashchange", showSharedProfile);
    return () => window.removeEventListener("hashchange", showSharedProfile);
  }, [setTab]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(id);
  }, [toast]);
  const forceNext = useRef(false);
  const query = useQuery({
    queryKey: [
      "activity",
      watched
        .map((w) => activityKey(w.chain, w.address))
        .sort()
        .join("|"),
    ],
    queryFn: () => {
      const force = forceNext.current;
      forceNext.current = false;
      return fetchActivity({
        data: { items: watched.map(({ chain, address }) => ({ chain, address })) },
        force,
      });
    },
    enabled: hydrated && canSync && watched.length > 0,
    refetchInterval: canSync ? preferences.refreshInterval || false : false,
    staleTime: 20000,
  });
  const results = useMemo(() => query.data ?? [], [query.data]);
  const summary = portfolioSummary(results, watched.length);
  const byKey = new Map(results.map((r) => [activityKey(r.chain, r.address), r]));
  const networks = new Set(watched.map((w) => w.chain));
  const filtered = watched
    .filter(
      (w) =>
        (network === "all" || w.chain === network) &&
        `${w.label} ${w.address} ${CHAINS[w.chain].name} ${CHAINS[w.chain].symbol}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      if (sort === "label")
        return (a.label || CHAINS[a.chain].name).localeCompare(b.label || CHAINS[b.chain].name);
      if (sort === "balance") {
        const av = byKey.get(activityKey(a.chain, a.address))?.usd;
        const bv = byKey.get(activityKey(b.chain, b.address))?.usd;
        if (av == null && bv != null) return 1;
        if (bv == null && av != null) return -1;
        if (av != null && bv != null && av !== bv) return bv - av;
      }
      return b.addedAt - a.addedAt;
    });
  const selectedRows = watched.filter((w) => selectedIds.has(w.id));
  const selectedVisible = filtered.filter((w) => selectedIds.has(w.id));
  const allVisibleSelected = filtered.length > 0 && selectedVisible.length === filtered.length;
  function toggleSelection(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const row of filtered) {
        if (allVisibleSelected) next.delete(row.id);
        else next.add(row.id);
      }
      return next;
    });
  }
  function removeRows(rows: WatchedAddress[]) {
    if (!rows.length) return;
    if (
      !window.confirm(
        rows.length === 1
          ? "Remove this address from the watchlist? Wallet keys will not be deleted. You can undo this removal."
          : `Remove ${rows.length} selected addresses, including selections outside the current filter? Wallet keys will not be deleted. You can undo this removal.`,
      )
    )
      return;
    const result = removeWatchedBatch(rows.map((row) => row.id));
    if (result.error) {
      setToast(result.error);
      return;
    }
    if (!result.removed.length) {
      setToast("Those addresses are no longer in the watchlist.");
      return;
    }
    setRemovedRows(result.removed);
    setSelectedIds(
      (current) =>
        new Set([...current].filter((id) => !result.removed.some((row) => row.id === id))),
    );
    setToast(
      `Removed ${result.removed.length} ${result.removed.length === 1 ? "address" : "addresses"}. Undo is available in this tab.`,
    );
  }
  function undoRemoval() {
    const result = restoreWatchedBatch(removedRows);
    if (result.error) {
      setToast(result.error);
      return;
    }
    setRemovedRows([]);
    setToast(
      `Restored ${result.restored} ${result.restored === 1 ? "address" : "addresses"}; skipped ${result.skipped} already present.`,
    );
  }
  function refreshData() {
    if (canSync && !query.isFetching) {
      forceNext.current = true;
      void query.refetch();
    }
  }
  const transactions = useMemo(() => {
    const list = results.flatMap((r) =>
      r.txs.map((tx, index) => ({
        ...tx,
        chain: r.chain,
        address: r.address,
        id: `${r.chain}:${r.address}:${tx.hash}:${index}`,
      })),
    );
    return list.sort((a, b) => b.time - a.time);
  }, [results]);
  const visibleTx = transactions.filter(
    (t) =>
      (network === "all" || t.chain === network) &&
      (direction === "all" || direction === t.direction) &&
      `${t.hash} ${t.address} ${t.counterparty} ${t.symbol} ${watched.find((w) => activityKey(w.chain, w.address) === activityKey(t.chain, t.address))?.label ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  function openAddress(chain?: ChainId, mode: "single" | "file" = "single") {
    setInitialChain(chain);
    setEntryMode(mode);
    setModal("address");
  }
  function changeTab(value: Tab) {
    setTab(value);
    setMenu(false);
  }
  function downloadWatches(rows: WatchedAddress[], filename = "fathom-watchlist.json") {
    downloadFile(
      filename,
      JSON.stringify(
        {
          version: 1,
          addresses: rows.map(({ chain, address, label, pinned }) => ({
            chain,
            address,
            label,
            ...(pinned ? { pinned: true } : {}),
          })),
        },
        null,
        2,
      ),
    );
    setToast("Public watchlist exported. No wallet keys included.");
  }
  function exportWatches() {
    downloadWatches(watched);
  }
  function exportSelected() {
    downloadWatches(selectedRows, "fathom-selected-watchlist.json");
  }
  async function importWatches(file?: File) {
    if (!file) return;
    try {
      if (file.size > 200000) throw new Error("Watchlist file is too large.");
      const rows = parseWatchlist(JSON.parse(await file.text()));
      const result = addWatchedBatch(rows);
      if (result.error) throw new Error(result.error);
      setToast(`Imported ${result.added} addresses; ${result.skipped} already watched.`);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Could not import watchlist.");
    }
    if (importRef.current) importRef.current.value = "";
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setToast("Address copied.");
    } catch {
      setToast("Clipboard access unavailable. Select and copy the address.");
    }
  }
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menu ? "is-open" : ""}`}>
        <a
          className="brand"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            changeTab("Overview");
          }}
          aria-label="Fathom home"
        >
          <span className="brand-mark">
            f<span>·</span>
          </span>
          fathom<span className="brand-dot">®</span>
        </a>
        <div className="workspace-label">
          YOUR WORKSPACE <span>01</span>
        </div>
        <nav aria-label="Main navigation">
          {NAV.map(({ name, icon: Icon }) => (
            <button
              className={`nav-item ${tab === name ? "active" : ""}`}
              onClick={() => changeTab(name)}
              key={name}
            >
              <Icon size={19} />
              {name}
              {name === "Wallets" && wallets.length > 0 && (
                <span className="nav-count">{wallets.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <span className="sidebar-caption">WORKSPACE TOOLS</span>
        <button className="nav-item" onClick={() => setModal("account")}>
          <ShieldCheck size={19} />
          Account & security
        </button>
        <button className="nav-item" onClick={() => setModal("settings")}>
          <Settings size={19} />
          Workspace settings
        </button>
        <button className="nav-item" onClick={exportWatches}>
          <ArrowDownToLine size={19} />
          Export watchlist
        </button>
        <button className="nav-item" onClick={() => openAddress(undefined, "file")}>
          <FileUp size={19} />
          Import TXT addresses
        </button>
        <button className="nav-item" onClick={() => importRef.current?.click()}>
          <Upload size={19} />
          Import watchlist
        </button>
        <input
          type="file"
          accept=".json,application/json"
          hidden
          ref={importRef}
          onChange={(e) => void importWatches(e.target.files?.[0])}
        />
        <div className="sidebar-bottom">
          <div className="private-note">
            <span className="private-icon">
              <ShieldCheck size={20} />
            </span>
            <strong>Your keys. Your control.</strong>
            <p>Wallet keys stay encrypted in this browser. No account required.</p>
            <button onClick={() => setModal("wallet")}>
              Explore local wallets <ArrowRight size={14} />
            </button>
          </div>
          <button className="profile-button" onClick={() => setModal("account")}>
            <span className="avatar">{user?.displayName?.slice(0, 1).toUpperCase() || "G"}</span>
            <span>
              <strong>{user?.displayName || "Guest workspace"}</strong>
              <small>{user ? "Manage your account" : "Local on this device"}</small>
            </span>
            <ChevronDown size={15} />
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <button
              className="mobile-menu icon-button"
              aria-label="Toggle navigation"
              onClick={() => setMenu(!menu)}
            >
              <Menu size={20} />
            </button>
            <span className="breadcrumb">
              Workspace <span>/</span> <strong>{tab}</strong>
            </span>
          </div>
          <div className="topbar-right">
            <button
              className="icon-button"
              aria-label={preferences.hideBalances ? "Show balances" : "Hide balances"}
              aria-pressed={preferences.hideBalances}
              onClick={() => preferences.setHideBalances(!preferences.hideBalances)}
            >
              {preferences.hideBalances ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
            <span className="local-badge">
              <span />
              Browser workspace
            </span>
            <button
              className="icon-button"
              aria-label="View sync status"
              onClick={() =>
                setToast(
                  !online
                    ? "You are offline. Displayed data may be out of date."
                    : preferences.syncPaused
                      ? "Sync is paused. A refresh already in progress may finish."
                      : query.isFetching
                        ? "Fetching public chain data…"
                        : query.dataUpdatedAt
                          ? `Last updated ${new Date(query.dataUpdatedAt).toLocaleTimeString()}. ${summary.unavailable} unavailable.`
                          : "Add a public address to start tracking.",
                )
              }
            >
              <Bell size={18} />
            </button>
            <button
              className="avatar small"
              aria-label="Open account"
              onClick={() => setModal("account")}
            >
              {user?.displayName?.slice(0, 1).toUpperCase() || "G"}
            </button>
          </div>
        </header>
        <div className="page">
          <div className="page-heading">
            <div>
              <div className="eyebrow">A LITTLE CLARITY, ACROSS EVERY CHAIN</div>
              <h1>
                {tab === "Overview"
                  ? "Your crypto, in perspective."
                  : tab === "Activity"
                    ? "Follow the flow."
                    : tab === "Wallets"
                      ? "A home for your keys."
                      : tab === "Profile"
                        ? "Your corner of the internet."
                        : "Explore the networks."}
              </h1>
              <p>
                {tab === "Overview"
                  ? "One calm place for your addresses, balances, and on-chain activity."
                  : tab === "Activity"
                    ? "Recent public transactions, together in one timeline."
                    : tab === "Wallets"
                      ? "Create locally. Back up carefully. Stay in control."
                      : tab === "Profile"
                        ? "Your links, wishlist, and ways to support you, in one place."
                        : "See what each network makes available before you add an address."}
              </p>
            </div>
            <div className="heading-actions">
              <button className="button secondary" onClick={() => setModal("wallet")}>
                <KeyRound size={16} />
                Create wallet
              </button>
              <button className="button primary" onClick={() => openAddress()}>
                <Plus size={17} />
                Add address
              </button>
            </div>
          </div>
          {(!online || preferences.syncPaused) && (
            <div className="notice workspace-state" role="status">
              {!online ? <WifiOff size={18} /> : <Pause size={18} />}
              <span>
                {!online
                  ? "You are offline. Saved watchlists and local wallets are still available; displayed balances may be out of date."
                  : "Sync paused. Scheduled and manual refreshes are stopped. A refresh already in progress may finish."}
              </span>
              {online && preferences.syncPaused && (
                <button className="text-button" onClick={() => preferences.setSyncPaused(false)}>
                  Resume sync
                </button>
              )}
            </div>
          )}
          {preferences.storageError && (
            <div className="notice error" role="alert">
              {preferences.storageError}
            </div>
          )}
          {view.storageError && !preferences.storageError && (
            <div className="notice error" role="status">
              {view.storageError}
            </div>
          )}
          {removedRows.length > 0 && (
            <div className="notice removal-undo" role="status">
              <span>
                {removedRows.length} {removedRows.length === 1 ? "address" : "addresses"} removed.
                Undo restores the last removal only; it is available until this tab reloads.
              </span>
              <button className="button secondary small-button" onClick={undoRemoval}>
                <Undo2 size={15} />
                Undo removal
              </button>
              <button
                className="icon-button"
                aria-label="Dismiss undo removal"
                onClick={() => setRemovedRows([])}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {(tab === "Overview" || tab === "Activity") && (
            <>
              <SyncHealth
                results={results}
                total={watched.length}
                fetching={query.isFetching}
                updatedAt={query.dataUpdatedAt}
                online={online}
                paused={preferences.syncPaused}
                onRetry={canSync ? refreshData : undefined}
              />
              <div className="stat-grid">
                <article className="stat balance-stat">
                  <div className="stat-label">
                    {summary.complete ? "Tracked native balance" : "Known native balance"}
                    <span className="pill">USD</span>
                  </div>
                  <strong>
                    {preferences.hideBalances
                      ? "••••"
                      : summary.priced
                        ? formatUsd(summary.knownUsd)
                        : "—"}
                    <span className="stat-cents">
                      {preferences.hideBalances || summary.priced ? "" : " USD"}
                    </span>
                  </strong>
                  <small>
                    {watched.length === 0
                      ? "Add an address to see your balances"
                      : `${summary.priced} of ${watched.length} addresses valued · tokens excluded`}
                  </small>
                  <svg className="stat-decoration" viewBox="0 0 170 70" aria-hidden="true">
                    <path d="M0 60 L30 48 L50 54 L75 30 L100 35 L130 10 L150 18 L170 0" />
                  </svg>
                </article>
                <article className="stat">
                  <div className="stat-label">
                    Watched addresses
                    <Wallet size={16} />
                  </div>
                  <strong>{String(watched.length).padStart(2, "0")}</strong>
                  <small>
                    <span className="emphasis-text">Watch-only</span> · no keys needed
                  </small>
                </article>
                <article className="stat">
                  <div className="stat-label">
                    Active networks
                    <Globe2 size={16} />
                  </div>
                  <strong>{String(networks.size).padStart(2, "0")}</strong>
                  <small>Across {CHAIN_IDS.length} supported networks</small>
                </article>
                <article className="stat">
                  <div className="stat-label">
                    Recent transactions
                    <ArrowUpRight size={16} />
                  </div>
                  <strong>{String(transactions.length).padStart(2, "0")}</strong>
                  <small>Latest indexed activity · not full history</small>
                </article>
              </div>
              <div className="workspace-toolbar">
                <div className="section-tabs">
                  <button
                    className={tab === "Overview" ? "selected" : ""}
                    onClick={() => setTab("Overview")}
                  >
                    Your addresses <span>{watched.length}</span>
                  </button>
                  <button
                    className={tab === "Activity" ? "selected" : ""}
                    onClick={() => setTab("Activity")}
                  >
                    Transactions <span>{transactions.length}</span>
                  </button>
                </div>
                <div className="sync-controls">
                  <label className="refresh-select">
                    Auto-refresh
                    <select
                      aria-label="Auto-refresh interval"
                      value={preferences.refreshInterval}
                      onChange={(e) => {
                        preferences.setRefreshInterval(
                          Number(e.target.value) as 0 | 30000 | 60000 | 300000,
                        );
                      }}
                    >
                      <option value={30000}>30 seconds</option>
                      <option value={60000}>1 minute</option>
                      <option value={300000}>5 minutes</option>
                      <option value={0}>Off</option>
                    </select>
                  </label>
                  <button
                    className={`icon-button ${query.isFetching ? "spinning" : ""}`}
                    aria-label="Refresh balances"
                    disabled={!canSync || !watched.length || query.isFetching}
                    onClick={refreshData}
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
              </div>
              <div className="filters">
                <label className="search-box">
                  <Search size={17} />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={
                      tab === "Activity"
                        ? "Search transactions, counterparties, or labels"
                        : "Search addresses, labels, or assets"
                    }
                    aria-label="Search workspace"
                  />
                  {search && (
                    <button aria-label="Clear search" onClick={() => setSearch("")}>
                      <X size={14} />
                    </button>
                  )}
                </label>
                <select
                  className="filter-select"
                  aria-label="Filter by network"
                  value={network}
                  onChange={(e) => setNetwork(e.target.value)}
                >
                  <option value="all">All networks</option>
                  {CHAIN_IDS.map((id) => (
                    <option value={id} key={id}>
                      {chainLabel(id)}
                    </option>
                  ))}
                </select>
                {tab === "Overview" && (
                  <select
                    className="filter-select"
                    aria-label="Sort addresses"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="recent">Recently added</option>
                    <option value="label">Label A–Z</option>
                    <option value="balance">Highest known USD</option>
                  </select>
                )}
                {tab === "Activity" && (
                  <select
                    className="filter-select"
                    aria-label="Filter by direction"
                    value={direction}
                    onChange={(e) => setDirection(e.target.value)}
                  >
                    <option value="all">All directions</option>
                    <option value="in">Received</option>
                    <option value="out">Sent</option>
                    <option value="self">Other activity</option>
                  </select>
                )}
                {(search ||
                  network !== "all" ||
                  direction !== "all" ||
                  sort !== "recent" ||
                  view.status !== "all" ||
                  view.range !== "all") && (
                  <button
                    className="button secondary reset-view"
                    onClick={() => {
                      view.resetView();
                      setSearch("");
                    }}
                  >
                    Reset view
                  </button>
                )}
              </div>
              {tab === "Overview" && watched.length > 0 && (
                <div className="address-selection-bar">
                  <label className="select-visible">
                    <input
                      type="checkbox"
                      aria-label="Select visible addresses"
                      checked={allVisibleSelected}
                      ref={(input) => {
                        if (input)
                          input.indeterminate = selectedVisible.length > 0 && !allVisibleSelected;
                      }}
                      disabled={!filtered.length}
                      onChange={selectVisible}
                    />
                    <span>{selectedRows.length} selected across all filters</span>
                  </label>
                  <div>
                    <button
                      className="text-button"
                      disabled={!selectedRows.length}
                      onClick={() => setSelectedIds(new Set())}
                    >
                      Clear selection
                    </button>
                    <button
                      className="button secondary small-button"
                      disabled={!selectedRows.length}
                      onClick={exportSelected}
                    >
                      <ArrowDownToLine size={14} />
                      Export selected
                    </button>
                    <button
                      className="button secondary small-button"
                      disabled={!selectedRows.length}
                      onClick={() => removeRows(selectedRows)}
                    >
                      <Trash2 size={14} />
                      Remove selected
                    </button>
                  </div>
                </div>
              )}
              {query.isError && (
                <div className="notice error" role="alert">
                  Could not update this workspace. {query.error.message}{" "}
                  <button
                    disabled={!canSync}
                    onClick={() => {
                      if (canSync) void query.refetch();
                    }}
                  >
                    Try again
                  </button>
                </div>
              )}
              {tab === "Overview" ? (
                <div className="content-columns">
                  <section className="address-area">
                    {!hydrated ? (
                      <div className="empty-panel">Opening your local workspace…</div>
                    ) : !watched.length ? (
                      <div className="empty-panel address-empty">
                        <div className="empty-illustration">
                          <span>
                            <Wallet size={32} />
                          </span>
                          <span className="orbit orbit-one">₿</span>
                          <span className="orbit orbit-two">Ξ</span>
                          <span className="orbit orbit-three">◎</span>
                        </div>
                        <span className="eyebrow">YOUR NEXT CHAPTER STARTS HERE</span>
                        <h2>
                          All your addresses.
                          <br />A clearer picture.
                        </h2>
                        <p>
                          Add a public address to bring its balance and recent transactions into
                          your workspace.
                        </p>
                        <button className="button primary" onClick={() => openAddress()}>
                          <Plus size={17} />
                          Watch your first address
                        </button>
                        <button
                          className="text-button"
                          onClick={() => {
                            const result = addWatchedBatch(EXAMPLES);
                            if (result.error) {
                              setToast(result.error);
                              return;
                            }
                            setToast(
                              "Added two public example addresses. Public providers may rate-limit requests.",
                            );
                          }}
                        >
                          Or explore with public examples <ArrowRight size={14} />
                        </button>
                      </div>
                    ) : filtered.length ? (
                      filtered.map((w) => {
                        const data = byKey.get(activityKey(w.chain, w.address));
                        return (
                          <article
                            className={`address-card ${w.pinned ? "pinned-address" : ""}`}
                            key={w.id}
                          >
                            <div className="address-card-top">
                              <input
                                className="select-address"
                                type="checkbox"
                                aria-label={`Select ${w.label || w.address}`}
                                checked={selectedIds.has(w.id)}
                                onChange={() => toggleSelection(w.id)}
                              />
                              <ChainIcon chain={w.chain} />
                              <div className="address-identity">
                                <h3>{w.label || CHAINS[w.chain].name + " address"}</h3>
                                <span>
                                  {chainLabel(w.chain)}
                                  <span className="tiny-dot" />
                                  {w.walletId ? "Local wallet" : "Watch-only"}
                                </span>
                              </div>
                              <div className="address-tools">
                                <button
                                  className="icon-button"
                                  aria-label={`${w.pinned ? "Unpin" : "Pin"} ${w.label || w.address}`}
                                  aria-pressed={Boolean(w.pinned)}
                                  onClick={() => {
                                    const failure = togglePinned(w.id);
                                    if (failure) setToast(failure);
                                  }}
                                >
                                  <Pin size={15} />
                                </button>
                                <button
                                  className="icon-button"
                                  aria-label={`Edit label for ${w.label || w.address}`}
                                  onClick={() => {
                                    setEditing(w);
                                    setModal("edit");
                                  }}
                                >
                                  <Pencil size={15} />
                                </button>
                                <button
                                  className="icon-button remove-address"
                                  aria-label={`Remove ${w.label || w.address}`}
                                  onClick={() => removeRows([w])}
                                >
                                  <Trash2 size={15} />
                                </button>
                              </div>
                            </div>
                            <div className="address-body">
                              <div className="address-public">
                                <code title={w.address}>{shortAddress(w.address)}</code>
                                <button
                                  className="icon-button"
                                  aria-label={`Copy ${w.label || w.address}`}
                                  onClick={() => void copy(w.address)}
                                >
                                  <Copy size={13} />
                                </button>
                                <a
                                  className="icon-button"
                                  href={CHAINS[w.chain].addressUrl(w.address)}
                                  target="_blank"
                                  rel="noreferrer"
                                  aria-label={`View ${w.label || w.address} in explorer`}
                                >
                                  <ExternalLink size={13} />
                                </a>
                              </div>
                              <div className="address-balance">
                                <strong>
                                  {preferences.hideBalances
                                    ? "••••"
                                    : data?.ok
                                      ? data.balance
                                      : "—"}{" "}
                                  <small>{CHAINS[w.chain].symbol}</small>
                                </strong>
                                <span>
                                  {preferences.hideBalances
                                    ? "Hidden"
                                    : data?.usd != null
                                      ? formatUsd(data.usd)
                                      : "USD value unavailable"}
                                </span>
                              </div>
                            </div>
                            <div className={`address-status ${data && !data.ok ? "warn" : ""}`}>
                              <span className="status-dot" />
                              {!data
                                ? query.isFetching
                                  ? "Fetching public activity…"
                                  : "Waiting for refresh"
                                : !data.ok
                                  ? data.error || "Provider unavailable"
                                  : data.historyNote ||
                                    `${data.txs.length} recent transactions · live balance`}
                            </div>
                          </article>
                        );
                      })
                    ) : (
                      <div className="empty-panel compact">
                        <Search size={28} />
                        <h3>No matching addresses</h3>
                        <p>Try another search or network.</p>
                      </div>
                    )}
                  </section>
                  <section className="panel activity-preview">
                    <div className="panel-heading">
                      <h2>Recent activity</h2>
                      <button className="text-button" onClick={() => setTab("Activity")}>
                        View all <ArrowUpRight size={14} />
                      </button>
                    </div>
                    {visibleTx.length ? (
                      <div>
                        {visibleTx.slice(0, 6).map((t) => (
                          <a
                            className="mini-tx"
                            key={t.id}
                            href={CHAINS[t.chain].txUrl(t.hash)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <span className={`direction-icon ${t.direction}`}>
                              {t.direction === "in" ? (
                                <ArrowDownLeft size={17} />
                              ) : (
                                <ArrowUpRight size={17} />
                              )}
                            </span>
                            <div>
                              <strong>
                                {t.direction === "in"
                                  ? "Received"
                                  : t.direction === "out"
                                    ? "Sent"
                                    : "Activity"}{" "}
                                {t.symbol}
                              </strong>
                              <small>
                                {chainLabel(t.chain)} · {formatTransactionDate(t.time)}
                              </small>
                            </div>
                            <div className="tx-value">
                              <strong>
                                {preferences.hideBalances
                                  ? "••••"
                                  : `${t.direction === "in" ? "+" : t.direction === "out" ? "−" : ""}${t.amount}`}
                              </strong>
                              <small>
                                {t.status === "failed"
                                  ? "Failed"
                                  : t.status === "pending"
                                    ? "Pending"
                                    : shortAddress(t.counterparty)}
                              </small>
                            </div>
                          </a>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-activity">
                        <div className="empty-lines">
                          <i />
                          <i />
                          <i />
                        </div>
                        <span className="empty-activity-icon">
                          <Activity size={23} />
                        </span>
                        <h3>A little quiet here.</h3>
                        <p>
                          {watched.length
                            ? "Recent transactions appear here when an explorer returns them."
                            : "Your transactions will appear here once you add an address."}
                        </p>
                      </div>
                    )}
                    <div className="panel-footer">
                      <span className="status-dot" />{" "}
                      {!online
                        ? "Offline · data may be out of date"
                        : preferences.syncPaused
                          ? "Sync paused"
                          : query.isFetching
                            ? "Updating public data…"
                            : query.dataUpdatedAt
                              ? `Updated ${relativeTime(query.dataUpdatedAt)}`
                              : "Ready when you are"}
                    </div>
                  </section>
                </div>
              ) : (
                <TransactionExplorer
                  transactions={transactions}
                  watches={watched}
                  search={search}
                  network={network}
                  direction={direction}
                  hideBalances={preferences.hideBalances}
                  onResetFilters={() => {
                    setSearch("");
                    setNetwork("all");
                    setDirection("all");
                  }}
                />
              )}
            </>
          )}
          {tab === "Wallets" && (
            <section className="panel wallets-page">
              <div className="panel-heading">
                <h2>
                  Local encrypted wallets <span className="pill">{wallets.length}</span>
                </h2>
                <button className="button primary" onClick={() => setModal("wallet")}>
                  <Plus size={17} />
                  Open wallet manager
                </button>
              </div>
              <div className="wallet-intro">
                <div className="feature-icon">
                  <KeyRound size={30} />
                </div>
                <h2>Keys that stay with you.</h2>
                <p>
                  A recovery phrase creates addresses in your browser. Protect its local copy with
                  your own passphrase and keep an offline backup. Your platform account cannot
                  recover your keys.
                </p>
                <div className="wallet-feature-grid">
                  <div>
                    <ShieldCheck size={22} />
                    <h3>Encrypted locally</h3>
                    <p>AES-GCM encryption. Your passphrase is never saved.</p>
                  </div>
                  <div>
                    <Globe2 size={22} />
                    <h3>One phrase, many chains</h3>
                    <p>Bitcoin, Ethereum, Solana, Cosmos, XRP, and NEAR.</p>
                  </div>
                  <div>
                    <ArrowDownToLine size={22} />
                    <h3>Portable backups</h3>
                    <p>Export and restore a passphrase-encrypted wallet file.</p>
                  </div>
                </div>
                <button className="button primary" onClick={() => setModal("wallet")}>
                  {wallets.length ? "Manage local wallets" : "Create or restore a wallet"}
                  <ArrowRight size={16} />
                </button>
              </div>
              <div className="notice">
                Experimental software; not independently audited. Start with test amounts. Identity
                verification and service custody are not enabled.
              </div>
            </section>
          )}
          {tab === "Networks" && (
            <>
              <div className="network-page-note notice">
                <Globe2 size={19} />
                <span>
                  Public data comes directly from third-party explorers. Availability, CORS, and
                  rate limits vary. Adding an address shares it with that network’s providers.
                  Address format checks do not prove ownership.
                </span>
              </div>
              <div className="network-grid">
                {CHAIN_IDS.map((id) => (
                  <NetworkCard key={id} chain={id} onAdd={() => openAddress(id)} />
                ))}
              </div>
            </>
          )}
          {tab === "Overview" && (
            <section className="network-strip">
              <div>
                <span className="eyebrow">MANY CHAINS. ONE WORKSPACE.</span>
                <h2>Go beyond a single network.</h2>
                <p>From Bitcoin to Cosmos, see more of your on-chain world.</p>
              </div>
              <div className="network-strip-icons">
                {(["bitcoin", "ethereum", "solana", "cosmos", "near", "xrp"] as ChainId[])
                  .filter((id) => id in CHAINS)
                  .map((id) => (
                    <ChainIcon key={id} chain={id} />
                  ))}
                <button className="text-button" onClick={() => setTab("Networks")}>
                  Explore all {CHAIN_IDS.length} <ArrowRight size={15} />
                </button>
              </div>
            </section>
          )}
          <div hidden={tab !== "Profile"}>
            <AccountCreatorProfile onOpenAccount={() => setModal("account")} />
          </div>
          <footer className="page-footer">
            <span>
              <span className="footer-brand">fathom</span> A clearer view of your on-chain world.
            </span>
            <span>
              <ShieldCheck size={13} /> Watchlists are local to this browser
            </span>
          </footer>
        </div>
      </main>
      <Dialog.Root
        open={modal !== null}
        onOpenChange={(open) => {
          if (!open) setModal(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className={`dialog-content ${modal === "wallet" ? "wide-dialog" : ""}`}
            aria-describedby="modal-description"
          >
            <Dialog.Title className="sr-only">
              {modal === "address"
                ? "Add a public address"
                : modal === "wallet"
                  ? "Local wallets"
                  : modal === "settings"
                    ? "Workspace settings"
                    : modal === "edit"
                      ? "Edit address label"
                      : "Account and security"}
            </Dialog.Title>
            <Dialog.Description className="sr-only" id="modal-description">
              {modal === "address"
                ? "Watch a public blockchain address. No private keys needed."
                : modal === "wallet"
                  ? "Create, unlock, and back up local encrypted wallets."
                  : modal === "settings"
                    ? "Manage privacy and public-data syncing on this browser."
                    : modal === "edit"
                      ? "Rename a watched address."
                      : "Manage sign-in methods and two-factor authentication."}
            </Dialog.Description>
            <Dialog.Close className="dialog-close icon-button" aria-label="Close dialog">
              <X size={20} />
            </Dialog.Close>
            {modal === "address" ? (
              <AddressEntry
                initialChain={initialChain}
                initialMode={entryMode}
                onClose={() => setModal(null)}
                onAdded={setToast}
              />
            ) : modal === "edit" && editing ? (
              <EditAddressLabel
                address={editing}
                onClose={() => setModal(null)}
                onSaved={() => setToast("Address label updated.")}
              />
            ) : modal === "settings" ? (
              <WorkspaceSettings
                onClose={() => setModal(null)}
                onExportWatchlist={exportWatches}
                onOpenWallet={() => setModal("wallet")}
              />
            ) : modal === "wallet" ? (
              <WalletPanel onClose={() => setModal(null)} />
            ) : modal === "account" ? (
              <AccountPanel onClose={() => setModal(null)} />
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {toast && (
        <div className="toast" role="status">
          <CheckCheck size={17} />
          {toast}
          <button aria-label="Dismiss notification" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
export function ChainIcon({ chain }: { chain: ChainId }) {
  const c = CHAINS[chain];
  const symbols: Record<string, string> = {
    bitcoin: "₿",
    ethereum: "Ξ",
    solana: "≋",
    near: "N",
    xrp: "X",
    polkadot: "●",
    monero: "ɱ",
  };
  return (
    <span className={`chain-icon chain-${chain}`} aria-label={c.name}>
      {chain === "cosmos" ? <Atom size={20} /> : symbols[chain] || c.monogram.slice(0, 3)}
    </span>
  );
}
function NetworkCard({ chain, onAdd }: { chain: ChainId; onAdd: () => void }) {
  const c = CHAINS[chain];
  const meta = c as typeof c & { tracking?: string; note?: string };
  const mode =
    meta.tracking === "private"
      ? "Private history"
      : meta.tracking === "indexer-required"
        ? "Indexer required"
        : meta.tracking === "balance-only"
          ? "Balance only"
          : "Public activity";
  return (
    <article className="panel network-card">
      <div>
        <ChainIcon chain={chain} />
        <span
          className={`pill ${mode === "Private history" || mode === "Indexer required" ? "neutral-pill" : ""}`}
        >
          {mode}
        </span>
      </div>
      <h3>{chainLabel(chain)}</h3>
      <p>
        {meta.note ||
          "Public balance and recent indexed transactions. Provider availability may vary."}
      </p>
      <button className="text-button" onClick={onAdd}>
        Watch an address <Plus size={14} />
      </button>
    </article>
  );
}
