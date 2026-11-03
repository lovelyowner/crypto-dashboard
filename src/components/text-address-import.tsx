import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { FileUp, Plus, ShieldCheck, Upload } from "lucide-react";
import { CHAINS, CHAIN_IDS, chainLabel, type ChainId } from "@/lib/chains";
import { shortAddress } from "@/lib/format";
import { useLedger } from "@/lib/ledger-store";
import {
  MAX_IMPORT_BYTES,
  parseAddressText,
  resolveAddressImport,
  type AddressImportRow,
} from "@/lib/address-import";
import "./address-management.css";

type Props = { onClose: () => void; onAdded: (message: string) => void; navigation?: ReactNode };
export function TextAddressImport({ onClose, onAdded, navigation }: Props) {
  const [rows, setRows] = useState<AddressImportRow[]>([]);
  const [choices, setChoices] = useState<Partial<Record<number, ChainId>>>({});
  const [evm, setEvm] = useState<ChainId | "">("");
  const [substrate, setSubstrate] = useState<ChainId | "">("");
  const [filename, setFilename] = useState("");
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [ack, setAck] = useState(false);
  const readVersion = useRef(0);
  useEffect(
    () => () => {
      readVersion.current += 1;
    },
    [],
  );
  const addBatch = useLedger((s) => s.addWatchedBatch);
  const defaults = {
    ...(evm ? { evmChain: evm } : {}),
    ...(substrate ? { substrateChain: substrate } : {}),
  };
  const resolution = useMemo(() => {
    if (!rows.length) return { items: [], error: "" };
    try {
      return {
        items: resolveAddressImport(rows, choices, {
          ...(evm ? { evmChain: evm } : {}),
          ...(substrate ? { substrateChain: substrate } : {}),
        }),
        error: "",
      };
    } catch (cause) {
      return {
        items: [],
        error:
          cause instanceof Error ? cause.message : "Choose compatible networks before importing.",
      };
    }
  }, [rows, choices, evm, substrate]);
  const hasEvm = rows.some(
    (row) =>
      !row.suggestedChain &&
      row.candidates.length > 1 &&
      row.candidates.every((id) => CHAINS[id].family === "evm"),
  );
  const hasSubstrate = rows.some(
    (row) =>
      !row.suggestedChain &&
      row.candidates.length > 1 &&
      row.candidates.every((id) => CHAINS[id].family === "substrate"),
  );
  async function readFile(file?: File) {
    const version = ++readVersion.current;
    setRows([]);
    setChoices({});
    setEvm("");
    setSubstrate("");
    setError("");
    setFilename("");
    setReading(false);
    if (!file) return;
    if (!/\.txt$/i.test(file.name)) {
      setError("Choose a .txt file saved as UTF-8 text.");
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setError("TXT files must be no larger than 200 KB.");
      return;
    }
    setReading(true);
    try {
      const bytes = await file.arrayBuffer();
      if (version !== readVersion.current) return;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Save the file as UTF-8 text, then choose it again.");
      }
      const parsed = parseAddressText(text);
      setRows(parsed);
      setFilename(file.name);
    } catch (cause) {
      if (version === readVersion.current)
        setError(cause instanceof Error ? cause.message : "Could not read this TXT file.");
    } finally {
      if (version === readVersion.current) setReading(false);
    }
  }
  function selected(row: AddressImportRow): ChainId | "" {
    if (choices[row.line]) return choices[row.line]!;
    if (row.suggestedChain) return row.suggestedChain;
    if (row.candidates.every((id) => CHAINS[id].family === "evm") && evm) return evm;
    if (row.candidates.every((id) => CHAINS[id].family === "substrate") && substrate)
      return substrate;
    return "";
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!ack) {
      setError("Acknowledge public provider access to continue.");
      return;
    }
    try {
      const items = resolveAddressImport(rows, choices, defaults);
      const result = addBatch(items);
      if (result.error) {
        setError(result.error);
        return;
      }
      onAdded(`Imported ${result.added} addresses from TXT; skipped ${result.skipped} duplicates.`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import this file.");
    }
  }
  return (
    <form className="add-address-form" onSubmit={submit}>
      <span className="modal-symbol">
        <FileUp size={24} />
      </span>
      <span className="eyebrow">MIXED-NETWORK IMPORT</span>
      <h2>Import addresses from TXT</h2>
      <p>
        Upload a text file with one public address per line. Recognized address formats select their
        network automatically; shared formats need your choice.
      </p>
      {navigation}
      <label className="txt-file-picker">
        <Upload size={18} />
        <span>{reading ? "Reading TXT file…" : "Choose TXT file"}</span>
        <input
          type="file"
          accept=".txt,text/plain"
          aria-label="Upload addresses TXT file"
          disabled={reading}
          onChange={(event) => {
            void readFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </label>
      <p className="address-entry-help">
        UTF-8 · up to 200 KB · up to 100 entries. Add optional labels after a comma. For explicit
        network hints, use <code>ethereum:address, Label</code>. Blank lines and lines beginning
        with # are ignored. The file is read locally.
      </p>
      {hasEvm && (
        <label>
          Network for unassigned EVM addresses
          <select
            className="form-input"
            aria-label="EVM import network"
            value={evm}
            onChange={(event) => setEvm(event.target.value as ChainId | "")}
          >
            <option value="">Choose the intended EVM network</option>
            {CHAIN_IDS.filter((id) => CHAINS[id].family === "evm").map((id) => (
              <option key={id} value={id}>
                {chainLabel(id)}
              </option>
            ))}
          </select>
          <span className="address-entry-help">
            An 0x address can be used on Ethereum, Base, Polygon, and other EVM chains. Its format
            cannot identify which chain has activity. You can override individual rows below.
          </span>
        </label>
      )}
      {hasSubstrate && (
        <label>
          Network for unassigned Substrate addresses
          <select
            className="form-input"
            aria-label="Substrate import network"
            value={substrate}
            onChange={(event) => setSubstrate(event.target.value as ChainId | "")}
          >
            <option value="">Choose Polkadot or Kusama</option>
            {(["polkadot", "kusama"] as ChainId[]).map((id) => (
              <option key={id} value={id}>
                {chainLabel(id)}
              </option>
            ))}
          </select>
        </label>
      )}
      {rows.length > 0 && (
        <>
          <div className="txt-import-summary">
            <strong>{filename}</strong>
            <span>
              {rows.length} entries ·{" "}
              {rows.filter((row) => Boolean(row.suggestedChain) && !row.error).length} automatically
              matched
            </span>
          </div>
          <ol className="txt-import-rows" aria-label="Detected TXT addresses">
            {rows.map((row) => (
              <li key={row.line} className={row.error ? "txt-import-invalid" : ""}>
                <div className="txt-row-heading">
                  <span>Line {row.line}</span>
                  {!row.error && <code>{shortAddress(row.address)}</code>}
                </div>
                {row.error ? (
                  <p role="alert">{row.error}</p>
                ) : (
                  <>
                    {row.label && <strong className="txt-row-label">{row.label}</strong>}
                    {row.suggestedChain ? (
                      <span className="txt-auto-network">
                        {chainLabel(row.suggestedChain)} · detected
                      </span>
                    ) : (
                      <label className="txt-row-network">
                        <span>Network for line {row.line}</span>
                        <select
                          className="form-input"
                          aria-label={`Network for line ${row.line}`}
                          value={selected(row)}
                          onChange={(event) =>
                            setChoices((current) => {
                              const next = { ...current };
                              if (event.target.value)
                                next[row.line] = event.target.value as ChainId;
                              else delete next[row.line];
                              return next;
                            })
                          }
                        >
                          <option value="">Choose a compatible network</option>
                          {row.candidates.map((id) => (
                            <option key={id} value={id}>
                              {chainLabel(id)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {row.warning && <p className="txt-row-warning">{row.warning}</p>}
                    {row.candidates.includes("monero") && (
                      <p className="txt-row-warning">
                        Monero balances and history cannot be tracked from a public address alone.
                      </p>
                    )}
                  </>
                )}
              </li>
            ))}
          </ol>
          {resolution.error && (
            <p className="notice" role="status">
              {resolution.error}
            </p>
          )}
        </>
      )}
      <label className="checkbox-label">
        <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
        <span>
          I understand imported public addresses will be queried with third-party blockchain
          providers when sync is enabled. Format matching does not verify ownership.
        </span>
      </label>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <button
        className="button primary full-width"
        disabled={reading || !ack || !resolution.items.length || Boolean(resolution.error)}
      >
        <Plus size={17} />
        Import detected addresses
      </button>
      <div className="form-footnote">
        <ShieldCheck size={13} />
        Only import public addresses. Never upload recovery words or private keys.
      </div>
    </form>
  );
}
