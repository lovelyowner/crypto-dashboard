import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  Eye,
  KeyRound,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { CHAINS, EVM_CHAIN_IDS, type ChainId } from "@/lib/chains";
import { useLedger, type LocalWallet } from "@/lib/ledger-store";
import {
  addressesFromMnemonic,
  createMnemonic,
  DERIVATION_PATHS,
  isValidMnemonic,
  normalizeMnemonic,
  type WalletAddresses,
} from "@/lib/wallet/derive";
import { openSecret, sealWithPassphrase, assertPassphrase } from "@/lib/wallet/secret";
import { createBackup, parseBackup } from "@/lib/wallet/backup";
import "./wallet.css";

type Step = "home" | "backup" | "confirm" | "import";
const ERROR = (e: unknown) => (e instanceof Error ? e.message : "The wallet operation failed.");

/** Browser-only wallet creation. Recovery words never cross an application API. */
export function WalletPanel({ onClose }: { onClose: () => void }) {
  const wallets = useLedger((s) => s.wallets);
  const addWallet = useLedger((s) => s.addWallet);
  const addWatched = useLedger((s) => s.addWatched);
  const [step, setStep] = useState<Step>("home");
  const [phrase, setPhrase] = useState("");
  const [label, setLabel] = useState("My multichain wallet");
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [answers, setAnswers] = useState(["", "", ""]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [watchOnSave, setWatchOnSave] = useState(false);
  const [importText, setImportText] = useState("");
  const [encryptedImport, setEncryptedImport] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const words = phrase.split(" ");
  const positions = [2, 7, words.length - 1];

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function clear() {
    setPhrase("");
    setPassphrase("");
    setAgain("");
    setAnswers(["", "", ""]);
    setImportText("");
    setEncryptedImport("");
    setImportPassword("");
    setAcknowledged(false);
    setWatchOnSave(false);
    setError("");
  }
  function goHome() {
    clear();
    setStep("home");
  }
  function close() {
    clear();
    onClose();
  }
  function generate() {
    try {
      clear();
      setPhrase(createMnemonic());
      setLabel("My multichain wallet");
      setStep("backup");
    } catch (e) {
      setError(ERROR(e));
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      if (
        !acknowledged ||
        positions.some((position, i) => answers[i]?.trim().toLowerCase() !== words[position])
      )
        throw new Error("Check your saved words and complete all three backup checks.");
      assertPassphrase(passphrase);
      if (passphrase !== again) throw new Error("The wallet passphrases do not match.");
      if (!label.trim()) throw new Error("Give this wallet a name.");
      setBusy(true);
      const addresses = addressesFromMnemonic(phrase);
      const encrypted = await sealWithPassphrase(phrase, passphrase);
      if (!alive.current) return;
      const wallet: LocalWallet = {
        id: crypto.randomUUID(),
        label: label.trim().slice(0, 80),
        createdAt: Date.now(),
        custody: "device",
        addresses,
        encrypted,
      };
      addWallet(wallet);
      if (watchOnSave)
        for (const [chain, address] of Object.entries(addresses))
          addWatched({
            chain: chain as ChainId,
            address,
            label: `${wallet.label} · ${CHAINS[chain as ChainId].symbol}`,
            walletId: wallet.id,
          });
      clear();
      setStep("home");
      setNotice(
        "Wallet saved locally. Download its encrypted backup below and store it separately.",
      );
    } catch (e) {
      setError(ERROR(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function importWallet(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      let imported = importText;
      if (encryptedImport) {
        const backup = parseBackup(encryptedImport);
        imported = await openSecret(backup.encrypted, importPassword);
        if (!alive.current) return;
        setLabel(backup.label || "Imported wallet");
      } else {
        setLabel("Imported wallet");
      }
      if (!isValidMnemonic(imported))
        throw new Error(
          "Enter a valid English BIP39 recovery phrase (12, 15, 18, 21, or 24 words).",
        );
      setPhrase(normalizeMnemonic(imported));
      setImportText("");
      setEncryptedImport("");
      setImportPassword("");
      setAcknowledged(false);
      setStep("backup");
    } catch (e) {
      setError(ERROR(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function readFile(file?: File) {
    if (!file) return;
    if (file.size > 16_384) {
      setError("Backup files must be smaller than 16 KB.");
      return;
    }
    try {
      const text = await file.text();
      parseBackup(text);
      setEncryptedImport(text);
      setImportText("");
      setError("");
    } catch (e) {
      setError(ERROR(e));
    }
  }

  return (
    <div className="wallet-panel">
      <header className="wallet-title">
        <div className="wallet-icon">
          <KeyRound size={22} />
        </div>
        <div>
          <span className="wallet-eyebrow">SELF CUSTODY</span>
          <h2>Your keys. Your browser.</h2>
        </div>
      </header>
      <p className="wallet-muted">
        Generate a wallet locally, back up its recovery words, and protect the browser copy with a
        separate wallet passphrase. Your account password cannot recover it.
      </p>
      {error && (
        <p className="wallet-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="wallet-success" role="status">
          <Check size={16} />
          {notice}
        </p>
      )}

      {step === "home" && (
        <>
          <div className="wallet-warning">
            <ShieldCheck size={20} />
            <p>
              This wallet is experimental and has not been independently audited. Back up your words
              offline before depositing funds. No recovery service or fund guarantee is provided.
            </p>
          </div>
          <div className="wallet-actions">
            <button className="wallet-primary" onClick={generate}>
              <Plus size={17} />
              Create a wallet
            </button>
            <button
              className="wallet-secondary"
              onClick={() => {
                clear();
                setStep("import");
              }}
            >
              <Upload size={16} />
              Import wallet
            </button>
          </div>
          <div className="wallet-network-list">
            Bitcoin · Ethereum + EVM · Solana · Cosmos · XRP · NEAR
          </div>
          <div className="wallet-list">
            {wallets.length === 0 ? (
              <div className="wallet-empty">
                <LockKeyhole size={28} />
                <h3>No local wallets yet</h3>
                <p>Watching a public address never requires its private key.</p>
              </div>
            ) : (
              wallets.map((wallet) => <WalletCard key={wallet.id} wallet={wallet} />)
            )}
          </div>
          <details className="wallet-details">
            <summary>Identity verification and service custody</summary>
            <p>
              Yoti verification and service-held keys are not connected. Identity verification does
              not store or recover cryptocurrency keys. Those features require a separate identity
              provider, a custody service, secure key management, and a recovery policy. Signing in
              does not upload or back up your wallet.
            </p>
            <p>
              Polkadot and Monero wallet generation is not supported. NEAR uses an implicit account;
              it must be funded/activated. XRP accounts require the network reserve.
            </p>
          </details>
          <button className="wallet-secondary wallet-full" onClick={close}>
            Done
          </button>
        </>
      )}

      {step === "backup" && (
        <>
          <button className="wallet-back" onClick={goHome}>
            <ArrowLeft size={15} />
            Cancel and discard
          </button>
          <h3>Write down your {words.length} recovery words</h3>
          <p className="wallet-muted">
            Keep the order. Anyone with these words can control the wallet. Do not share them, take
            a screenshot, or save them to a public cloud.
          </p>
          <ol className="wallet-words" aria-label="Recovery phrase">
            {words.map((word, i) => (
              <li key={i}>
                <span>{i + 1}</span>
                {word}
              </li>
            ))}
          </ol>
          <label className="wallet-check">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>
              I wrote down these words in order and understand that Fathom cannot recover them.
            </span>
          </label>
          <button
            className="wallet-primary wallet-full"
            disabled={!acknowledged}
            onClick={() => {
              setError("");
              setStep("confirm");
            }}
          >
            Verify my backup
          </button>
        </>
      )}

      {step === "confirm" && (
        <form onSubmit={(e) => void save(e)}>
          <button
            type="button"
            className="wallet-back"
            onClick={() => {
              setError("");
              setStep("backup");
            }}
            disabled={busy}
          >
            <ArrowLeft size={15} />
            Review words
          </button>
          <h3>Confirm your backup</h3>
          <p className="wallet-muted">Enter these words from your offline copy.</p>
          <div className="wallet-challenge">
            {positions.map((position, i) => (
              <label key={position}>
                Word {position + 1}
                <input
                  aria-label={`Word ${position + 1}`}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={answers[i]}
                  onChange={(e) =>
                    setAnswers(answers.map((answer, n) => (n === i ? e.target.value : answer)))
                  }
                  required
                />
              </label>
            ))}
          </div>
          <label className="wallet-field">
            Wallet name
            <input
              value={label}
              maxLength={80}
              onChange={(e) => setLabel(e.target.value)}
              required
            />
          </label>
          <label className="wallet-field">
            Wallet passphrase
            <input
              type="password"
              value={passphrase}
              minLength={12}
              maxLength={1024}
              autoComplete="new-password"
              onChange={(e) => setPassphrase(e.target.value)}
              required
            />
          </label>
          <label className="wallet-field">
            Confirm wallet passphrase
            <input
              type="password"
              value={again}
              autoComplete="new-password"
              onChange={(e) => setAgain(e.target.value)}
              required
            />
          </label>
          <p className="wallet-muted">
            Use at least 12 characters. Symbols and spaces are welcome. This encrypts the local
            recovery phrase using AES-256-GCM and PBKDF2-SHA256 (600,000 iterations). It is not a
            BIP39 seed passphrase.
          </p>
          <label className="wallet-check">
            <input
              type="checkbox"
              checked={watchOnSave}
              onChange={(e) => setWatchOnSave(e.target.checked)}
            />
            <span>
              Also watch these six public addresses. This shares them with public blockchain
              providers to fetch balances and activity.
            </span>
          </label>
          <button className="wallet-primary wallet-full" disabled={busy} type="submit">
            <LockKeyhole size={16} />
            {busy ? "Encrypting locally…" : "Encrypt and save wallet"}
          </button>
        </form>
      )}

      {step === "import" && (
        <form onSubmit={(e) => void importWallet(e)}>
          <button type="button" className="wallet-back" onClick={goHome} disabled={busy}>
            <ArrowLeft size={15} />
            Back
          </button>
          <h3>Restore your wallet</h3>
          <p className="wallet-muted">
            Import a Fathom encrypted backup or English BIP39 words. Processing stays in this
            browser. Only the first account at the documented paths is derived; other wallet paths
            or seed passphrases can produce different addresses.
          </p>
          <label className="wallet-file">
            <Upload size={20} />
            <span>
              {encryptedImport ? "Encrypted backup loaded" : "Choose encrypted JSON backup"}
            </span>
            <input
              type="file"
              accept=".json,application/json"
              aria-label="Encrypted backup file"
              onChange={(e) => void readFile(e.target.files?.[0])}
            />
          </label>
          {encryptedImport ? (
            <>
              <label className="wallet-field">
                Backup passphrase
                <input
                  type="password"
                  autoComplete="current-password"
                  value={importPassword}
                  onChange={(e) => setImportPassword(e.target.value)}
                  required
                />
              </label>
              <button
                type="button"
                className="wallet-back"
                onClick={() => {
                  setEncryptedImport("");
                  setImportPassword("");
                }}
              >
                Use recovery words instead
              </button>
            </>
          ) : (
            <label className="wallet-field">
              Recovery words
              <textarea
                value={importText}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setImportText(e.target.value)}
                placeholder="word one, word two… (separated by spaces)"
                required
              />
            </label>
          )}
          <button type="submit" className="wallet-primary wallet-full" disabled={busy}>
            {busy ? "Decrypting locally…" : "Continue to backup verification"}
          </button>
        </form>
      )}
    </div>
  );
}

function WalletCard({ wallet }: { wallet: LocalWallet }) {
  const addWatched = useLedger((s) => s.addWatched);
  const removeWallet = useLedger((s) => s.removeWallet);
  const [unlock, setUnlock] = useState("");
  const [revealing, setRevealing] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!phrase) return;
    const hide = () => {
      setPhrase("");
      setUnlock("");
      setRevealing(false);
    };
    const timer = setTimeout(hide, 90_000);
    const onVisibility = () => {
      if (document.hidden) hide();
    };
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [phrase]);
  async function reveal(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (!wallet.encrypted)
        throw new Error("No encrypted recovery phrase is stored in this browser.");
      const value = await openSecret(wallet.encrypted, unlock);
      if (!isValidMnemonic(value))
        throw new Error("The encrypted backup does not contain valid recovery words.");
      if (alive.current) {
        setPhrase(value);
        setUnlock("");
      }
    } catch (e) {
      if (alive.current) setError(ERROR(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function exportBackup() {
    try {
      if (!wallet.encrypted) throw new Error("No local encrypted recovery phrase to export.");
      const text = JSON.stringify(
        createBackup(wallet.label, wallet.createdAt, wallet.encrypted),
        null,
        2,
      );
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `fathom-wallet-${wallet.id.slice(0, 8)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Encrypted backup downloaded. Store its passphrase separately.");
    } catch (e) {
      setError(ERROR(e));
    }
  }
  async function copyAddress(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("Public address copied.");
    } catch {
      setError("Clipboard unavailable. Select and copy the public address manually.");
    }
  }
  function watch() {
    let added = 0;
    for (const [chain, address] of Object.entries(wallet.addresses))
      if (
        address &&
        !addWatched({
          chain: chain as ChainId,
          address,
          label: `${wallet.label} · ${CHAINS[chain as ChainId].symbol}`,
          walletId: wallet.id,
        })
      )
        added++;
    for (const chain of EVM_CHAIN_IDS)
      if (
        chain !== "ethereum" &&
        !addWatched({
          chain,
          address: wallet.addresses.ethereum,
          label: `${wallet.label} · ${CHAINS[chain].name}`,
          walletId: wallet.id,
        })
      )
        added++;
    setStatus(
      added
        ? `${added} addresses added to the dashboard.`
        : "These addresses are already being watched.",
    );
  }
  return (
    <article className="wallet-card">
      <header>
        <div>
          <h3>{wallet.label}</h3>
          <span className="wallet-tag">
            <LockKeyhole size={12} />
            {wallet.encrypted?.kdf === "pbkdf2"
              ? "Encrypted on this device"
              : wallet.encrypted
                ? "Legacy recovery copy"
                : "No local recovery copy"}
          </span>
        </div>
        <button
          className="wallet-icon-button"
          title="Remove local wallet"
          aria-label={`Remove ${wallet.label}`}
          onClick={() => setRemoving(true)}
        >
          <Trash2 size={16} />
        </button>
      </header>
      {error && (
        <p className="wallet-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="wallet-success" role="status">
          {status}
        </p>
      )}
      <details className="wallet-addresses">
        <summary>View addresses and derivation paths</summary>
        {Object.entries(wallet.addresses).map(
          ([chain, address]) =>
            address && (
              <div key={chain}>
                <span>{CHAINS[chain as ChainId].name}</span>
                <code>{address}</code>
                <small>{DERIVATION_PATHS[chain as keyof WalletAddresses]}</small>
                <button
                  aria-label={`Copy ${CHAINS[chain as ChainId].name} address`}
                  onClick={() => void copyAddress(address)}
                >
                  <Copy size={13} />
                  Copy address
                </button>
              </div>
            ),
        )}
      </details>
      <p className="wallet-muted">
        Watching sends the public addresses to blockchain data providers. Your recovery words stay
        here.
      </p>
      <div className="wallet-actions">
        <button className="wallet-secondary" onClick={exportBackup}>
          <Download size={15} />
          Encrypted backup
        </button>
        <button className="wallet-secondary" onClick={watch}>
          <Plus size={15} />
          Watch all networks
        </button>
      </div>
      <button
        className="wallet-back"
        onClick={() => {
          setRevealing(!revealing);
          setPhrase("");
          setUnlock("");
          setError("");
        }}
      >
        <Eye size={14} />
        {revealing ? "Hide recovery section" : "Reveal recovery words"}
      </button>
      {revealing &&
        (phrase ? (
          <>
            <ol className="wallet-words">
              {phrase.split(" ").map((word, i) => (
                <li key={i}>
                  <span>{i + 1}</span>
                  {word}
                </li>
              ))}
            </ol>
            <p className="wallet-muted">
              Words hide after 90 seconds or when this window loses focus.
            </p>
            <button
              className="wallet-secondary"
              onClick={() => {
                setPhrase("");
                setRevealing(false);
              }}
            >
              Hide words now
            </button>
          </>
        ) : (
          <form className="wallet-unlock" onSubmit={(e) => void reveal(e)}>
            <label className="wallet-field">
              Wallet passphrase
              <input
                type="password"
                value={unlock}
                autoComplete="current-password"
                maxLength={1024}
                onChange={(e) => setUnlock(e.target.value)}
                required
              />
            </label>
            <button type="submit" className="wallet-secondary" disabled={busy}>
              {busy ? "Decrypting…" : "Unlock locally"}
            </button>
          </form>
        ))}
      {removing && (
        <div className="wallet-warning">
          <div>
            <p>
              Remove the encrypted local copy and its watched addresses? Keep your offline words or
              encrypted backup first. This does not remove funds from the blockchain.
            </p>
            <div className="wallet-actions">
              <button className="wallet-danger" onClick={() => removeWallet(wallet.id)}>
                Remove local copy
              </button>
              <button className="wallet-secondary" onClick={() => setRemoving(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
