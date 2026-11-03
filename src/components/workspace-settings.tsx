import { Download, EyeOff, Globe2, KeyRound, Pause, Settings2, ShieldCheck } from "lucide-react";
import {
  isRefreshInterval,
  useOnlineStatus,
  useWorkspacePreferences,
} from "@/lib/workspace-preferences";
import "./workspace-settings.css";

export type WorkspaceSettingsProps = {
  onClose: () => void;
  onExportWatchlist?: () => void;
  onOpenWallet?: () => void;
};

export function WorkspaceSettings({
  onClose,
  onExportWatchlist,
  onOpenWallet,
}: WorkspaceSettingsProps) {
  const {
    hideBalances,
    syncPaused,
    refreshInterval,
    hydrated,
    storageError,
    setHideBalances,
    setSyncPaused,
    setRefreshInterval,
  } = useWorkspacePreferences();
  const online = useOnlineStatus();
  return (
    <section className="workspace-settings">
      <div className="settings-heading">
        <span className="settings-symbol">
          <Settings2 size={23} />
        </span>
        <div>
          <span className="settings-eyebrow">THIS BROWSER</span>
          <h2>Workspace settings</h2>
        </div>
      </div>
      <p className="settings-intro">
        Choose what appears on screen and when public activity is refreshed. These settings stay on
        this device.
      </p>
      {storageError && (
        <p className="settings-notice" role="status">
          {storageError}
        </p>
      )}
      <section className="settings-section" aria-labelledby="settings-display">
        <h3 id="settings-display">
          <EyeOff size={17} />
          Display privacy
        </h3>
        <label className="settings-toggle">
          <span>
            <strong>Hide balances</strong>
            <small>
              Mask portfolio totals, address balances, and transaction amounts while you browse.
              Public addresses remain visible.
            </small>
          </span>
          <input
            aria-label="Hide balances"
            type="checkbox"
            role="switch"
            checked={hideBalances}
            disabled={!hydrated}
            onChange={(event) => setHideBalances(event.target.checked)}
          />
        </label>
        <p className="settings-help">
          This is a screen privacy setting. It does not encrypt public addresses or stop provider
          requests. Explicit exports and explorer links can still reveal amounts.
        </p>
      </section>
      <section className="settings-section" aria-labelledby="settings-sync">
        <h3 id="settings-sync">
          <Globe2 size={17} />
          Network activity
        </h3>
        <div className="settings-status" role="status">
          <span className="settings-connection-dot" />
          {!online
            ? "Browser is offline"
            : syncPaused
              ? "Workspace sync is paused"
              : "Browser is online"}
        </div>
        <label className="settings-toggle">
          <span>
            <strong>Pause network sync</strong>
            <small>
              Stop starting new refreshes. Requests belonging to a refresh already in progress may
              finish.
            </small>
          </span>
          <input
            aria-label="Pause network sync"
            type="checkbox"
            role="switch"
            checked={syncPaused}
            disabled={!hydrated}
            onChange={(event) => setSyncPaused(event.target.checked)}
          />
        </label>
        <label className="settings-select-label">
          <span>Auto-refresh interval</span>
          <select
            aria-label="Workspace auto-refresh interval"
            value={refreshInterval}
            disabled={!hydrated}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (isRefreshInterval(value)) setRefreshInterval(value);
            }}
          >
            <option value={0}>Off — refresh manually</option>
            <option value={30000}>30 seconds</option>
            <option value={60000}>1 minute</option>
            <option value={300000}>5 minutes</option>
          </select>
        </label>
        <p className="settings-help">
          Auto-refresh off still allows an initial load and manual updates. Pausing sync stops new
          refreshes, including manual updates. Online status does not guarantee a provider is
          available.
        </p>
      </section>
      <section className="settings-section" aria-labelledby="settings-data">
        <h3 id="settings-data">
          <ShieldCheck size={17} />
          Your data and backups
        </h3>
        <p className="settings-help">
          Tracking shares each queried public address and your connection’s IP address with
          third-party blockchain providers. It is not anonymous. Wallet recovery words and wallet
          passphrases stay in this browser.
        </p>
        <p className="settings-help">
          Watchlists and encrypted wallets are saved locally, independently of account login. They
          do not sync to another device or website address. Keep recovery words offline and a
          separate encrypted backup before clearing browser data.
        </p>
        <div className="settings-actions">
          {onExportWatchlist && (
            <button type="button" onClick={onExportWatchlist}>
              <Download size={15} />
              Export public watchlist
            </button>
          )}
          {onOpenWallet && (
            <button type="button" onClick={onOpenWallet}>
              <KeyRound size={15} />
              Wallet backups
            </button>
          )}
        </div>
        <p className="settings-footnote">
          <Pause size={13} />
          Pausing sync and hiding amounts do not delete saved addresses or wallets.
        </p>
      </section>
      <button className="settings-done" type="button" onClick={onClose}>
        Done
      </button>
    </section>
  );
}
