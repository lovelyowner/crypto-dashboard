import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import type { WatchedAddress } from "@/lib/ledger-store";
import { isValidAddress } from "@/lib/chains";
import { formatTransactionDate, shortAddress } from "@/lib/format";
import { readTokenBalance, type TokenBalance } from "@/lib/token-balances";
import {
  createTokenWatch,
  MAX_TOKEN_WATCHES,
  parseTokenWatches,
  saveTokenWatches,
  TOKEN_WATCH_STORAGE_KEY,
  tokenWatchOwner,
  tokenWatchOwnerCandidates,
  reattachTokenWatch,
  type TokenWatch,
} from "@/lib/token-watch";
import "./token-balances.css";
import { TokenWatchBackups } from "./token-watch-backups";

export type TokenBalancesProps = {
  watched: readonly WatchedAddress[];
  hideBalances: boolean;
  paused: boolean;
  refreshRequest?: number;
  onReadingChange?: (reading: boolean) => void;
};

function timestamp(value: number): string {
  return `${formatTransactionDate(value)} ${new Date(value).toISOString().slice(11, 16)} UTC`;
}

function resultKey(entry: TokenWatch): string {
  return JSON.stringify([
    entry.id,
    entry.ownerId,
    entry.chain,
    entry.ownerAddress,
    entry.tokenAddress,
  ]);
}

