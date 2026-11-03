import { useMemo, useState, type FormEvent } from "react";
import { Check, ListPlus, Plus, ShieldCheck } from "lucide-react";
import { CHAINS, CHAIN_IDS, detectFamily, isValidAddress, type ChainId } from "@/lib/chains";
import { useLedger, type WatchedAddress } from "@/lib/ledger-store";
import { parseAddressLines } from "@/lib/watchlist";
import "./address-management.css";

export function AddressEntry({
  onClose,
  onAdded,
  initialChain,
}: {
  onClose: () => void;
  onAdded: (message: string) => void;
  initialChain?: ChainId;
}) {
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [chain, setChain] = useState<ChainId>(initialChain ?? "ethereum");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [bulk, setBulk] = useState("");
  const [error, setError] = useState("");
  const [ack, setAck] = useState(false);
  const addWatched = useLedger((s) => s.addWatched);
  const addBatch = useLedger((s) => s.addWatchedBatch);
  const preview = useMemo(() => {
    if (!bulk.trim()) return { count: 0, error: "" };
    try {
      return { count: parseAddressLines(bulk, chain).length, error: "" };
    } catch (cause) {
      return {
        count: 0,
        error: cause instanceof Error ? cause.message : "Check the pasted addresses.",
      };
    }
  }, [bulk, chain]);
  function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!ack) {
      setError("Acknowledge public provider access to continue.");
      return;
    }
    if (mode === "single") {
      const failure = addWatched({ chain, address, label });
      if (failure) {
        setError(failure);
        return;
      }
      onAdded("Address added to your workspace.");
    } else {
      try {
        const result = addBatch(parseAddressLines(bulk, chain));
        if (result.error) {
          setError(result.error);
          return;
        }
        onAdded(`Added ${result.added} addresses; skipped ${result.skipped} duplicates.`);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not add these addresses.");
        return;
      }
    }
    onClose();
  }
  function paste(value: string) {
    setAddress(value);
    const family = detectFamily(value);
    if (family === "bitcoin" || family === "solana") setChain(family);
    else if (family === "evm" && CHAINS[chain].family !== "evm") setChain("ethereum");
  }
  return (
    <form onSubmit={submit} className="add-address-form">
      <span className="modal-symbol">
        {mode === "bulk" ? <ListPlus size={24} /> : <Plus size={24} />}
      </span>
      <span className="eyebrow">WATCH, WITHOUT CONNECTING</span>
      <h2>{mode === "single" ? "Add a public address" : "Add addresses in bulk"}</h2>
      <p>Watch public balances and recent activity. No wallet connection or private key needed.</p>
      <div className="address-mode" role="group" aria-label="Address entry mode">
        <button
          type="button"
          aria-pressed={mode === "single"}
          onClick={() => {
            setMode("single");
            setError("");
          }}
        >
          Single address
        </button>
        <button
          type="button"
          aria-pressed={mode === "bulk"}
          onClick={() => {
            setMode("bulk");
            setError("");
          }}
        >
          Bulk add
        </button>
      </div>
      <label>
        Network
        <select
          aria-label="Network"
          className="form-input"
          value={chain}
          onChange={(event) => setChain(event.target.value as ChainId)}
        >
          {CHAIN_IDS.map((id) => (
            <option key={id} value={id}>
              {CHAINS[id].name} · {CHAINS[id].symbol}
            </option>
          ))}
        </select>
      </label>
      {mode === "single" ? (
        <>
          <label>
            Public address
            <input
              className="form-input mono"
              placeholder="Paste your public wallet address"
              value={address}
              maxLength={160}
              onChange={(event) => paste(event.target.value)}
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
              onChange={(event) => setLabel(event.target.value)}
              maxLength={80}
            />
          </label>
        </>
      ) : (
        <>
          <label>
            Public addresses
            <textarea
              aria-label="Public addresses"
              className="form-input mono bulk-address-input"
              value={bulk}
              onChange={(event) => setBulk(event.target.value)}
              maxLength={30000}
              rows={7}
              spellCheck={false}
              autoComplete="off"
              required
              placeholder={"address, Optional label\naddress, Another label"}
            />
          </label>
          <p className="address-entry-help">
            One address per line, all on the selected network. Add an optional label after a comma.
            Up to 100 addresses per workspace. Invalid batches are not added.
          </p>
          <span className="validation-message" role="status">
            {preview.error ||
              (preview.count
                ? `${preview.count} valid entries ready to check for duplicates.`
                : "Paste public addresses to preview the batch.")}
          </span>
        </>
      )}
      <label className="checkbox-label">
        <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
        <span>
          I understand these addresses will be queried with public blockchain providers when syncing
          is enabled. This does not verify ownership.
        </span>
      </label>
      {chain === "monero" && (
        <div className="notice">
          Monero hides transaction details. An address alone cannot show balance or history. These
          addresses will be saved without public data.
        </div>
      )}
      {["polkadot", "kusama"].includes(chain) && (
        <div className="notice">
          Native free balances can be queried. Transaction history requires an indexer; use the
          linked explorer.
        </div>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <button
        className="button primary full-width"
        disabled={
          !ack ||
          (mode === "single"
            ? !isValidAddress(chain, address)
            : !preview.count || Boolean(preview.error))
        }
      >
        <Plus size={17} />
        {mode === "single" ? "Add to workspace" : "Add addresses"}
      </button>
      <div className="form-footnote">
        <ShieldCheck size={13} />
        Never paste recovery words or private keys here.
      </div>
    </form>
  );
}

export function EditAddressLabel({
  address,
  onClose,
  onSaved,
}: {
  address: WatchedAddress;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(address.label);
  const [error, setError] = useState("");
  const update = useLedger((s) => s.updateWatchedLabel);
  return (
    <form
      className="add-address-form"
      onSubmit={(event) => {
        event.preventDefault();
        const failure = update(address.id, label);
        if (failure) {
          setError(failure);
          return;
        }
        onSaved();
        onClose();
      }}
    >
      <span className="eyebrow">YOUR WATCHLIST</span>
      <h2>Edit address label</h2>
      <p>Rename this entry without changing the address or its linked wallet.</p>
      <div className="notice">
        <strong>{CHAINS[address.chain].name}</strong>
        <code className="full-public-address">{address.address}</code>
      </div>
      <label>
        Label
        <input
          className="form-input"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={80}
          placeholder="e.g. Long-term holdings"
          autoFocus
        />
      </label>
      <p className="address-entry-help">
        Leave empty to use the network name. Labels stay in this browser.
      </p>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <button className="button primary" type="submit">
        Save label
      </button>
    </form>
  );
}
