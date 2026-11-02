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
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  ExternalLink,
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
  X,
} from "lucide-react";
import {
  CHAINS,
  CHAIN_IDS,
  activityKey,
  detectFamily,
  isValidAddress,
  type ChainId,
} from "@/lib/chains";
import { fetchActivity } from "@/lib/activity.functions";
import { useLedger } from "@/lib/ledger-store";
import { formatUsd, relativeTime, shortAddress } from "@/lib/format";
import { csvCell, downloadFile, parseWatchlist, portfolioSummary } from "@/lib/portfolio";
import { WalletPanel } from "./wallet-panel";
import { AccountPanel } from "@/components/account-panel";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

type Tab = "Overview" | "Activity" | "Wallets" | "Networks";
type Modal = "address" | "wallet" | "account" | null;
const NAV = [
  { name: "Overview", icon: LayoutDashboard },
  { name: "Activity", icon: Activity },
  { name: "Wallets", icon: Wallet },
  { name: "Networks", icon: Globe2 },
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
  const { watched, wallets, hydrated, addWatched, removeWatched } = useLedger();
  const { user } = useCurrentUserState();
  const [tab, setTab] = useState<Tab>("Overview");
  const [modal, setModal] = useState<Modal>(null);
  const [search, setSearch] = useState("");
  const [network, setNetwork] = useState("all");
  const [direction, setDirection] = useState("all");
  const [interval, setIntervalValue] = useState(60000);
  const [toast, setToast] = useState("");
  const [menu, setMenu] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void Promise.resolve(useLedger.persist.rehydrate()).then(() =>
      useLedger.getState().setHydrated(true),
    );
    const value = localStorage.getItem("fathom.refresh");
    if (value && ["0", "30000", "60000", "300000"].includes(value)) setIntervalValue(Number(value));
  }, []);
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
    enabled: hydrated && watched.length > 0,
    refetchInterval: interval || false,
    staleTime: 20000,
  });
  const results = useMemo(() => query.data ?? [], [query.data]);
  const summary = portfolioSummary(results, watched.length);
  const byKey = new Map(results.map((r) => [activityKey(r.chain, r.address), r]));
  const networks = new Set(watched.map((w) => w.chain));
  const filtered = watched.filter(
    (w) =>
      (network === "all" || w.chain === network) &&
      `${w.label} ${w.address} ${CHAINS[w.chain].name} ${CHAINS[w.chain].symbol}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
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
      `${t.hash} ${t.address} ${t.symbol} ${watched.find((w) => activityKey(w.chain, w.address) === activityKey(t.chain, t.address))?.label ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  function changeTab(value: Tab) {
    setTab(value);
    setMenu(false);
  }
  function exportWatches() {
    downloadFile(
      "fathom-watchlist.json",
      JSON.stringify(
        {
          version: 1,
          addresses: watched.map(({ chain, address, label }) => ({ chain, address, label })),
        },
        null,
        2,
      ),
    );
    setToast("Public watchlist exported. No wallet keys included.");
  }
  async function importWatches(file?: File) {
    if (!file) return;
    try {
      if (file.size > 200000) throw new Error("Watchlist file is too large.");
      const rows = parseWatchlist(JSON.parse(await file.text()));
      const current = new Set(watched.map((w) => activityKey(w.chain, w.address)));
      const fresh = rows.filter((r) => !current.has(activityKey(r.chain, r.address)));
      if (watched.length + fresh.length > 100)
        throw new Error("Import would exceed 100 addresses.");
      for (const row of fresh) {
        const error = addWatched(row);
        if (error) throw new Error(error);
      }
      setToast(
        `Imported ${fresh.length} addresses; ${rows.length - fresh.length} already watched.`,
      );
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Could not import watchlist.");
    }
    if (importRef.current) importRef.current.value = "";
  }
  function exportTx() {
    const rows = [
      ["Network", "Address", "Hash", "Date", "Direction", "Amount", "Asset", "Status"],
      ...visibleTx.map((t) => [
        CHAINS[t.chain].name,
        t.address,
        t.hash,
        t.time ? new Date(t.time).toISOString() : "Unconfirmed",
        t.direction,
        t.amount,
        t.symbol,
        t.status,
      ]),
    ];
    downloadFile(
      "fathom-transactions.csv",
      rows.map((r) => r.map(csvCell).join(",")).join("\r\n"),
      "text/csv;charset=utf-8",
    );
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
        <button className="nav-item" onClick={exportWatches}>
          <ArrowDownToLine size={19} />
          Export watchlist
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
            <span className="local-badge">
              <span />
              Browser workspace
            </span>
            <button
              className="icon-button"
              aria-label="View sync status"
              onClick={() =>
                setToast(
                  query.isFetching
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
                      : "Explore the networks."}
              </h1>
              <p>
                {tab === "Overview"
                  ? "One calm place for your addresses, balances, and on-chain activity."
                  : tab === "Activity"
                    ? "Recent public transactions, together in one timeline."
                    : tab === "Wallets"
                      ? "Create locally. Back up carefully. Stay in control."
                      : "See what each network makes available before you add an address."}
              </p>
            </div>
            <div className="heading-actions">
              <button className="button secondary" onClick={() => setModal("wallet")}>
                <KeyRound size={16} />
                Create wallet
              </button>
              <button className="button primary" onClick={() => setModal("address")}>
                <Plus size={17} />
                Add address
              </button>
            </div>
          </div>
          {(tab === "Overview" || tab === "Activity") && (
            <>
              <div className="stat-grid">
                <article className="stat balance-stat">
                  <div className="stat-label">
                    {summary.complete ? "Tracked native balance" : "Known native balance"}
                    <span className="pill">USD</span>
                  </div>
                  <strong>
                    {summary.priced ? formatUsd(summary.knownUsd) : "—"}
                    <span className="stat-cents">{summary.priced ? "" : " USD"}</span>
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
                      value={interval}
                      onChange={(e) => {
                        setIntervalValue(Number(e.target.value));
                        localStorage.setItem("fathom.refresh", e.target.value);
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
                    disabled={!watched.length || query.isFetching}
                    onClick={() => {
                      forceNext.current = true;
                      void query.refetch();
                    }}
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
                    placeholder="Search addresses, labels, or assets"
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
                      {CHAINS[id].name}
                    </option>
                  ))}
                </select>
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
              </div>
              {query.isError && (
                <div className="notice error" role="alert">
                  Could not update this workspace. {query.error.message}{" "}
                  <button onClick={() => void query.refetch()}>Try again</button>
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
                        <button className="button primary" onClick={() => setModal("address")}>
                          <Plus size={17} />
                          Watch your first address
                        </button>
                        <button
                          className="text-button"
                          onClick={() => {
                            EXAMPLES.forEach((row) => addWatched(row));
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
                          <article className="address-card" key={w.id}>
                            <div className="address-card-top">
                              <ChainIcon chain={w.chain} />
                              <div className="address-identity">
                                <h3>{w.label || CHAINS[w.chain].name + " address"}</h3>
                                <span>
                                  {CHAINS[w.chain].name}
                                  <span className="tiny-dot" />
                                  {w.walletId ? "Local wallet" : "Watch-only"}
                                </span>
                              </div>
                              <button
                                className="icon-button remove-address"
                                aria-label={`Remove ${w.label || w.address}`}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      "Remove this address from the watchlist? Wallet keys will not be deleted.",
                                    )
                                  )
                                    removeWatched(w.id);
                                }}
                              >
                                <Trash2 size={15} />
                              </button>
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
                                  {data?.ok ? data.balance : "—"}{" "}
                                  <small>{CHAINS[w.chain].symbol}</small>
                                </strong>
                                <span>
                                  {data?.usd != null
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
                                {CHAINS[t.chain].name} · {relativeTime(t.time)}
                              </small>
                            </div>
                            <div className="tx-value">
                              <strong>
                                {t.direction === "in" ? "+" : t.direction === "out" ? "−" : ""}
                                {t.amount}
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
                      {query.isFetching
                        ? "Updating public data…"
                        : query.dataUpdatedAt
                          ? `Updated ${relativeTime(query.dataUpdatedAt)}`
                          : "Ready when you are"}
                    </div>
                  </section>
                </div>
              ) : (
                <section className="panel transaction-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Transaction history</h2>
                      <p>
                        Native transfers and indexed tokens where available. One row per watched
                        address.
                      </p>
                    </div>
                    <button
                      className="button secondary small-button"
                      disabled={!visibleTx.length}
                      onClick={exportTx}
                    >
                      <ArrowDownToLine size={15} />
                      Export CSV
                    </button>
                  </div>
                  {visibleTx.length ? (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Transaction</th>
                            <th>Network / address</th>
                            <th>Amount</th>
                            <th>When</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleTx.map((t) => (
                            <tr key={t.id}>
                              <td>
                                <a
                                  href={CHAINS[t.chain].txUrl(t.hash)}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  <span className={`table-direction ${t.direction}`}>
                                    {t.direction === "in" ? (
                                      <ArrowDownLeft size={16} />
                                    ) : (
                                      <ArrowUpRight size={16} />
                                    )}
                                  </span>
                                  {shortAddress(t.hash)} <ExternalLink size={12} />
                                </a>
                              </td>
                              <td>
                                {CHAINS[t.chain].name}
                                <small>{shortAddress(t.address)}</small>
                              </td>
                              <td className={t.direction === "in" ? "emphasis-text" : ""}>
                                {t.direction === "in" ? "+" : t.direction === "out" ? "−" : ""}
                                {t.amount} {t.symbol}
                              </td>
                              <td>{relativeTime(t.time)}</td>
                              <td>
                                <span className={`pill ${t.status === "failed" ? "failure" : ""}`}>
                                  {t.status === "failed"
                                    ? "Failed"
                                    : t.status === "pending"
                                      ? "Pending"
                                      : "Observed"}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="empty-panel compact">
                      <Activity size={30} />
                      <h3>No transactions to show</h3>
                      <p>
                        {watched.length
                          ? "Try a different filter, refresh, or check provider availability on Overview."
                          : "Add an address to load its recent activity."}
                      </p>
                    </div>
                  )}
                </section>
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
                  <NetworkCard key={id} chain={id} onAdd={() => setModal("address")} />
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
                  : "Account and security"}
            </Dialog.Title>
            <Dialog.Description className="sr-only" id="modal-description">
              {modal === "address"
                ? "Watch a public blockchain address. No private keys needed."
                : modal === "wallet"
                  ? "Create, unlock, and back up local encrypted wallets."
                  : "Manage sign-in methods and two-factor authentication."}
            </Dialog.Description>
            <Dialog.Close className="dialog-close icon-button" aria-label="Close dialog">
              <X size={20} />
            </Dialog.Close>
            {modal === "address" ? (
              <AddAddress
                onClose={() => setModal(null)}
                onAdded={() => setToast("Address added. Fetching public activity…")}
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
      <h3>
        {c.name}
        <span>{c.symbol}</span>
      </h3>
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
function AddAddress({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [chain, setChain] = useState<ChainId>("ethereum");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [ack, setAck] = useState(false);
  const addWatched = useLedger((s) => s.addWatched);
  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!ack) {
      setError("Acknowledge public provider access to continue.");
      return;
    }
    const err = addWatched({ chain, address, label });
    if (err) {
      setError(err);
      return;
    }
    onAdded();
    onClose();
  }
  function pasteAddress(value: string) {
    setAddress(value);
    const family = detectFamily(value);
    if (family === "bitcoin" || family === "solana") setChain(family);
    else if (family === "evm" && CHAINS[chain].family !== "evm") setChain("ethereum");
  }
  return (
    <form onSubmit={submit} className="add-address-form">
      <span className="modal-symbol">
        <Plus size={24} />
      </span>
      <span className="eyebrow">WATCH, WITHOUT CONNECTING</span>
      <h2>Add a public address</h2>
      <p>
        Its balance and recent activity arrive automatically. No wallet connection or private key
        needed.
      </p>
      <label>
        Network
        <select
          aria-label="Network"
          className="form-input"
          value={chain}
          onChange={(e) => setChain(e.target.value as ChainId)}
        >
          {CHAIN_IDS.map((id) => (
            <option key={id} value={id}>
              {CHAINS[id].name} · {CHAINS[id].symbol}
            </option>
          ))}
        </select>
      </label>
      <label>
        Public address
        <input
          className="form-input mono"
          placeholder="Paste your public wallet address"
          value={address}
          maxLength={160}
          onChange={(e) => pasteAddress(e.target.value)}
          required
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {address && (
        <span
          className={
            isValidAddress(chain, address)
              ? "emphasis-text validation-message"
              : "muted validation-message"
          }
        >
          {isValidAddress(chain, address) ? (
            <>
              <Check size={13} />
              Address format matches {CHAINS[chain].name}
            </>
          ) : (
            "Check the address and selected network."
          )}
        </span>
      )}
      <label>
        Label <span className="optional">optional</span>
        <input
          className="form-input"
          placeholder="e.g. Long-term holdings"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={80}
        />
      </label>
      <label className="checkbox-label">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>
          I understand this address will be queried with public blockchain providers. This does not
          verify ownership.
        </span>
      </label>
      {["monero", "polkadot", "kusama"].includes(chain) && (
        <div className="notice">
          {chain === "monero"
            ? "Monero hides transaction details. An address alone cannot show balance or history. This address will be saved without public data."
            : "Native free balances can be queried. Transaction history requires an indexer; use the linked explorer."}
        </div>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <button
        className="button primary full-width"
        disabled={!ack || !isValidAddress(chain, address)}
      >
        <Plus size={17} />
        Add to workspace
      </button>
      <div className="form-footnote">
        <ShieldCheck size={13} />
        Never paste a recovery phrase or private key here.
      </div>
    </form>
  );
}
