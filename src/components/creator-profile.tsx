import {
  cloneElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Download,
  ExternalLink,
  Gift,
  Heart,
  Link as LinkIcon,
  Plus,
  Save,
  Share2,
  Trash2,
  Upload,
  UserRound,
} from "lucide-react";
import { CHAINS, CHAIN_IDS, chainLabel } from "@/lib/chains";
import { downloadFile } from "@/lib/portfolio";
import {
  DEFAULT_CREATOR_PROFILE,
  decodeProfileShare,
  encodeProfileShare,
  parseCreatorProfile,
  serializeCreatorProfile,
  validateCreatorProfile,
  type CreatorProfileData,
  type DonationAddress,
  type ProfileLink,
  type WishlistItem,
} from "@/lib/creator-profile";
import "./creator-profile.css";

const STORAGE_KEY = "fathom.creator-profile.v1";
const MAX_IMPORT_BYTES = 50_000;
const SERVICES = [
  {
    key: "allmylinks",
    label: "AllMyLinks profile",
    placeholder: "https://allmylinks.com/your-name",
  },
  { key: "throne", label: "Throne wishlist", placeholder: "https://throne.com/your-name" },
  {
    key: "nowpayments",
    label: "NOWPayments checkout",
    placeholder: "Your https://nowpayments.io/… payment link",
  },
  { key: "bluesky", label: "Bluesky profile", placeholder: "https://bsky.app/profile/your-handle" },
] as const;

export interface CreatorProfileProps {
  accountAvailable?: boolean;
  accountStatus?: string;
  onSaveAccount?: (profile: CreatorProfileData) => Promise<void>;
  onLoadAccount?: () => Promise<CreatorProfileData | null>;
  renderPublication?: (profile: CreatorProfileData | null) => ReactNode;
}

function freshProfile(): CreatorProfileData {
  return structuredClone(DEFAULT_CREATOR_PROFILE);
}
function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
function messageFrom(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The profile could not be saved. Please try again.";
}
function move<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const result = [...items];
  const destination = index + direction;
  if (destination < 0 || destination >= items.length) return result;
  [result[index], result[destination]] = [result[destination]!, result[index]!];
  return result;
}

function Field({
  label,
  children,
  help,
}: {
  label: string;
  children: ReactElement<{ id?: string; "aria-describedby"?: string }>;
  help?: string;
}) {
  const id = useId();
  return (
    <div className="creator-field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, "aria-describedby": help ? `${id}-help` : undefined })}
      {help && <small id={`${id}-help`}>{help}</small>}
    </div>
  );
}
function External({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={className}>
      {children}
      <ExternalLink size={13} aria-hidden="true" />
    </a>
  );
}
function RowActions({
  label,
  index,
  count,
  onMove,
  onRemove,
}: {
  label: string;
  index: number;
  count: number;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="creator-row-actions">
      <button
        type="button"
        aria-label={`Move ${label} up`}
        title="Move up"
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUp size={14} />
      </button>
      <button
        type="button"
        aria-label={`Move ${label} down`}
        title="Move down"
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        <ArrowDown size={14} />
      </button>
      <button type="button" aria-label={`Remove ${label}`} title="Remove" onClick={onRemove}>
        <Trash2 size={14} />
      </button>
    </div>
  );
}

