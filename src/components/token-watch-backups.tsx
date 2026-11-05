import { useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import type { WatchedAddress } from "@/lib/ledger-store";
import { downloadFile } from "@/lib/portfolio";
import type { TokenWatch } from "@/lib/token-watch";
import {
  exportTokenWatchBackup,
  MAX_TOKEN_BACKUP_BYTES,
  planTokenWatchImport,
} from "@/lib/token-watch-backup";

type Props = {
  entries: readonly TokenWatch[];
  watched: readonly WatchedAddress[];
  disabled: boolean;
  onImport: (entries: readonly TokenWatch[]) => boolean;
};

export function TokenWatchBackups({ entries, watched, disabled, onImport }: Props) {
  const [source, setSource] = useState<{ name: string; raw: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const preview = useMemo(() => {
    if (!source || disabled) return null;
    try {
      return { plan: planTokenWatchImport(source.raw, entries, watched), error: "" };
    } catch (cause) {
      return {
        plan: null,
        error: cause instanceof Error ? cause.message : "This token backup could not be read.",
      };
    }
  }, [source, entries, watched, disabled]);

  const chooseFile = async (file: File | undefined) => {
    const request = ++generation.current;
    setSource(null);
    setError("");
    setNotice("");
    setReading(false);
    if (!file) return;
    if (file.size > MAX_TOKEN_BACKUP_BYTES) {
      setError("Choose a token-watch JSON backup no larger than 64 KiB.");
      return;
    }
    setReading(true);
    try {
      const raw = await file.text();
      if (generation.current === request) setSource({ name: file.name, raw });
    } catch {
      if (generation.current === request) setError("This file could not be read. Choose it again.");
    } finally {
      if (generation.current === request) setReading(false);
    }
  };

  return (
    <details className="token-backups">
      <summary>Token watch backups</summary>
      <p>
        Export public owner addresses, contracts or mints, and labels. This file contains no wallet
        keys, accounts, or balances. Public addresses can reveal your activity.
      </p>
      <div className="token-backup-actions">
        <button
          type="button"
          disabled={disabled || !entries.length}
          onClick={() => {
            setError("");
            setNotice("");
            try {
              downloadFile("fathom-public-token-watches.json", exportTokenWatchBackup(entries));
              setNotice("Public token-watch backup downloaded.");
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "The backup could not be created.");
            }
          }}
        >
          <Download size={14} aria-hidden="true" /> Export token watches
        </button>
        <label>
          Import token-watch JSON
          <input
            type="file"
            accept=".json,application/json"
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void chooseFile(file);
            }}
          />
        </label>
      </div>
      {reading && <p role="status">Reading the local file…</p>}
      {(error || preview?.error) && <p role="alert">{error || preview?.error}</p>}
      {notice && <p role="status">{notice}</p>}
      {source && preview?.plan && (
        <div className="token-import-preview" role="region" aria-label="Token import preview">
          <p className="token-import-name">{source.name}</p>
          <p role="status">
            {preview.plan.added} new watches · {preview.plan.duplicates} duplicates ·{" "}
            {preview.plan.unmatched} unmatched owners
          </p>
          <p>
            Merges with your current token watches. Existing labels stay unchanged. Owners must
            already be in your watchlist on the same network.
            {preview.plan.unmatched > 0 &&
              " Add missing owners to your watchlist, then import again."}
          </p>
          <div className="token-actions">
            <button
              type="button"
              disabled={disabled || !preview.plan.added}
              onClick={() => {
                setError("");
                setNotice("");
                try {
                  const plan = planTokenWatchImport(source.raw, entries, watched);
                  if (plan.added && onImport(plan.entries)) {
                    setSource(null);
                    setNotice(`Imported ${plan.added} token watch${plan.added === 1 ? "" : "es"}.`);
                  }
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "The token watches could not be imported.",
                  );
                }
              }}
            >
              Merge {preview.plan.added} token watch{preview.plan.added === 1 ? "" : "es"}
            </button>
            <button type="button" onClick={() => setSource(null)}>
              Cancel import
            </button>
          </div>
        </div>
      )}
    </details>
  );
}
