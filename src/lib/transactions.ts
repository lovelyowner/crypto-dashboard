import { chainLabel, activityKey, type ChainId } from "./chains";
import type { ActivityTx } from "./activity.functions";
import { csvCell } from "./portfolio";
import { formatTransactionDate } from "./format";

export type ExplorerTransaction = ActivityTx & { id: string; chain: ChainId; address: string };
export type TransactionWatch = { chain: ChainId; address: string; label: string };
export type TransactionRange = "all" | "24h" | "7d" | "30d";
export type TransactionFilters = {
  search: string;
  network: string;
  address: string;
  direction: string;
  status: string;
  range: TransactionRange;
};
export const DEFAULT_TRANSACTION_FILTERS: TransactionFilters = {
  search: "",
  network: "all",
  address: "all",
  direction: "all",
  status: "all",
  range: "all",
};
const RANGE_MS: Record<Exclude<TransactionRange, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};
const searchable = (text: string) => text.normalize("NFKC").toLowerCase();

export function watchLabels(watches: readonly TransactionWatch[]): Map<string, string> {
  return new Map(watches.map((watch) => [activityKey(watch.chain, watch.address), watch.label]));
}

export function transactionTimeIso(time: number): string | undefined {
  if (!Number.isFinite(time) || time <= 0) return undefined;
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Filter the fetched recent page only; an unavailable timestamp never matches a time window. */
export function filterTransactions(
  transactions: readonly ExplorerTransaction[],
  watches: readonly TransactionWatch[],
  filters: Partial<TransactionFilters> = {},
  now = Date.now(),
): ExplorerTransaction[] {
  const selected = { ...DEFAULT_TRANSACTION_FILTERS, ...filters };
  const query = searchable(selected.search.trim());
  const labels = watchLabels(watches);
  const cutoff = selected.range === "all" ? null : now - RANGE_MS[selected.range];
  return transactions
    .filter((tx) => {
      if (selected.network !== "all" && tx.chain !== selected.network) return false;
      if (selected.address !== "all" && activityKey(tx.chain, tx.address) !== selected.address)
        return false;
      if (selected.direction !== "all" && tx.direction !== selected.direction) return false;
      if (selected.status !== "all" && tx.status !== selected.status) return false;
      if (
        cutoff !== null &&
        (!Number.isFinite(tx.time) || tx.time <= 0 || tx.time < cutoff || tx.time > now)
      )
        return false;
      return (
        !query ||
        searchable(
          [
            tx.hash,
            tx.address,
            tx.counterparty,
            tx.symbol,
            tx.chain,
            chainLabel(tx.chain),
            labels.get(activityKey(tx.chain, tx.address)) || "",
          ].join(" "),
        ).includes(query)
      );
    })
    .sort((a, b) => {
      const aTime = Number.isFinite(a.time) ? a.time : 0;
      const bTime = Number.isFinite(b.time) ? b.time : 0;
      return bTime - aTime;
    });
}

/** Call with the displayed filtered rows. Values remain exact strings in the CSV. */
export function transactionsCsv(
  rows: readonly ExplorerTransaction[],
  watches: readonly TransactionWatch[],
): string {
  const labels = watchLabels(watches);
  const columns = [
    "Network",
    "Watched label",
    "Watched address",
    "Transaction hash",
    "Date (dd.mm.yy, UTC)",
    "Timestamp (UTC)",
    "Direction",
    "Amount",
    "Asset",
    "Counterparty",
    "Status",
  ];
  return [
    columns,
    ...rows.map((tx) => [
      chainLabel(tx.chain),
      labels.get(activityKey(tx.chain, tx.address)) || "",
      tx.address,
      tx.hash,
      formatTransactionDate(tx.time),
      transactionTimeIso(tx.time) ?? "Unconfirmed",
      tx.direction,
      tx.amount,
      tx.symbol,
      tx.counterparty,
      tx.status,
    ]),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}