export function PublicProfile({
  profile,
  onCopy,
  shared = false,
  published = false,
}: {
  profile: CreatorProfileData;
  onCopy: (value: string, label: string) => void;
  shared?: boolean;
  published?: boolean;
}) {
  const hasDonations = Boolean(
    profile.donations.bankLink ||
    profile.serviceLinks.nowpayments ||
    profile.donations.crypto.length,
  );
  return (
    <article
      className="creator-public-card"
      aria-label={
        published
          ? "Published creator profile"
          : shared
            ? "Shared creator profile"
            : "Public profile preview"
      }
    >
      <div className="creator-avatar">
        <UserRound size={27} aria-hidden="true" />
      </div>
      <span className="creator-eyebrow">
        {published ? "CREATOR PROFILE" : shared ? "SHARED PROFILE" : "PUBLIC PREVIEW"}
      </span>
      <h2>{profile.displayName || "Your creator profile"}</h2>
      {profile.bio && <p className="creator-public-bio">{profile.bio}</p>}
      <p className="creator-self-reported">
        Links are self-reported. Adding a URL does not verify account ownership.
      </p>
      {(profile.serviceLinks.allmylinks ||
        profile.serviceLinks.bluesky ||
        profile.links.length > 0) && (
        <section className="creator-public-section">
          <h3>
            <LinkIcon size={15} /> Links
          </h3>
          {profile.serviceLinks.allmylinks && (
            <External className="creator-public-link" href={profile.serviceLinks.allmylinks}>
              AllMyLinks profile
            </External>
          )}
          {profile.serviceLinks.bluesky && (
            <External className="creator-public-link" href={profile.serviceLinks.bluesky}>
              Bluesky profile
            </External>
          )}
          {profile.links.map((link) => (
            <External key={link.id} className="creator-public-link" href={link.url}>
              {link.label}
            </External>
          ))}
        </section>
      )}
      {(profile.wishlist.length > 0 || profile.serviceLinks.throne) && (
        <section className="creator-public-section">
          <h3>
            <Gift size={15} /> Wishlist
          </h3>
          {profile.serviceLinks.throne && (
            <External className="creator-public-link" href={profile.serviceLinks.throne}>
              Open Throne wishlist
            </External>
          )}
          {profile.wishlist.map((item) => (
            <External className="creator-wish-link" href={item.url} key={item.id}>
              <span>
                {item.title}
                {item.price && (
                  <small>
                    {item.price} {item.currency}
                  </small>
                )}
              </span>
            </External>
          ))}
          <p>Wishlist links open the merchant. Prices are provided by the profile creator.</p>
        </section>
      )}
      {hasDonations && (
        <section className="creator-public-section">
          <h3>
            <Heart size={15} /> Support
          </h3>
          {profile.donations.bankLink && (
            <External className="creator-public-link" href={profile.donations.bankLink}>
              Bank / payment checkout
            </External>
          )}
          {profile.serviceLinks.nowpayments && (
            <External className="creator-public-link" href={profile.serviceLinks.nowpayments}>
              Crypto checkout via NOWPayments
            </External>
          )}
          {profile.donations.crypto.map((donation) => (
            <div className="creator-donation-card" key={donation.id}>
              <strong>{donation.label || "Crypto donation"}</strong>
              <span>{chainLabel(donation.chain)}</span>
              <code>{donation.address}</code>
              <div className="creator-donation-actions">
                <button type="button" onClick={() => onCopy(donation.address, "Public address")}>
                  <Copy size={12} /> Copy address
                </button>
                <External href={CHAINS[donation.chain].addressUrl(donation.address)}>
                  Explorer
                </External>
              </div>
            </div>
          ))}
          <p>
            Confirm the network and address before sending. Crypto transfers are irreversible.
            Payment methods and bank transfers depend on the external provider and your region.
          </p>
        </section>
      )}
      {!profile.links.length &&
        !profile.wishlist.length &&
        !hasDonations &&
        !Object.values(profile.serviceLinks).some(Boolean) && (
          <p className="creator-empty">Add a link, a wishlist item, or a way to support you.</p>
        )}
    </article>
  );
}

