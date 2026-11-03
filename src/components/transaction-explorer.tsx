import { useState } from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpRight,
  ExternalLink,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { CHAINS, CHAIN_IDS, activityKey, chainLabel } from "@/lib/chains";
import { formatTransactionDate, shortAddress } from "@/lib/format";
import { downloadFile } from "@/lib/portfolio";
import {
  filterTransactions,
  transactionsCsv,
  transactionTimeIso,
  type ExplorerTransaction,
  type TransactionRange,
  type TransactionWatch,
} from "@/lib/transactions";
import "./transaction-explorer.css";

export type { ExplorerTransaction } from "@/lib/transactions";
export type TransactionExplorerProps = {
  transactions: readonly ExplorerTransaction[];
  watches: readonly TransactionWatch[];
  search?: string;
  network?: string;
  direction?: string;
  hideBalances?: boolean;
  onResetFilters?: () => void;
};

export function TransactionExplorer({
  transactions,
  watches,
  search,
  network,
  direction,
  hideBalances = false,
  onResetFilters,
}: TransactionExplorerProps) {
  const [localSearch, setLocalSearch] = useState("");
  const [localNetwork, setLocalNetwork] = useState("all");
  const [localDirection, setLocalDirection] = useState("all");
  const [address, setAddress] = useState("all");
  const [status, setStatus] = useState("all");
  const [range, setRange] = useState<TransactionRange>("all");
  const [exportError, setExportError] = useState("");
  const filters = {
    search: search ?? localSearch,
    network: network ?? localNetwork,
    direction: direction ?? localDirection,
    address,
    status,
    range,
  };
  const rows = filterTransactions(transactions, watches, filters);
  const hasAdvancedFilters = address !== "all" || status !== "all" || range !== "all";
  const hasExternalFilters = Boolean(
    search?.trim() || (network && network !== "all") || (direction && direction !== "all"),
  );
  const hasFilters =
    hasAdvancedFilters ||
    filters.search.trim() !== "" ||
    filters.network !== "all" ||
    filters.direction !== "all";
  const canResetEverything = !hasExternalFilters || Boolean(onResetFilters);
  const reset = () => {
    setAddress("all");
    setStatus("all");
    setRange("all");
    setLocalSearch("");
    setLocalNetwork("all");
    setLocalDirection("all");
    setExportError("");
    onResetFilters?.();
  };
  const uniqueWatches = [
    ...new Map(watches.map((watch) => [activityKey(watch.chain, watch.address), watch])).values(),
  ];
  const exportCsv = () => {
    try {
      downloadFile(
        "fathom-transactions.csv",
        transactionsCsv(rows, watches),
        "text/csv;charset=utf-8",
      );
      setExportError("");
    } catch {
      setExportError("The CSV could not be downloaded. Please retry.");
    }
  };
  return (
    <section className="panel transaction-panel tx-explorer" aria-label="Transaction explorer">
      <div className="panel-heading">
        <div>
          <h2>Transaction history</h2>
          <p>
            Recent native transfers and indexed tokens where available. One row per watched address;
            this is not complete chain history. Token-standard labels identify the network; asset
            coverage varies by provider.
          </p>
        </div>
        <button
          className="button secondary small-button"
          type="button"
          disabled={!rows.length}
          onClick={exportCsv}
        >
          <ArrowDownToLine size={15} />
          Export CSV
        </button>
      </div>
      <div className="tx-controls">
        {search === undefined && (
          <label className="tx-search">
            <Search size={16} />
            <span className="sr-only">Search transactions</span>
            <input
              value={localSearch}
              onChange={(event) => setLocalSearch(event.target.value)}
              placeholder="Hash, address, counterparty, or label"
            />
            {localSearch && (
              <button
                type="button"
                aria-label="Clear transaction search"
                onClick={() => setLocalSearch("")}
              >
                <X size={14} />
              </button>
            )}
          </label>
        )}
        {network === undefined && (
          <label className="tx-filter-label">
            Network
            <select
              aria-label="Transaction network"
              value={localNetwork}
              onChange={(event) => setLocalNetwork(event.target.value)}
            >
              <option value="all">All networks</option>
              {CHAIN_IDS.map((id) => (
                <option value={id} key={id}>
                  {chainLabel(id)}
                </option>
              ))}
            </select>
          </label>
        )}
        {direction === undefined && (
          <label className="tx-filter-label">
            Direction
            <select
              aria-label="Transaction direction"
              value={localDirection}
              onChange={(event) => setLocalDirection(event.target.value)}
            >
              <option value="all">All directions</option>
              <option value="in">Received</option>
              <option value="out">Sent</option>
              <option value="self">Other activity</option>
            </select>
          </label>
        )}
        <label className="tx-filter-label tx-address-filter">
          Watched address
          <select
            aria-label="Filter transactions by watched address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          >
            <option value="all">All watched addresses</option>
            {uniqueWatches.map((watch) => (
              <option
                key={activityKey(watch.chain, watch.address)}
                value={activityKey(watch.chain, watch.address)}
              >
                {watch.label || shortAddress(watch.address)} · {chainLabel(watch.chain)} ·{" "}
                {shortAddress(watch.address)}
              </option>
            ))}
          </select>
        </label>
        <label className="tx-filter-label">
          Status
          <select
            aria-label="Filter transactions by status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="ok">Observed</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <label className="tx-filter-label">
          Time window
          <select
            aria-label="Filter transactions by time"
            value={range}
            onChange={(event) => setRange(event.target.value as TransactionRange)}
          >
            <option value="all">All fetched dates</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </label>
        <button
          className="tx-reset"
          type="button"
          disabled={!hasFilters || (!canResetEverything && !hasAdvancedFilters)}
          onClick={reset}
        >
          <RotateCcw size={14} />
          {canResetEverything ? "Reset filters" : "Reset advanced filters"}
        </button>
      </div>
      <div className="tx-results-summary">
        <span role="status">
          {rows.length} of {transactions.length} recent {transactions.length === 1 ? "row" : "rows"}
        </span>
        <span>
          {hideBalances
            ? "Amounts hidden on screen. CSV exports include actual amounts and public addresses."
            : "CSV exports include the filtered rows and public addresses."}
        </span>
      </div>
      {exportError && (
        <p className="tx-export-error" role="alert">
          {exportError}
        </p>
      )}
      {rows.length ? (
        <div className="table-scroll tx-table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Transaction</th>
                <th scope="col">Network / watched address</th>
                <th scope="col">Amount</th>
                <th scope="col">Date (UTC)</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((tx) => {
                const label = watches.find(
                  (watch) =>
                    activityKey(watch.chain, watch.address) === activityKey(tx.chain, tx.address),
                )?.label;
                const timestamp = transactionTimeIso(tx.time);
                const directionLabel =
                  tx.direction === "in"
                    ? "Received"
                    : tx.direction === "out"
                      ? "Sent"
                      : "Other activity";
                return (
                  <tr key={tx.id}>
                    <td>
                      <a
                        href={CHAINS[tx.chain].txUrl(tx.hash)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`View ${tx.hash} in ${chainLabel(tx.chain)} explorer`}
                      >
                        <span className="table-direction">
                          {tx.direction === "in" ? (
                            <ArrowDownLeft size={16} />
                          ) : tx.direction === "out" ? (
                            <ArrowUpRight size={16} />
                          ) : (
                            <ArrowLeftRight size={16} />
                          )}
                        </span>
                        {shortAddress(tx.hash)}
                        <ExternalLink size={12} />
                      </a>
                      <small>
                        {directionLabel} · {shortAddress(tx.counterparty)}
                      </small>
                    </td>
                    <td>
                      {chainLabel(tx.chain)}
                      <small title={tx.address}>
                        {label ? `${label} · ` : ""}
                        {shortAddress(tx.address)}
                      </small>
                    </td>
                    <td className={tx.direction === "in" ? "emphasis-text" : ""}>
                      {hideBalances ? (
                        <span aria-label="Amount hidden">••••</span>
                      ) : (
                        <>
                          {tx.direction === "in" ? "+" : tx.direction === "out" ? "−" : ""}
                          {tx.amount}
                        </>
                      )}{" "}
                      {tx.symbol}
                    </td>
                    <td>
                      <time
                        dateTime={timestamp}
                        title={timestamp ? `${timestamp} (UTC)` : "Timestamp unavailable"}
                      >
                        {formatTransactionDate(tx.time)}
                      </time>
                    </td>
                    <td>
                      <span className={`pill tx-status-${tx.status}`}>
                        {tx.status === "failed"
                          ? "Failed"
                          : tx.status === "pending"
                            ? "Pending"
                            : "Observed"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-panel compact tx-empty">
          <Activity size={30} />
          <h3>No transactions to show</h3>
          <p>
            {!watches.length
              ? "Add a public address to load its recent activity."
              : transactions.length
                ? "No fetched transactions match these filters. Try a wider time window or another address."
                : "Refresh or check provider availability on Overview. Public explorers may return no recent transactions."}
          </p>
          {hasFilters && (
            <button
              className="button secondary small-button"
              type="button"
              disabled={!canResetEverything && !hasAdvancedFilters}
              onClick={reset}
            >
              {canResetEverything ? "Reset filters" : "Reset advanced filters"}
            </button>
          )}
        </div>
      )}
      {range !== "all" && (
        <p className="tx-time-note">
          Transactions without a known timestamp, including unconfirmed activity, are excluded from
          time windows. Select “All fetched dates” to include them.
        </p>
      )}
    </section>
  );
}
