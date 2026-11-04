import { useMemo, useState } from "react";
import { Plus, Wallet } from "lucide-react";
import { chainLabel, activityKey, isValidAddress } from "@/lib/chains";
import type { DonationAddress } from "@/lib/creator-profile";
import { useLedger } from "@/lib/ledger-store";
import {
  collectProfileWalletOptions,
  type ProfileWalletOption,
} from "@/lib/profile-wallet-options";
import "./profile-wallet-picker.css";

export function ProfileWalletPicker({
  existing,
  onAdd,
}: {
  existing: readonly DonationAddress[];
  onAdd: (selection: ProfileWalletOption[]) => boolean;
}) {
  const wallets = useLedger((state) => state.wallets);
  const watched = useLedger((state) => state.watched);
  const hydrated = useLedger((state) => state.hydrated);
  const options = useMemo(() => collectProfileWalletOptions(wallets, watched), [wallets, watched]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmed, setConfirmed] = useState(false);
  const alreadyAdded = new Set(
    existing
      .filter((entry) => isValidAddress(entry.chain, entry.address))
      .map((entry) => activityKey(entry.chain, entry.address)),
  );
  const chosen = options.filter(
    (option) => selected.has(option.key) && !alreadyAdded.has(option.key),
  );
  const remaining = Math.max(0, 10 - existing.length);
  const tooMany = chosen.length > remaining;
  const available = options.some((option) => !alreadyAdded.has(option.key));

  return (
    <details className="profile-wallet-picker">
      <summary>
        <Wallet size={15} aria-hidden="true" /> Choose wallets from this workspace
      </summary>
      <p>
        Copy public receiving addresses from local wallets or your watchlist into this profile.
        Watching an address does not prove that you own it.
      </p>
      {!hydrated ? (
        <p role="status">Loading workspace addresses…</p>
      ) : !options.length ? (
        <p>
          No saved wallet addresses yet. Create a local wallet or add an address to your dashboard,
          or enter a receiving address manually below.
        </p>
      ) : (
        <>
          <div
            className="profile-wallet-options"
            role="group"
            aria-label="Saved workspace receiving addresses"
          >
            {options.map((option) => {
              const added = alreadyAdded.has(option.key);
              return (
                <label className="profile-wallet-option" key={option.key}>
                  <input
                    type="checkbox"
                    checked={added || selected.has(option.key)}
                    disabled={added}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (checked) next.add(option.key);
                        else next.delete(option.key);
                        return next;
                      });
                      setConfirmed(false);
                    }}
                  />
                  <span>
                    <strong>{option.label || "Saved receiving address"}</strong>
                    <small>
                      {chainLabel(option.chain)} ·{" "}
                      {option.source === "wallet"
                        ? "Local wallet"
                        : option.source === "watchlist"
                          ? "Watched address"
                          : "Local wallet and watchlist"}
                      {added ? " · Already added" : ""}
                    </small>
                    <code>{option.address}</code>
                  </span>
                </label>
              );
            })}
          </div>
          {available && (
            <>
              <label className="profile-wallet-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>
                  I control the selected receiving addresses and want to add them to my profile.
                </span>
              </label>
              <p className="profile-wallet-capacity" role="status">
                {chosen.length} selected · {remaining} free profile address slots
                {tooMany ? ". Choose fewer addresses before adding." : "."}
              </p>
              <button
                type="button"
                disabled={!confirmed || !chosen.length || tooMany}
                onClick={() => {
                  if (onAdd(chosen)) {
                    setSelected(new Set());
                    setConfirmed(false);
                  }
                }}
              >
                <Plus size={14} aria-hidden="true" /> Add selected receiving addresses
              </button>
            </>
          )}
          {!available && <p>All saved receiving addresses are already in this profile.</p>}
        </>
      )}
      <p className="profile-wallet-privacy">
        Only public addresses and labels are copied. This changes your draft; saving and publishing
        remain separate.
      </p>
    </details>
  );
}
