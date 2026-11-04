import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Globe2, LoaderCircle, RefreshCw } from "lucide-react";
import type { CreatorProfileData } from "@/lib/creator-profile";
import {
  normalizePublicHandle,
  validatePublicationResponse,
  type ProfilePublication as Publication,
} from "@/lib/public-profile";
import { formatTransactionDate } from "@/lib/format";
import { getPublicProfilePath, isReservedRootHandle } from "@/lib/profile-url";
import "./profile-publication.css";

export interface ProfilePublicationProps {
  profile: CreatorProfileData | null;
  accountAvailable: boolean;
  accountKey: string | null;
}

async function publicationRequest(
  method: "GET" | "PUT" | "DELETE",
  signal: AbortSignal,
  body?: { handle: string; profile: CreatorProfileData },
) {
  const response = await fetch("/api/profile/publication", {
    method,
    signal,
    credentials: "same-origin",
    cache: "no-store",
    ...(method === "PUT"
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("Public profile publishing is unavailable. Your draft has not changed.");
  }
  if (!response.ok) {
    if (response.status === 401) throw new Error("Sign in again to manage your public page.");
    if (response.status === 503)
      throw new Error(
        "Public page publishing needs the account service to be configured. Local drafts and snapshot links still work.",
      );
    const message =
      data &&
      typeof data === "object" &&
      "message" in data &&
      typeof data.message === "string" &&
      data.message.length <= 300
        ? data.message
        : null;
    throw new Error(message || "The public page could not be updated. Please retry.");
  }
  return validatePublicationResponse(data).publication;
}

/** An account change remounts the controls and aborts the previous account's requests. */
export function ProfilePublication(props: ProfilePublicationProps) {
  return <PublicationControls key={props.accountKey ?? "guest"} {...props} />;
}

function PublicationControls({ profile, accountAvailable, accountKey }: ProfilePublicationProps) {
  const available = accountAvailable && Boolean(accountKey);
  const [publication, setPublication] = useState<Publication | null>(null);
  const [handle, setHandle] = useState("");
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(available);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<"publish" | "unpublish" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [origin, setOrigin] = useState("");
  const [consentedProfile, setConsentedProfile] = useState<string | null>(null);
  const requests = useRef(new Set<AbortController>());
  const mounted = useRef(false);
  const mutating = useRef(false);
  const handleId = useId();
  const helpId = `${handleId}-help`;
  const fingerprint = useMemo(() => (profile ? JSON.stringify(profile) : ""), [profile]);
  const consented = Boolean(fingerprint && fingerprint === consentedProfile);
  const unchanged = Boolean(
    publication?.published && fingerprint === JSON.stringify(publication.profile),
  );
  const chosenHandle = publication?.handle ?? handle;
  let profilePath = "";
  try {
    profilePath = getPublicProfilePath(chosenHandle);
  } catch {
    /* The ID is still being entered. */
  }
  const url = profilePath ? `${origin}${profilePath}` : "";
  let handleValid = false;
  try {
    normalizePublicHandle(chosenHandle);
    handleValid = Boolean(publication) || !isReservedRootHandle(chosenHandle);
  } catch {
    /* Shown as field help until valid. */
  }
  const validDraft = Boolean(profile?.displayName.trim());
  const publishDisabled =
    !available ||
    !ready ||
    loading ||
    Boolean(busy) ||
    !profile ||
    !validDraft ||
    !handleValid ||
    !consented ||
    unchanged;

  useEffect(() => {
    mounted.current = true;
    setOrigin(
      window.location.protocol === "https:" || window.location.protocol === "http:"
        ? window.location.origin
        : "",
    );
    const controllers = requests.current;
    return () => {
      mounted.current = false;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, []);

  useEffect(() => {
    if (!available) {
      setReady(false);
      setLoading(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    const controllers = requests.current;
    controllers.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setLoading(true);
    setError("");
    publicationRequest("GET", controller.signal)
      .then((value) => {
        if (!active) return;
        setPublication(value);
        setHandle(value?.handle ?? "");
        setReady(true);
      })
      .catch((cause) => {
        if (!active) return;
        setError(
          controller.signal.aborted
            ? "The public page service took too long to respond. Please retry."
            : cause instanceof Error
              ? cause.message
              : "Public page publishing is unavailable.",
        );
        setReady(false);
      })
      .finally(() => {
        window.clearTimeout(timeout);
        controllers.delete(controller);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
      controllers.delete(controller);
    };
  }, [available, reload]);

  async function mutate(action: "publish" | "unpublish") {
    if (!available || !ready || mutating.current) return;
    if (action === "publish" && (publishDisabled || !profile)) return;
    if (action === "unpublish" && !publication?.published) return;
    if (
      action === "unpublish" &&
      !window.confirm(
        "Unpublish this hosted profile page? Your handle stays reserved. Saved copies and previously shared snapshot links will remain viewable.",
      )
    )
      return;
    const controller = new AbortController();
    requests.current.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    mutating.current = true;
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const value = await publicationRequest(
        action === "publish" ? "PUT" : "DELETE",
        controller.signal,
        action === "publish" && profile
          ? { handle: normalizePublicHandle(chosenHandle), profile }
          : undefined,
      );
      if (!mounted.current || controller.signal.aborted) return;
      if (!value || value.published !== (action === "publish"))
        throw new Error("The public page status could not be confirmed. Retry loading its status.");
      setPublication(value);
      setHandle(value.handle);
      setConsentedProfile(null);
      setNotice(
        action === "publish"
          ? "This profile snapshot is published at your stable link. Further edits stay private until you publish an update."
          : "The hosted profile is unpublished. Your handle stays reserved; saved copies and snapshot links remain viewable.",
      );
    } catch (cause) {
      if (!mounted.current) return;
      setError(
        controller.signal.aborted
          ? "The request timed out. Reload the publishing status before retrying."
          : cause instanceof Error
            ? cause.message
            : "The public page could not be updated.",
      );
      // A timed-out write may have reached the server. Refresh before another mutation.
      if (controller.signal.aborted) setReady(false);
    } finally {
      window.clearTimeout(timeout);
      requests.current.delete(controller);
      mutating.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  async function copyLink() {
    setError("");
    setNotice("");
    try {
      await navigator.clipboard.writeText(url);
      if (mounted.current) setNotice("Public page link copied.");
    } catch {
      if (mounted.current)
        setError("Clipboard access is unavailable. Select and copy the public link below.");
    }
  }

  return (
    <section className="profile-publication" aria-labelledby={`${handleId}-heading`}>
      <div className="profile-publication-heading">
        <div>
          <h2 id={`${handleId}-heading`}>
            <Globe2 size={16} /> Your public page
          </h2>
          <p>Keep one link for your profile, links, wishlist, and ways to support you.</p>
        </div>
        <span className="profile-publication-state">
          {loading
            ? "Checking status…"
            : publication?.published
              ? "Published"
              : publication
                ? "Unpublished · handle reserved"
                : "Private draft"}
        </span>
      </div>
      {!available && (
        <p className="profile-publication-hint">
          Sign in to publish a hosted page. Your local draft and snapshot sharing work without an
          account.
        </p>
      )}
      {error && (
        <p className="profile-publication-feedback" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="profile-publication-feedback" role="status">
          <Check size={14} /> {notice}
        </p>
      )}
      <div className="profile-publication-fields">
        <div className="profile-publication-handle">
          <label htmlFor={handleId}>Public handle</label>
          <div className="profile-publication-handle-input">
            <span aria-hidden="true">
              {publication && isReservedRootHandle(publication.handle) ? "/u/" : "/"}
            </span>
            <input
              id={handleId}
              value={chosenHandle}
              onChange={(event) => {
                setHandle(event.target.value.toLowerCase());
                setConsentedProfile(null);
                setNotice("");
              }}
              readOnly={Boolean(publication)}
              disabled={!available || !ready || loading || Boolean(busy)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={32}
              aria-describedby={helpId}
              placeholder="your-name"
            />
          </div>
          <small id={helpId}>
            3–32 lowercase letters, digits, underscores, or hyphens; start and end with a letter or
            digit. This ID creates your shareable page at your-domain.com/your-id. App names such as
            login and inbox are reserved. Your ID stays with your account once published; your
            sign-in username can still use Unicode and symbols.
          </small>
        </div>
        {publication && (
          <div className="profile-publication-link">
            <label htmlFor={`${handleId}-url`}>
              {publication.published ? "Public page link" : "Reserved page link"}
            </label>
            <input
              id={`${handleId}-url`}
              value={url}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
            <div className="profile-publication-link-actions">
              <button type="button" onClick={() => void copyLink()} disabled={!origin}>
                <Copy size={13} /> Copy link
              </button>
              {publication.published && (
                <a href={url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={13} /> Open page
                </a>
              )}
            </div>
          </div>
        )}
      </div>
      <p className="profile-publication-hint">
        Publishing makes the current preview public, including donation addresses and service links.
        Account credentials and wallet keys are not part of the profile. Saving a draft does not
        update this page.
      </p>
      {!profile && (
        <p className="profile-publication-hint">
          Finish or correct the profile fields to publish a complete preview.
        </p>
      )}
      {profile && !validDraft && (
        <p className="profile-publication-hint">Add a display name before publishing.</p>
      )}
      {publication?.published && (
        <p className="profile-publication-hint">
          Last published{" "}
          <time dateTime={publication.updatedAt} title={publication.updatedAt}>
            {formatTransactionDate(new Date(publication.updatedAt).getTime())} UTC
          </time>
          .{" "}
          {unchanged
            ? "The public page matches your current preview."
            : "Your current draft differs from the published snapshot."}
        </p>
      )}
      <label className="profile-publication-consent">
        <input
          type="checkbox"
          checked={consented}
          onChange={(event) => setConsentedProfile(event.target.checked ? fingerprint : null)}
          disabled={
            !available || !ready || loading || Boolean(busy) || !profile || !validDraft || unchanged
          }
        />
        <span>
          I want to publish the current preview and its public links and donation details.
        </span>
      </label>
      <div className="profile-publication-actions">
        <button type="button" onClick={() => void mutate("publish")} disabled={publishDisabled}>
          {busy === "publish" ? (
            <LoaderCircle size={14} className="profile-publication-spin" />
          ) : (
            <Globe2 size={14} />
          )}
          {busy === "publish"
            ? "Publishing…"
            : publication?.published
              ? "Publish update"
              : publication
                ? "Republish page"
                : "Publish public page"}
        </button>
        {publication?.published && (
          <button
            type="button"
            onClick={() => void mutate("unpublish")}
            disabled={!available || !ready || loading || Boolean(busy)}
          >
            {busy === "unpublish" ? "Unpublishing…" : "Unpublish page"}
          </button>
        )}
        {available && (!ready || error) && !loading && (
          <button
            type="button"
            onClick={() => setReload((value) => value + 1)}
            disabled={Boolean(busy)}
          >
            <RefreshCw size={13} /> Reload publishing status
          </button>
        )}
      </div>
      {!publication && isReservedRootHandle(chosenHandle) && (
        <p className="profile-publication-hint">
          This page ID is reserved for the app. Choose another ID.
        </p>
      )}
      {publication && !publication.published && (
        <p className="profile-publication-hint">
          Visitors see an unavailable page at this link until you republish. Unpublishing cannot
          remove other people's saved copies or previously shared snapshot links.
        </p>
      )}
    </section>
  );
}
