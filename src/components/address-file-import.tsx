import { useEffect, useMemo, useRef, useState, type ReactNode, type FormEvent } from "react";
import { FileUp } from "lucide-react";
import { useLedger } from "@/lib/ledger-store";
import { parseWatchlist, type PublicWatch } from "@/lib/portfolio";
import { planWatchBatch } from "@/lib/watchlist";
import { chainLabel } from "@/lib/chains";
import { TextAddressImport } from "./text-address-import";

type Props = { navigation: ReactNode; onClose: () => void; onAdded: (message: string) => void };
export function AddressFileImport(props: Props) {
  const [format, setFormat] = useState("txt");
  const navigation = (
    <>
      {props.navigation}
      <label>
        File format
        <select
          className="form-input"
          aria-label="File format"
          value={format}
          onChange={(event) => setFormat(event.target.value)}
        >
          <option value="txt">TXT address list</option>
          <option value="json">JSON watchlist backup</option>
        </select>
      </label>
    </>
  );
  return format === "txt" ? (
    <TextAddressImport {...props} navigation={navigation} />
  ) : (
    <JsonWatchlistImport {...props} navigation={navigation} />
  );
}

function JsonWatchlistImport({ navigation, onClose, onAdded }: Props) {
  const [items, setItems] = useState<PublicWatch[]>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [ack, setAck] = useState(false);
  const generation = useRef(0);
  const watched = useLedger((state) => state.watched);
  const addBatch = useLedger((state) => state.addWatchedBatch);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const preview = useMemo(() => {
    if (!items.length) return null;
    try {
      return { plan: planWatchBatch(watched, items), error: "" };
    } catch (cause) {
      return {
        plan: null,
        error: cause instanceof Error ? cause.message : "Check this watchlist.",
      };
    }
  }, [items, watched]);
  const readFile = async (file?: File) => {
    const request = ++generation.current;
    setItems([]);
    setError("");
    setAck(false);
    setReading(false);
    if (!file) return;
    if (file.size > 200_000) {
      setError("Choose a public watchlist JSON file under 200 kB.");
      return;
    }
    setReading(true);
    try {
      const rows = parseWatchlist(JSON.parse(await file.text()));
      if (!rows.length) throw new Error("This watchlist contains no addresses.");
      if (generation.current === request) setItems(rows);
    } catch (cause) {
      if (generation.current === request)
        setError(cause instanceof Error ? cause.message : "Could not read this watchlist.");
    } finally {
      if (generation.current === request) setReading(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ack || !preview?.plan) return;
    const result = addBatch(items);
    if (result.error) {
      setError(result.error);
      return;
    }
    onAdded(`Imported ${result.added} addresses; ${result.skipped} already watched.`);
    onClose();
  };
  return (
    <form className="add-address-form" onSubmit={submit}>
      <span className="modal-symbol">
        <FileUp size={24} />
      </span>
      <h2>Import a public watchlist</h2>
      <p>
        Review a JSON watchlist backup before merging it with this browser. Existing entries keep
        their labels and pins.
      </p>
      {navigation}
      <label>
        Watchlist JSON file
        <input
          className="form-input"
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void readFile(file);
          }}
        />
      </label>
      {reading && <p role="status">Reading watchlist…</p>}
      {(error || preview?.error) && (
        <p className="notice error" role="alert">
          {error || preview?.error}
        </p>
      )}
      {preview?.plan && (
        <>
          <p role="status">
            {preview.plan.fresh.length} new addresses · {preview.plan.skipped} already watched
          </p>
          <ul className="address-json-preview" aria-label="JSON address preview">
            {items.map((item) => (
              <li key={`${item.chain}:${item.address}`}>
                <strong>{item.label || chainLabel(item.chain)}</strong>
                <span>
                  {chainLabel(item.chain)}
                  {item.pinned ? " · pinned" : ""}
                </span>
                <code>{item.address}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      <label className="checkbox-label">
        <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
        <span>
          I understand these public addresses will be queried with blockchain providers when syncing
          is enabled.
        </span>
      </label>
      <button
        className="button primary full-width"
        disabled={!ack || reading || !preview?.plan}
        type="submit"
      >
        Merge watchlist
      </button>
      <p className="address-entry-help">
        This imports public addresses only. Encrypted wallets and recovery keys use the wallet
        manager.
      </p>
    </form>
  );
}
