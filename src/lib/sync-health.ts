import { activityKey, CHAINS, type ChainId } from "./chains";
import type { ChainActivity } from "./activity.functions";
import { formatTransactionDate } from "./format";

export const STALE_BALANCE_MS = 5 * 60_000;
export type SyncHealthState =
  | "empty"
  | "offline"
  | "paused"
  | "fetching"
  | "unavailable"
  | "incomplete"
  | "stale"
  | "limited"
  | "private"
  | "available";
export type AddressHealth = {
  key: string;
  chain: ChainId;
  address: string;
  status: "available" | "limited" | "unavailable" | "private";
  detail: string;
  checkedAt: number | null;
  stale: boolean;
};
export type SyncHealthOptions = {
  online?: boolean;
  paused?: boolean;
  fetching?: boolean;
  updatedAt?: number;
  now?: number;
};

function validTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    Number.isFinite(new Date(value).getTime())
  );
}

function requestProblem(error = ""): string {
  if (/429|rate.?limit|too many requests/i.test(error))
    return "The public provider is rate limiting requests. Wait a little, then refresh.";
  if (/timeout|timed out|abort/i.test(error))
    return "The public provider timed out. Try refreshing later.";
  if (/401|403|forbidden|access denied/i.test(error))
    return "The public provider denied this request. Browser access or provider policy may restrict it.";
  if (/404|not found|does not exist/i.test(error))
    return "The public provider did not return an account result. Check the address in its explorer.";
  return "Public data could not be read. The provider may be offline, rate limited, or blocking browser requests (CORS).";
}

/** Return coverage and request times only; amounts and valuation data never enter this model. */
export function summarizeSyncHealth(
  results: readonly ChainActivity[],
  total: number,
  options: SyncHealthOptions = {},
) {
  const now = validTimestamp(options.now) ? options.now : Date.now();
  const expected = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const unique = new Map<string, ChainActivity>();
  for (const result of results) {
    const key = activityKey(result.chain, result.address);
    const previous = unique.get(key);
    const previousTime = previous && validTimestamp(previous.fetchedAt) ? previous.fetchedAt : 0;
    const nextTime = validTimestamp(result.fetchedAt) ? result.fetchedAt : 0;
    if (!previous || nextTime >= previousTime) unique.set(key, result);
  }
  const rows: AddressHealth[] = (expected ? [...unique.values()] : []).map((result) => {
    const checkedAt =
      validTimestamp(result.fetchedAt) && result.fetchedAt <= now ? result.fetchedAt : null;
    const stale = result.ok && checkedAt !== null && now - checkedAt >= STALE_BALANCE_MS;
    const privateNetwork = CHAINS[result.chain].tracking === "private";
    const status = privateNetwork
      ? "private"
      : !result.ok
        ? "unavailable"
        : result.history === "balance-only"
          ? "limited"
          : "available";
    const detail = privateNetwork
      ? "A public address cannot reveal this network’s private balance or transaction history."
      : !result.ok
        ? requestProblem(result.error)
        : result.historyNote ||
          (status === "limited"
            ? "Native balance is available; recent transaction history is not available from this source."
            : "Native balance and the provider’s recent activity page are available. This is not complete history.");
    return {
      key: activityKey(result.chain, result.address),
      chain: result.chain,
      address: result.address,
      status,
      detail,
      checkedAt,
      stale,
    };
  });
  const available = rows.filter(
    (row) => row.status === "available" || row.status === "limited",
  ).length;
  const limited = rows.filter((row) => row.status === "limited").length;
  const unavailable = rows.filter((row) => row.status === "unavailable").length;
  const privateCount = rows.filter((row) => row.status === "private").length;
  const missing = Math.max(0, expected - rows.length);
  const stale = rows.filter((row) => row.stale).length;
  const successfulTimes = rows
    .filter((row) => row.status === "available" || row.status === "limited")
    .map((row) => row.checkedAt)
    .filter((time): time is number => time !== null);
  const allTimes = rows.map((row) => row.checkedAt).filter((time): time is number => time !== null);
  const oldestBalanceAt = successfulTimes.length ? Math.min(...successfulTimes) : null;
  const latestAttemptAt = allTimes.length ? Math.max(...allTimes) : null;
  const unknownBalanceTimes = rows.filter(
    (row) => (row.status === "available" || row.status === "limited") && row.checkedAt === null,
  ).length;
  const responseAt =
    validTimestamp(options.updatedAt) && options.updatedAt <= now ? options.updatedAt : null;
  const state: SyncHealthState = !expected
    ? "empty"
    : options.online === false
      ? "offline"
      : options.paused
        ? "paused"
        : options.fetching
          ? "fetching"
          : unavailable
            ? "unavailable"
            : missing
              ? "incomplete"
              : stale
                ? "stale"
                : limited
                  ? "limited"
                  : privateCount
                    ? "private"
                    : "available";
  return {
    state,
    total: expected,
    checked: rows.length,
    available,
    limited,
    unavailable,
    privateCount,
    missing,
    stale,
    unknownBalanceTimes,
    oldestBalanceAt,
    latestAttemptAt,
    responseAt,
    rows,
  };
}

export function formatSyncTimestamp(time: number | null): string {
  if (!validTimestamp(time)) return "Check time unavailable";
  const date = new Date(time);
  const hours = String(date.getUTCHours()).padStart(2, "0"),
    minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${formatTransactionDate(time)} ${hours}:${minutes} UTC`;
}
