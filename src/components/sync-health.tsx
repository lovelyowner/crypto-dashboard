import { useEffect, useState } from "react";
import { Clock3, Info, Pause, RefreshCw, WifiOff } from "lucide-react";
import type { ChainActivity } from "@/lib/activity.functions";
import { chainLabel } from "@/lib/chains";
import { shortAddress } from "@/lib/format";
import { formatSyncTimestamp, summarizeSyncHealth, type SyncHealthState } from "@/lib/sync-health";
import "./sync-health.css";

export type SyncHealthProps = {
  results: readonly ChainActivity[];
  total: number;
  fetching: boolean;
  updatedAt: number;
  online: boolean;
  paused: boolean;
  onRetry?: () => void;
};
const HEADLINES: Record<SyncHealthState, string> = {
  empty: "Add an address to start",
  offline: "You are offline",
  paused: "Sync is paused",
  fetching: "Refreshing public data",
  unavailable: "Some addresses are unavailable",
  incomplete: "Waiting for address results",
  stale: "Some displayed balances may be out of date",
  limited: "Some transaction history is limited",
  private: "Some networks keep their history private",
  available: "Public data checked",
};
const ADDRESS_LABELS = {
  available: "Balance and recent activity",
  limited: "Balance only",
  unavailable: "Unavailable",
  private: "Private history",
};

export function SyncHealth({
  results,
  total,
  fetching,
  updatedAt,
  online,
  paused,
  onRetry,
}: SyncHealthProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const health = summarizeSyncHealth(results, total, {
    now: Math.max(now, Date.now()),
    fetching,
    updatedAt,
    online,
    paused,
  });
  if (!total) return null;
  const Icon = !online
    ? WifiOff
    : paused
      ? Pause
      : fetching
        ? RefreshCw
        : health.stale
          ? Clock3
          : Info;
  const checkedTime = health.oldestBalanceAt ?? health.latestAttemptAt;
  return (
    <section className="sync-health" aria-label="Public data sync status">
      <div className="sync-health-heading">
        <Icon
          size={17}
          className={fetching && online && !paused ? "sync-health-spin" : undefined}
        />
        <div>
          <h2>{HEADLINES[health.state]}</h2>
          <p>
            {health.available} of {health.total} addresses have a native balance result
            {health.limited ? ` · ${health.limited} with limited history` : ""}
            {health.unavailable ? ` · ${health.unavailable} unavailable` : ""}
            {health.privateCount ? ` · ${health.privateCount} private` : ""}
            {health.missing ? ` · ${health.missing} awaiting a result` : ""}.
          </p>
        </div>
        {onRetry && (
          <button type="button" disabled={!online || paused || fetching} onClick={onRetry}>
            <RefreshCw size={14} />
            Refresh data
          </button>
        )}
      </div>
      <div className="sync-health-time">
        {checkedTime ? (
          <>
            <Clock3 size={12} />
            <span>
              {health.oldestBalanceAt ? "Oldest displayed balance check" : "Latest recorded result"}
              :{" "}
              <time dateTime={new Date(checkedTime).toISOString()}>
                {formatSyncTimestamp(checkedTime)}
              </time>
            </span>
          </>
        ) : health.responseAt ? (
          <span>
            Workspace response received {formatSyncTimestamp(health.responseAt)}; individual check
            times are unavailable.
          </span>
        ) : (
          <span>No completed public-data result yet.</span>
        )}
        {health.unknownBalanceTimes > 0 && <span>Some balance check times are unavailable.</span>}
      </div>
      {(fetching || !online || paused || health.stale > 0) && (
        <p className="sync-health-help">
          {!online
            ? "Saved addresses and wallets remain local. Displayed data will not refresh while the browser is offline."
            : paused
              ? "No new refresh starts while paused. A refresh already in progress may finish."
              : fetching
                ? "The last completed results remain visible while this refresh runs."
                : `${health.stale} balance ${health.stale === 1 ? "result is" : "results are"} at least five minutes old. Refresh to check the current public source.`}
        </p>
      )}
      {health.rows.length > 0 && (
        <details className="sync-health-details">
          <summary>
            Address data details <span>{health.checked}</span>
          </summary>
          <ul>
            {health.rows.map((row) => (
              <li key={row.key}>
                <div className="sync-health-address">
                  <strong>{chainLabel(row.chain)}</strong>
                  <code>{shortAddress(row.address)}</code>
                  <span className="sync-health-badge">
                    {ADDRESS_LABELS[row.status]}
                    {row.stale ? " · older data" : ""}
                  </span>
                </div>
                <p>{row.detail}</p>
                <small>
                  {row.checkedAt
                    ? formatSyncTimestamp(row.checkedAt)
                    : "Individual check time unavailable"}
                </small>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