export function CreatorProfile({
  accountAvailable = false,
  accountStatus,
  onSaveAccount,
  onLoadAccount,
  renderPublication,
}: CreatorProfileProps) {
  const [draft, setDraft] = useState<CreatorProfileData>(freshProfile);
  const [shared, setShared] = useState<CreatorProfileData | null>(null);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [busy, setBusy] = useState<"save" | "load" | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const editRevision = useRef(0);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setDraft(parseCreatorProfile(saved));
    } catch (cause) {
      setError(
        `Your saved profile could not be loaded: ${messageFrom(cause)} The stored draft has been kept. You can import a backup or save a replacement explicitly.`,
      );
    }
    const readShare = () => {
      const payload = new URLSearchParams(window.location.hash.slice(1)).get("profile");
      if (!payload) {
        setShared(null);
        return;
      }
      try {
        setShared(decodeProfileShare(payload));
        setError("");
      } catch (cause) {
        setShared(null);
        setError(
          `This shared profile is invalid: ${messageFrom(cause)} Your local draft has not changed.`,
        );
      }
    };
    readShare();
    window.addEventListener("hashchange", readShare);
    setReady(true);
    return () => window.removeEventListener("hashchange", readShare);
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warnOnClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnOnClose);
    return () => window.removeEventListener("beforeunload", warnOnClose);
  }, [dirty]);

  const validatedPreview = useMemo(() => {
    try {
      return validateCreatorProfile(draft);
    } catch {
      return null;
    }
  }, [draft]);
  const edit = (update: (current: CreatorProfileData) => CreatorProfileData) => {
    editRevision.current += 1;
    setDraft(update);
    setDirty(true);
    setShareUrl("");
    setNotice("");
  };
  const clearFeedback = () => {
    setError("");
    setNotice("");
  };
  const checked = () => validateCreatorProfile(draft);
  const copy = async (value: string, label: string) => {
    clearFeedback();
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied.`);
    } catch {
      setError(
        `Clipboard access is unavailable. Select and copy the ${label.toLowerCase()} shown on this page.`,
      );
    }
  };
  const saveLocal = () => {
    clearFeedback();
    try {
      const profile = checked();
      window.localStorage.setItem(STORAGE_KEY, serializeCreatorProfile(profile));
      editRevision.current += 1;
      setDraft(profile);
      setDirty(false);
      setNotice("Public profile saved in this browser. Export a backup to keep a copy elsewhere.");
    } catch (cause) {
      setError(messageFrom(cause));
    }
  };
  const exportProfile = () => {
    clearFeedback();
    try {
      downloadFile("creator-profile.json", serializeCreatorProfile(checked()));
      setNotice("Public profile exported. Account credentials and wallet keys are never included.");
    } catch (cause) {
      setError(messageFrom(cause));
    }
  };
  const shareProfile = async () => {
    clearFeedback();
    try {
      const sharePath =
        window.location.pathname.replace(/\/+$/, "") === "/login" ? "/" : window.location.pathname;
      const url = new URL(sharePath, window.location.origin);
      url.hash = `profile=${encodeProfileShare(checked())}`;
      setShareUrl(url.href);
      try {
        await navigator.clipboard.writeText(url.href);
        setNotice("Public profile link copied. Anyone with the link can view its contents.");
      } catch {
        setNotice("Your public profile link is ready below. Select and copy it to share.");
      }
    } catch (cause) {
      setError(messageFrom(cause));
    }
  };
  const approveReplace = () =>
    !dirty ||
    window.confirm(
      "Replace your unsaved profile edits? Export a backup first if you want to keep them.",
    );
  const importProfile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    clearFeedback();
    const requestedAtRevision = editRevision.current;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error("Profile files must be 50 KB or smaller.");
      const profile = parseCreatorProfile(await file.text());
      if (requestedAtRevision !== editRevision.current) {
        if (
          !window.confirm(
            "You edited the profile while this file was loading. Replace those edits with the imported profile?",
          )
        )
          return;
      } else if (!approveReplace()) return;
      editRevision.current += 1;
      setDraft(profile);
      setDirty(true);
      setShareUrl("");
      setNotice(
        "Public profile imported for editing. Save it in this browser or to your account when ready.",
      );
    } catch (cause) {
      setError(messageFrom(cause));
    }
  };
  const saveAccount = async () => {
    if (!accountAvailable || !onSaveAccount || busy) return;
    clearFeedback();
    try {
      const profile = checked();
      setBusy("save");
      await onSaveAccount(profile);
      setNotice("Public profile saved to your account. Local browser saving is separate.");
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(null);
    }
  };
  const loadAccount = async () => {
    if (!accountAvailable || !onLoadAccount || busy || !approveReplace()) return;
    clearFeedback();
    const requestedAtRevision = editRevision.current;
    setBusy("load");
    try {
      const profile = await onLoadAccount();
      if (!profile) {
        setNotice("Your account does not have a saved creator profile yet.");
        return;
      }
      if (
        requestedAtRevision !== editRevision.current &&
        !window.confirm(
          "You edited the profile while the account backup was loading. Replace those edits with the account profile?",
        )
      )
        return;
      editRevision.current += 1;
      setDraft(validateCreatorProfile(profile));
      setDirty(true);
      setShareUrl("");
      setNotice("Account profile loaded for editing. Save in this browser to keep a local copy.");
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(null);
    }
  };
  const leaveSharedView = () => {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    setShared(null);
    clearFeedback();
  };
  const useSharedDraft = () => {
    if (!shared || !approveReplace()) return;
    editRevision.current += 1;
    setDraft(validateCreatorProfile(shared));
    setDirty(true);
    leaveSharedView();
    setNotice(
      "Shared profile copied into your local editor. Save when ready; this does not verify ownership.",
    );
  };
  const updateLink = (id: string, patch: Partial<ProfileLink>) =>
    edit((p) => ({
      ...p,
      links: p.links.map((link) => (link.id === id ? { ...link, ...patch } : link)),
    }));
  const updateWish = (id: string, patch: Partial<WishlistItem>) =>
    edit((p) => ({
      ...p,
      wishlist: p.wishlist.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  const updateDonation = (id: string, patch: Partial<DonationAddress>) =>
    edit((p) => ({
      ...p,
      donations: {
        ...p.donations,
        crypto: p.donations.crypto.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      },
    }));

  return (
    <section className="creator-page">
      <div className="creator-page-heading">
        <div>
          <span className="creator-eyebrow">YOUR PUBLIC SPACE</span>
          <h1>{shared ? "Shared creator profile" : "Creator profile"}</h1>
          <p>Bring your links, wishlist, and ways to support you together.</p>
        </div>
        {shared ? (
          <div className="creator-toolbar">
            <button type="button" onClick={leaveSharedView}>
              Back to my draft
            </button>
            <button type="button" onClick={useSharedDraft}>
              <Copy size={14} /> Use as local draft
            </button>
          </div>
        ) : (
          <span className="creator-local-status">
            <span />
            {dirty ? "Unsaved edits" : "Local browser draft"}
          </span>
        )}
      </div>
      {error && (
        <div className="creator-feedback" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="creator-feedback" role="status">
          <Check size={14} />
          {notice}
        </div>
      )}
      {shared ? (
        <div className="creator-shared-wrap">
          <p className="creator-hint">
            This is a read-only snapshot. The link contains public profile data and does not update
            when the creator changes their draft.
          </p>
          <PublicProfile profile={shared} shared onCopy={copy} />
        </div>
      ) : !ready ? (
        <p className="creator-hint">Loading your local draft…</p>
      ) : (
        <>
          <div className="creator-toolbar creator-main-actions">
            <button type="button" onClick={saveLocal}>
              <Save size={14} /> Save local draft
            </button>
            <button type="button" onClick={exportProfile}>
              <Download size={14} /> Export JSON
            </button>
            <button type="button" onClick={() => importInput.current?.click()}>
              <Upload size={14} /> Import JSON
            </button>
            <button type="button" onClick={shareProfile}>
              <Share2 size={14} /> Create share link
            </button>
            <input
              ref={importInput}
              type="file"
              accept=".json,application/json"
              hidden
              aria-label="Import creator profile JSON"
              onChange={importProfile}
            />
          </div>
          {shareUrl && (
            <Field
              label="Public share link"
              help="Anyone with this link can read the public profile, donation addresses, and links. Share only information you want to publish."
            >
              <input
                className="creator-share-input"
                value={shareUrl}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
              />
            </Field>
          )}
          <div className="creator-account-bar">
            <div>
              <strong>Account backup</strong>
              <p>
                {accountStatus ||
                  (accountAvailable
                    ? "Save your public profile across devices. This does not publish it."
                    : "Sign in to save a public profile to your account. Local editing and sharing work without an account.")}
              </p>
            </div>
            <div className="creator-toolbar">
              <button
                type="button"
                disabled={!accountAvailable || !onSaveAccount || Boolean(busy)}
                onClick={saveAccount}
              >
                {busy === "save" ? "Saving…" : "Save to account"}
              </button>
              <button
                type="button"
                disabled={!accountAvailable || !onLoadAccount || Boolean(busy)}
                onClick={loadAccount}
              >
                {busy === "load" ? "Loading…" : "Load account profile"}
              </button>
            </div>
          </div>
          {renderPublication?.(validatedPreview)}
          <div className="creator-workspace">
            <div className="creator-editor">
              <section className="creator-edit-section">
                <div className="creator-section-heading">
                  <h2>
                    <UserRound size={17} /> About you
                  </h2>
                  <span>Public information only</span>
                </div>
                <Field label="Display name">
                  <input
                    value={draft.displayName}
                    maxLength={80}
                    placeholder="Your name or creator name"
                    autoComplete="off"
                    onChange={(e) => edit((p) => ({ ...p, displayName: e.target.value }))}
                  />
                </Field>
                <Field label="Bio">
                  <textarea
                    value={draft.bio}
                    maxLength={500}
                    rows={3}
                    placeholder="A little about you and what you create"
                    onChange={(e) => edit((p) => ({ ...p, bio: e.target.value }))}
                  />
                </Field>
                <p className="creator-hint">
                  Unicode names are welcome. These details are separate from your sign-in and
                  linked-account verification.
                </p>
              </section>
              <section className="creator-edit-section">
                <div className="creator-section-heading">
                  <h2>
                    <LinkIcon size={17} /> Links
                  </h2>
                  <span>{draft.links.length} / 20</span>
                </div>
                <p className="creator-hint">
                  Add social profiles or any public HTTPS page. Put your most useful links first.
                </p>
                {draft.links.map((link, index) => (
                  <div className="creator-item" key={link.id}>
                    <div className="creator-item-heading">
                      <strong>Link {index + 1}</strong>
                      <RowActions
                        label={`link ${index + 1}`}
                        index={index}
                        count={draft.links.length}
                        onMove={(direction) =>
                          edit((p) => ({ ...p, links: move(p.links, index, direction) }))
                        }
                        onRemove={() =>
                          edit((p) => ({
                            ...p,
                            links: p.links.filter((item) => item.id !== link.id),
                          }))
                        }
                      />
                    </div>
                    <Field label="Link label">
                      <input
                        value={link.label}
                        maxLength={80}
                        placeholder="My website, Discord, Instagram…"
                        onChange={(e) => updateLink(link.id, { label: e.target.value })}
                      />
                    </Field>
                    <Field label="Link URL">
                      <input
                        type="url"
                        value={link.url}
                        maxLength={2048}
                        placeholder="https://example.com/your-page"
                        onChange={(e) => updateLink(link.id, { url: e.target.value })}
                      />
                    </Field>
                  </div>
                ))}
                <button
                  type="button"
                  className="creator-add-button"
                  disabled={draft.links.length >= 20}
                  onClick={() =>
                    edit((p) => ({
                      ...p,
                      links: [...p.links, { id: newId(), label: "", url: "" }],
                    }))
                  }
                >
                  <Plus size={14} /> Add link
                </button>
              </section>
              <section className="creator-edit-section">
                <div className="creator-section-heading">
                  <h2>
                    <Gift size={17} /> Wishlist
                  </h2>
                  <span>{draft.wishlist.length} / 20</span>
                </div>
                <p className="creator-hint">
                  Link to gifts or things you are saving for. Visitors complete any purchase on the
                  merchant’s website.
                </p>
                {draft.wishlist.map((item, index) => (
                  <div className="creator-item" key={item.id}>
                    <div className="creator-item-heading">
                      <strong>Item {index + 1}</strong>
                      <RowActions
                        label={`wishlist item ${index + 1}`}
                        index={index}
                        count={draft.wishlist.length}
                        onMove={(direction) =>
                          edit((p) => ({ ...p, wishlist: move(p.wishlist, index, direction) }))
                        }
                        onRemove={() =>
                          edit((p) => ({
                            ...p,
                            wishlist: p.wishlist.filter((wish) => wish.id !== item.id),
                          }))
                        }
                      />
                    </div>
                    <Field label="Item title">
                      <input
                        value={item.title}
                        maxLength={120}
                        placeholder="What is on your wishlist?"
                        onChange={(e) => updateWish(item.id, { title: e.target.value })}
                      />
                    </Field>
                    <Field label="Item URL">
                      <input
                        type="url"
                        value={item.url}
                        maxLength={2048}
                        placeholder="https://shop.example.com/item"
                        onChange={(e) => updateWish(item.id, { url: e.target.value })}
                      />
                    </Field>
                    <div className="creator-price-fields">
                      <Field label="Price (optional)">
                        <input
                          inputMode="decimal"
                          value={item.price}
                          maxLength={20}
                          placeholder="0.00"
                          onChange={(e) => updateWish(item.id, { price: e.target.value })}
                        />
                      </Field>
                      <Field label="Currency">
                        <input
                          value={item.currency}
                          maxLength={3}
                          placeholder="USD"
                          onChange={(e) =>
                            updateWish(item.id, { currency: e.target.value.toUpperCase() })
                          }
                        />
                      </Field>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  className="creator-add-button"
                  disabled={draft.wishlist.length >= 20}
                  onClick={() =>
                    edit((p) => ({
                      ...p,
                      wishlist: [
                        ...p.wishlist,
                        { id: newId(), title: "", url: "", price: "", currency: "USD" },
                      ],
                    }))
                  }
                >
                  <Plus size={14} /> Add wishlist item
                </button>
              </section>
              <section className="creator-edit-section">
                <div className="creator-section-heading">
                  <h2>
                    <Heart size={17} /> Donations
                  </h2>
                  <span>External checkout / public addresses</span>
                </div>
                <Field
                  label="Bank / hosted payment link"
                  help="Use a provider-hosted payment page that accepts bank transfers or your preferred payment method. Availability depends on your provider and region. Do not enter bank account or card details."
                >
                  <input
                    type="url"
                    value={draft.donations.bankLink}
                    maxLength={2048}
                    placeholder="https://your-payment-provider.com/your-page"
                    onChange={(e) =>
                      edit((p) => ({
                        ...p,
                        donations: { ...p.donations, bankLink: e.target.value },
                      }))
                    }
                  />
                </Field>
                <p className="creator-hint">
                  Add public receiving addresses only. Never enter seed phrases, private keys,
                  exchange passwords, or wallet recovery data.
                </p>
                {draft.donations.crypto.map((donation, index) => (
                  <div className="creator-item" key={donation.id}>
                    <div className="creator-item-heading">
                      <strong>Crypto address {index + 1}</strong>
                      <button
                        type="button"
                        className="creator-remove-button"
                        aria-label={`Remove crypto address ${index + 1}`}
                        onClick={() =>
                          edit((p) => ({
                            ...p,
                            donations: {
                              ...p.donations,
                              crypto: p.donations.crypto.filter((item) => item.id !== donation.id),
                            },
                          }))
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <Field label="Blockchain">
                      <select
                        value={donation.chain}
                        onChange={(e) =>
                          updateDonation(donation.id, {
                            chain: e.target.value as DonationAddress["chain"],
                          })
                        }
                      >
                        {CHAIN_IDS.map((chain) => (
                          <option key={chain} value={chain}>
                            {chainLabel(chain)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Public receiving address">
                      <input
                        value={donation.address}
                        maxLength={200}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoComplete="off"
                        placeholder="Address for the selected network"
                        onChange={(e) => updateDonation(donation.id, { address: e.target.value })}
                      />
                    </Field>
                    <Field label="Address label (optional)">
                      <input
                        value={donation.label}
                        maxLength={80}
                        placeholder="Support my work"
                        onChange={(e) => updateDonation(donation.id, { label: e.target.value })}
                      />
                    </Field>
                  </div>
                ))}
                <button
                  type="button"
                  className="creator-add-button"
                  disabled={draft.donations.crypto.length >= 10}
                  onClick={() =>
                    edit((p) => ({
                      ...p,
                      donations: {
                        ...p.donations,
                        crypto: [
                          ...p.donations.crypto,
                          { id: newId(), chain: "ethereum", address: "", label: "" },
                        ],
                      },
                    }))
                  }
                >
                  <Plus size={14} /> Add crypto address ({draft.donations.crypto.length} / 10)
                </button>
              </section>
              <section className="creator-edit-section">
                <div className="creator-section-heading">
                  <h2>
                    <ExternalLink size={17} /> Connected pages
                  </h2>
                  <span>Optional external links</span>
                </div>
                <p className="creator-hint">
                  Already use one of these services? Add your own profile or checkout URL. These
                  links do not connect or verify a sign-in account.
                </p>
                {SERVICES.map((service) => (
                  <Field key={service.key} label={service.label}>
                    <input
                      type="url"
                      value={draft.serviceLinks[service.key]}
                      maxLength={2048}
                      placeholder={service.placeholder}
                      onChange={(e) =>
                        edit((p) => ({
                          ...p,
                          serviceLinks: { ...p.serviceLinks, [service.key]: e.target.value },
                        }))
                      }
                    />
                  </Field>
                ))}
              </section>
            </div>
            <aside className="creator-preview">
              {validatedPreview ? (
                <PublicProfile profile={validatedPreview} onCopy={copy} />
              ) : (
                <div className="creator-preview-incomplete">
                  <UserRound size={24} />
                  <h2>Finish your profile</h2>
                  <p>
                    Complete each added link, wishlist item, and crypto address to see a safe public
                    preview. Save or share to see any validation errors.
                  </p>
                </div>
              )}
              <p className="creator-hint">
                Only the public fields shown here are exported or shared. Your account credentials,
                wallet keys, and dashboard watchlist are kept separate.
              </p>
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
