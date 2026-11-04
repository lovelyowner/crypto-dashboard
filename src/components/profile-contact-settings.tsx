import { useEffect, useId, useState } from "react";
import { Check, MessageSquare, RefreshCw, Save, ShieldCheck } from "lucide-react";
import {
  validateContactConfiguration,
  validateContactSettings,
  type ContactConfiguration,
  type ContactSettings,
} from "@/lib/creator-contact";
import { validatePaymentConfiguration } from "@/lib/payment-types";
import { contactError, contactRequest } from "./contact-request";
import "./profile-contact-settings.css";

type Props = { accountKey: string | null; accountAvailable: boolean };
type ProviderStatus = { configured: boolean; webhookUrl: string | null };
function providerStatus(value: unknown): ProviderStatus {
  return validatePaymentConfiguration(value).nowpayments;
}

export function ProfileContactSettings(props: Props) {
  return <ContactSettingsForm key={props.accountKey ?? "guest"} {...props} />;
}
function ContactSettingsForm({ accountKey, accountAvailable }: Props) {
  const [configuration, setConfiguration] = useState<ContactConfiguration | null>(null);
  const [draft, setDraft] = useState<ContactSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [merchant, setMerchant] = useState<ProviderStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [ipnSecret, setIpnSecret] = useState("");
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState("");
  const [providerNotice, setProviderNotice] = useState("");
  const enabled = accountAvailable && Boolean(accountKey);
  const id = useId();

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError("");
    contactRequest("/api/profile/contact", { signal: controller.signal })
      .then(validateContactConfiguration)
      .then((data) => {
        if (active) {
          setConfiguration(data);
          setDraft(data.settings);
        }
      })
      .catch((cause) => {
        if (active) setError(contactError(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    contactRequest("/api/profile/payments", { signal: controller.signal })
      .then(providerStatus)
      .then((data) => {
        if (active) setMerchant(data);
      })
      .catch(() => {
        /* Contact settings remain usable while payment setup is unavailable. */
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, revision]);

  function update(patch: Partial<ContactSettings>) {
    setDraft((value) => (value ? { ...value, ...patch } : value));
    setNotice("");
  }
  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || saving) return;
    setError("");
    setNotice("");
    try {
      const settings = validateContactSettings(draft);
      setSaving(true);
      const data = validateContactConfiguration(
        await contactRequest("/api/profile/contact", { method: "PUT", body: { settings } }),
      );
      setConfiguration(data);
      setDraft(data.settings);
      setNotice("Message and donation settings saved.");
    } catch (cause) {
      setError(contactError(cause));
    } finally {
      setSaving(false);
    }
  }
  async function saveMerchant(event: React.FormEvent) {
    event.preventDefault();
    if (!apiKey.trim() || !ipnSecret.trim() || providerBusy) return;
    setProviderBusy(true);
    setProviderError("");
    setProviderNotice("");
    try {
      const data = providerStatus(
        await contactRequest("/api/profile/payments", {
          method: "PUT",
          body: { apiKey: apiKey.trim(), ipnSecret: ipnSecret.trim() },
        }),
      );
      setMerchant(data);
      setProviderNotice(
        "Merchant credentials saved privately. Payment status is verified by the account service.",
      );
      setConfiguration((value) =>
        value ? { ...value, nowpaymentsConfigured: data.configured } : value,
      );
    } catch (cause) {
      setProviderError(contactError(cause));
    } finally {
      setApiKey("");
      setIpnSecret("");
      setProviderBusy(false);
    }
  }

  return (
    <section className="profile-contact-settings" aria-labelledby={`${id}-heading`}>
      <div className="profile-contact-heading">
        <div>
          <h2 id={`${id}-heading`}>
            <MessageSquare size={16} /> Messages &amp; donations
          </h2>
          <p>Choose who can contact you and how incoming paid messages are priced.</p>
        </div>
        {enabled && (
          <button
            type="button"
            onClick={() => setRevision((value) => value + 1)}
            disabled={loading || saving}
          >
            <RefreshCw size={13} /> Reload settings
          </button>
        )}
      </div>
      {!enabled ? (
        <p className="profile-contact-help">
          Sign in and publish your page to set up messages and donation notes.
        </p>
      ) : (
        <>
          {error && (
            <p role="alert" className="profile-contact-feedback">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="profile-contact-feedback">
              <Check size={14} />
              {notice}
            </p>
          )}
          {loading && (
            <p role="status" className="profile-contact-help">
              Loading contact settings…
            </p>
          )}
          {draft && (
            <form onSubmit={(event) => void saveSettings(event)}>
              {!configuration?.handle && (
                <p className="profile-contact-help">
                  Publish your creator page first. Receiving wallets are selected from its published
                  public addresses.
                </p>
              )}
              <div className="profile-contact-fields">
                <label>
                  Direct messages
                  <select
                    aria-label="Direct messages"
                    value={draft.dmMode}
                    onChange={(event) =>
                      update({ dmMode: event.target.value as ContactSettings["dmMode"] })
                    }
                    disabled={saving}
                  >
                    <option value="closed">Closed</option>
                    <option value="free">Free for signed-in users</option>
                    <option value="paid">Paid for signed-in users</option>
                  </select>
                </label>
                <label>
                  Ethereum receiving wallet
                  <select
                    aria-label="Ethereum receiving wallet"
                    value={draft.ethDonationAddressId ?? ""}
                    onChange={(event) =>
                      update({ ethDonationAddressId: event.target.value || null })
                    }
                    disabled={saving || !configuration?.ethereumAddresses.length}
                  >
                    <option value="">Choose a published Ethereum address</option>
                    {configuration?.ethereumAddresses.map((address) => (
                      <option key={address.id} value={address.id}>
                        {address.label || "Ethereum wallet"} · {address.address.slice(0, 8)}…
                        {address.address.slice(-6)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="profile-contact-help">
                Add a receiving wallet to your profile and publish the update to make it available
                here. Direct payments go to that wallet on Ethereum mainnet. Hosted checkout uses
                your own NOWPayments merchant account.
              </p>
              {draft.dmMode === "paid" && (
                <div className="profile-contact-fields">
                  <label>
                    ETH price per incoming message
                    <input
                      value={draft.dmEthPrice}
                      onChange={(event) => update({ dmEthPrice: event.target.value })}
                      inputMode="decimal"
                      placeholder="0.001"
                      disabled={saving}
                    />
                  </label>
                  <label>
                    USD price via NOWPayments
                    <input
                      value={draft.dmUsdPrice}
                      onChange={(event) => update({ dmUsdPrice: event.target.value })}
                      inputMode="decimal"
                      placeholder="5.00"
                      disabled={saving}
                    />
                  </label>
                </div>
              )}
              {draft.dmMode === "paid" && (
                <p className="profile-contact-help">
                  Set one or both prices; leave an unused payment method empty. Each incoming
                  message requires its own verified payment. Your replies are free. Payment does not
                  promise a reply.
                </p>
              )}
              <label className="profile-contact-checkbox">
                <input
                  type="checkbox"
                  checked={draft.donationNotesEnabled}
                  onChange={(event) => update({ donationNotesEnabled: event.target.checked })}
                  disabled={saving}
                />
                <span>Allow donation messages, anonymously or with an account</span>
              </label>
              {draft.donationNotesEnabled && (
                <div className="profile-contact-fields">
                  <label>
                    Minimum donation for a note · ETH
                    <input
                      value={draft.minimumDonationEth}
                      onChange={(event) => update({ minimumDonationEth: event.target.value })}
                      inputMode="decimal"
                      disabled={saving}
                    />
                  </label>
                  <label>
                    Minimum donation for a note · USD checkout
                    <input
                      value={draft.minimumDonationUsd}
                      onChange={(event) => update({ minimumDonationUsd: event.target.value })}
                      inputMode="decimal"
                      disabled={saving}
                    />
                  </label>
                </div>
              )}
              <p className="profile-contact-help">
                Donation notes are delivered after payment is verified. Anonymous notes hide the
                donor’s account identity from you; blockchain transfers and payment-provider records
                still exist.
              </p>
              <button type="submit" disabled={saving || loading}>
                <Save size={14} />
                {saving ? "Saving…" : "Save contact settings"}
              </button>
            </form>
          )}
          <details className="profile-contact-provider">
            <summary>
              <ShieldCheck size={14} /> NOWPayments merchant setup{" "}
              <span>
                {configuration?.nowpaymentsConfigured || merchant?.configured
                  ? "Configured"
                  : "Setup required"}
              </span>
            </summary>
            <p className="profile-contact-help">
              Use your own merchant account, API key, and IPN secret. Credentials are encrypted on
              the account service and are never included in a public profile. Your merchant account
              controls provider payouts. Sign in again if fresh authentication is requested.
            </p>
            {providerError && (
              <p className="profile-contact-feedback" role="alert">
                {providerError}
              </p>
            )}
            {providerNotice && (
              <p className="profile-contact-feedback" role="status">
                {providerNotice}
              </p>
            )}
            <form onSubmit={(event) => void saveMerchant(event)}>
              <div className="profile-contact-fields">
                <label>
                  NOWPayments API key
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    disabled={providerBusy}
                  />
                </label>
                <label>
                  NOWPayments IPN secret
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={ipnSecret}
                    onChange={(event) => setIpnSecret(event.target.value)}
                    disabled={providerBusy}
                  />
                </label>
              </div>
              {merchant?.webhookUrl && (
                <label>
                  Payment callback URL
                  <input
                    value={merchant.webhookUrl}
                    readOnly
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
              )}
              <button type="submit" disabled={providerBusy || !apiKey.trim() || !ipnSecret.trim()}>
                <Save size={14} />
                {providerBusy ? "Saving privately…" : "Save merchant credentials"}
              </button>
            </form>
          </details>
        </>
      )}
    </section>
  );
}