export function TokenBalances({
  watched,
  hideBalances,
  paused,
  refreshRequest = 0,
  onReadingChange,
}: TokenBalancesProps) {
  const [entries, setEntries] = useState<TokenWatch[]>([]);
  const [loaded, setLoaded] = useState<"loading" | "ready" | "invalid">("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [tokenAddress, setTokenAddress] = useState("");
  const [label, setLabel] = useState("");
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [results, setResults] = useState<Record<string, TokenBalance>>({});
  const [reading, setReading] = useState(false);
  const [online, setOnline] = useState(false);
  const [visible, setVisible] = useState(false);
  const [reviewOwner, setReviewOwner] = useState<{ id: string; ownerId: string } | null>(null);
  useEffect(() => {
    onReadingChange?.(reading);
    return () => onReadingChange?.(false);
  }, [reading, onReadingChange]);
  const owners = useMemo(
    () =>
      watched.filter(
        (owner) =>
          (owner.chain === "ethereum" || owner.chain === "solana") &&
          isValidAddress(owner.chain, owner.address),
      ),
    [watched],
  );
  const readable = useMemo(
    () => entries.filter((entry) => tokenWatchOwner(entry, watched)),
    [entries, watched],
  );
  const selectedOwner = owners.find((owner) => owner.id === ownerId);

  useEffect(() => {
    const load = () => {
      try {
        setEntries(parseTokenWatches(window.localStorage.getItem(TOKEN_WATCH_STORAGE_KEY)));
        setLoaded("ready");
        setError("");
      } catch {
        setEntries([]);
        setLoaded("invalid");
        setError(
          "The token configuration could not be read from this browser. Reset it to configure tokens again.",
        );
      }
    };
    load();
    const onStorage = (event: StorageEvent) => {
      if (
        event.storageArea === window.localStorage &&
        (event.key === TOKEN_WATCH_STORAGE_KEY || event.key === null)
      )
        load();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      setVisible(document.visibilityState === "visible");
    };
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  useEffect(() => {
    if (loaded !== "ready" || !online || !visible || paused || !readable.length) {
      setReading(false);
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    let pending = false;
    const run = async () => {
      if (pending || disposed || !navigator.onLine || document.visibilityState !== "visible")
        return;
      pending = true;
      setReading(true);
      let index = 0;
      const worker = async () => {
        while (
          !disposed &&
          !controller.signal.aborted &&
          navigator.onLine &&
          document.visibilityState === "visible" &&
          index < readable.length
        ) {
          const entry = readable[index++];
          const result = await readTokenBalance(entry, controller.signal);
          if (!disposed && !controller.signal.aborted)
            setResults((before) => ({ ...before, [resultKey(entry)]: result }));
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, readable.length) }, () => worker()));
      pending = false;
      if (!disposed) setReading(false);
    };
    void run();
    const timer = window.setInterval(() => void run(), 60_000);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [loaded, online, visible, paused, readable, refreshRequest]);

  const persist = (next: readonly TokenWatch[]): boolean => {
    try {
      saveTokenWatches(window.localStorage, next);
      setEntries([...next]);
      setLoaded("ready");
      setError("");
      return true;
    } catch {
      setError(
        "Could not save token configuration in this browser. Your token watches were not changed.",
      );
      return false;
    }
  };
  const add = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice("");
    try {
      const plan = createTokenWatch(entries, { ownerId, tokenAddress, label }, watched);
      if (plan.skipped) {
        setError("");
        setNotice("This owner and token are already being watched.");
      } else if (persist(plan.entries)) {
        setTokenAddress("");
        setLabel("");
        setNotice("Token watch saved in this browser.");
        setShowForm(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check the owner and token address.");
    }
  };
  const query = search.trim().toLowerCase();
  const rows = entries.filter((entry) => {
    const owner = tokenWatchOwner(entry, watched);
    const result = results[resultKey(entry)];
    return [
      entry.label,
      entry.ownerAddress,
      entry.tokenAddress,
      entry.chain,
      owner?.label,
      result?.status === "ready" ? result.symbol : "",
    ].some((value) => value?.toLowerCase().includes(query));
  });
  const activity = !online
    ? "Offline · reads stopped"
    : !visible
      ? "Tab hidden · reads stopped"
      : paused
        ? "Token reads paused"
        : "Refreshes every 60 seconds";

  return (
    <section className="token-balances panel" aria-label="Read-only token balances">
      <div className="token-heading">
        <div>
          <h2>Token balances</h2>
          <p>
            {entries.length
              ? "Exact token units · excluded from native USD totals."
              : "Choose a watched public owner and an Ethereum/ERC20 contract or Solana/SPL mint. Token units stay separate from native USD totals."}
          </p>
        </div>
        <div className="token-actions">
          <button
            type="button"
            onClick={() => {
              setShowForm((value) => !value);
              setNotice("");
            }}
            disabled={loaded !== "ready" || entries.length >= MAX_TOKEN_WATCHES || !owners.length}
            aria-expanded={showForm}
          >
            <Plus size={14} aria-hidden="true" /> Watch token
          </button>
        </div>
      </div>
      <div className="token-status">
        <span>{activity}</span>
        <span>
          {entries.length}/{MAX_TOKEN_WATCHES} · browser only · read only
        </span>
      </div>
      {error && (
        <p className="token-message" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="token-message" role="status">
          {notice}
        </p>
      )}
      {loaded === "invalid" && (
        <button
          className="token-reset"
          type="button"
          onClick={() => {
            if (persist([])) setNotice("Token configuration reset in this browser.");
          }}
        >
          Reset token configuration
        </button>
      )}
      {showForm && loaded === "ready" && (
        <form className="token-form" onSubmit={add}>
          <label>
            Watched public owner
            <select value={ownerId} onChange={(event) => setOwnerId(event.target.value)} required>
              <option value="">Choose an owner</option>
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.chain === "ethereum" ? "Ethereum" : "Solana"} ·{" "}
                  {owner.label || shortAddress(owner.address)} · {shortAddress(owner.address)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {selectedOwner?.chain === "solana"
              ? "SPL mint address"
              : "ERC20 contract or SPL mint address"}
            <input
              value={tokenAddress}
              onChange={(event) => setTokenAddress(event.target.value)}
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              required
              placeholder={
                selectedOwner?.chain === "solana"
                  ? "Public Solana mint"
                  : "Public token contract or mint"
              }
            />
          </label>
          <label>
            Token label (optional)
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={64}
              autoComplete="off"
              placeholder="Your label · up to 64 characters"
            />
          </label>
          <div className="token-form-actions">
            <span>
              {selectedOwner
                ? selectedOwner.chain === "ethereum"
                  ? "Ethereum mainnet / ERC20"
                  : "Solana mainnet / SPL"
                : "Choose the owner’s network above."}
            </span>
            <button type="submit">Save token watch</button>
          </div>
        </form>
      )}
      {entries.length > 0 && (
        <label className="token-search">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">Search token watches</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={160}
            placeholder="Search token label, contract, mint, or owner"
          />
        </label>
      )}
      {!entries.length ? (
        <p className="token-empty">
          {loaded === "loading"
            ? "Loading token configuration…"
            : owners.length
              ? "No token watches yet. Choose Watch token to add a contract or mint."
              : "Add an Ethereum or Solana address to your watchlist, then choose Watch token."}
        </p>
      ) : !rows.length ? (
        <p className="token-empty">No token watches match this search.</p>
      ) : (
        <div className="token-table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Token / network</th>
                <th scope="col">Public owner</th>
                <th scope="col">Exact balance</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => {
                const owner = tokenWatchOwner(entry, watched);
                const result = results[resultKey(entry)];
                const candidates = tokenWatchOwnerCandidates(entry, watched);
                return (
                  <tr key={entry.id} data-token-watch={entry.id}>
                    <td>
                      <strong>
                        {entry.label ||
                          (result?.status === "ready" ? result.symbol || result.name : null) ||
                          "Unlabelled token"}
                      </strong>
                      <span>
                        {entry.chain === "ethereum"
                          ? "Ethereum/ERC20 · mainnet"
                          : "Solana/SPL · mainnet"}
                        {result?.status === "ready" && result.program ? ` · ${result.program}` : ""}
                      </span>
                      <code title={entry.tokenAddress}>{entry.tokenAddress}</code>
                    </td>
                    <td>
                      <strong>{owner?.label || shortAddress(entry.ownerAddress)}</strong>
                      <code title={entry.ownerAddress}>{entry.ownerAddress}</code>
                      {!owner && (
                        <span className="token-orphan">
                          Owner no longer watched. Add the same public owner, then review
                          reattachment.
                        </span>
                      )}
                      {!owner && candidates.length > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setReviewOwner({ id: entry.id, ownerId: candidates[0]!.id })
                          }
                        >
                          Review owner
                        </button>
                      )}
                      {!owner && reviewOwner?.id === entry.id && (
                        <div className="token-owner-review">
                          <label>
                            Matching watched owner
                            <select
                              aria-label="Matching watched owner"
                              value={reviewOwner.ownerId}
                              onChange={(event) =>
                                setReviewOwner({ id: entry.id, ownerId: event.target.value })
                              }
                            >
                              {candidates.map((candidate) => (
                                <option key={candidate.id} value={candidate.id}>
                                  {candidate.label || shortAddress(candidate.address)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <p>
                            Resume reads only for the same network and public address shown above.
                          </p>
                          <button
                            type="button"
                            disabled={!candidates.length}
                            onClick={() => {
                              try {
                                const next = reattachTokenWatch(
                                  entries,
                                  entry.id,
                                  reviewOwner.ownerId,
                                  watched,
                                );
                                if (persist(next)) {
                                  setReviewOwner(null);
                                  setNotice("Token owner reattached. Public reads can resume.");
                                }
                              } catch (cause) {
                                setError(
                                  cause instanceof Error
                                    ? cause.message
                                    : "Could not reattach this owner.",
                                );
                              }
                            }}
                          >
                            Confirm reattachment
                          </button>
                          <button type="button" onClick={() => setReviewOwner(null)}>
                            Cancel review
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="token-balance-value">
                      {!owner ? (
                        <span>Reads stopped</span>
                      ) : result?.status === "ready" ? (
                        <>
                          <strong>
                            {hideBalances ? "••••••" : result.amount}
                            {!hideBalances && result.symbol ? ` ${result.symbol}` : ""}
                          </strong>
                          <span>
                            {result.decimals} decimals
                            {result.accountCount !== undefined
                              ? ` · ${result.accountCount} token accounts`
                              : ""}
                          </span>
                          <span>{timestamp(result.updatedAt)}</span>
                          {result.metadataUnavailable && (
                            <span>Token metadata unavailable · verify the contract or mint.</span>
                          )}
                        </>
                      ) : result ? (
                        <>
                          <strong>
                            {result.status === "unsupported" ? "Unsupported" : "Unavailable"}
                          </strong>
                          <span>{result.message}</span>
                          <span>{timestamp(result.updatedAt)}</span>
                        </>
                      ) : (
                        <span>{reading ? "Reading public balance…" : "No balance read yet"}</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="token-remove"
                        aria-label={`Remove token watch ${entry.label || shortAddress(entry.tokenAddress)}`}
                        onClick={() => {
                          if (persist(entries.filter((known) => known.id !== entry.id)))
                            setNotice("Token watch removed.");
                        }}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <TokenWatchBackups
        entries={entries}
        watched={watched}
        disabled={loaded !== "ready"}
        onImport={persist}
      />
      <p className="token-footnote">
        Public on-chain units may include frozen or restricted tokens. Token-2022 requires parsed
        RPC data. No token prices, transfers, or approvals are used.
      </p>
    </section>
  );
}
