import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  LoaderCircle,
  Mail,
  RefreshCw,
  Send,
} from "lucide-react";
import {
  validateContactText,
  type ContactMessage,
  type ContactThread,
  type InboxFolder,
  type InboxResponse,
} from "@/lib/creator-contact";
import {
  filterInboxMessages,
  inboxMessageActivity,
  inboxMessagePreview,
  inboxMessageUnread,
  parseInboxResponse,
  parseInboxThread,
  sortInboxMessages,
} from "@/lib/contact-inbox";
import { formatTransactionDate } from "@/lib/format";
import { getPublicProfilePath } from "@/lib/profile-url";
import { PaymentProgress } from "./public-profile-contact";
import {
  ConversationModeration,
  ModerationReviewPanel,
  type ModerationReplyState,
} from "./moderation-controls";
import "./creator-inbox.css";

export interface CreatorInboxProps {
  accountKey: string | null;
  accountAvailable: boolean;
  onOpenAccount?: () => void;
}
class InboxError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function date(value: string): string {
  return `${formatTransactionDate(new Date(value).getTime())} ${new Date(value).toISOString().slice(11, 16)} UTC`;
}
function pendingPaymentId(message: ContactMessage): string | null {
  const paymentId = (message as ContactMessage & { paymentId?: unknown }).paymentId;
  return message.paymentStatus === "pending" &&
    message.direction === "sent" &&
    typeof paymentId === "string"
    ? paymentId
    : null;
}

function paymentLabel(status: ContactMessage["paymentStatus"]): string {
  return {
    free: "No payment required",
    unverified: "Payment unverified",
    pending: "Awaiting payment",
    paid: "Payment verified",
  }[status];
}
async function inboxRequest(
  path: string,
  signal: AbortSignal,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(path, {
    method,
    signal,
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const suppliedMessage =
      data &&
      typeof data === "object" &&
      "message" in data &&
      typeof data.message === "string" &&
      data.message.length <= 300
        ? data.message
        : null;
    const message =
      response.status === 401
        ? "Sign in again to open your private messages."
        : response.status === 402
          ? "This creator requires payment for sender replies. Send a paid message from their profile."
          : response.status === 403
            ? "This conversation is unavailable to this account."
            : response.status === 404
              ? "This message is no longer available."
              : response.status === 400 && suppliedMessage
                ? suppliedMessage
                : response.status === 429
                  ? "Too many requests. Please wait a little and try again."
                  : response.status === 503
                    ? "The inbox service is unavailable. Please try again later."
                    : "Messages could not be loaded or changed. Please try again.";
    throw new InboxError(response.status, message);
  }
  return data;
}
function senderLabel(message: ContactMessage): string {
  return message.direction === "sent"
    ? `To @${message.recipientHandle}`
    : message.anonymous
      ? "Anonymous"
      : message.senderName || "Account sender";
}
function unreadFolder(message: ContactMessage): InboxFolder {
  return message.direction === "sent"
    ? "sent"
    : message.kind === "donation"
      ? "donations"
      : "received";
}
function readSnapshot(message: ContactMessage): string {
  return `${message.latestReply?.id ?? "initial"}:${inboxMessageActivity(message)}`;
}
/** A shared pulse keeps reads paused in hidden/offline tabs and is disposed on account change. */
function useInboxRefresh(available: boolean, onRefresh: () => void): boolean {
  const [active, setActive] = useState(false);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  useEffect(() => {
    if (!available) {
      setActive(false);
      return;
    }
    const canRefresh = () => document.visibilityState === "visible" && navigator.onLine !== false;
    const resume = () => {
      const current = canRefresh();
      setActive(current);
      if (current) refreshRef.current();
    };
    setActive(canRefresh());
    const interval = window.setInterval(() => {
      if (canRefresh()) refreshRef.current();
    }, 30_000);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
    };
  }, [available]);
  return active;
}

/** Keep every private response and pending request scoped to the current account. */
export function CreatorInbox(props: CreatorInboxProps) {
  return <InboxWorkspace key={props.accountKey ?? "guest"} {...props} />;
}
function InboxWorkspace({ accountKey, accountAvailable, onOpenAccount }: CreatorInboxProps) {
  const available = accountAvailable && Boolean(accountKey);
  const [folder, setFolder] = useState<InboxFolder>("received");
  const [messages, setMessages] = useState<ContactMessage[]>([]);
  const messagesRef = useRef<ContactMessage[]>([]);
  const readSnapshots = useRef(new Map<string, string>());
  const [unreadCounts, setUnreadCounts] = useState<InboxResponse["unreadCounts"]>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [request, setRequest] = useState<{
    cursor: string | null;
    revision: number;
    background: boolean;
  }>({ cursor: null, revision: 0, background: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState(() => new Map<string, string>());
  const [search, setSearch] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [threadRefresh, setThreadRefresh] = useState(0);
  const [loading, setLoading] = useState(available);
  const loadingRef = useRef(false);
  const loadedOlder = useRef(false);
  const [error, setError] = useState("");
  const [pageNotice, setPageNotice] = useState("");
  const folderId = useId();
  const foldersRef = useRef<HTMLDivElement>(null);
  const visibleMessages = filterInboxMessages(messages, search, unreadOnly);
  const hasFilters = Boolean(search || unreadOnly);
  const active = useInboxRefresh(available, () => {
    if (loadingRef.current) return;
    setRequest((value) => ({ cursor: null, revision: value.revision + 1, background: true }));
  });

  useEffect(() => {
    if (!available || !active) {
      setLoading(false);
      return;
    }
    let current = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    loadingRef.current = true;
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ folder });
    if (request.cursor) query.set("cursor", request.cursor);
    inboxRequest(`/api/inbox?${query}`, controller.signal)
      .then(parseInboxResponse)
      .then((value) => {
        if (!current) return;
        const counts = value.unreadCounts ? { ...value.unreadCounts } : undefined;
        const incoming = value.messages.map((message) => {
          // A slower list response may predate an already displayed, marked-read thread.
          if (
            inboxMessageUnread(message) &&
            readSnapshots.current.get(message.id) === readSnapshot(message)
          ) {
            const bucket = unreadFolder(message);
            if (counts) counts[bucket] = Math.max(0, counts[bucket] - 1);
            return { ...message, unread: false };
          }
          return message;
        });
        let rows = incoming;
        if (request.cursor) {
          const next = new Map(messagesRef.current.map((message) => [message.id, message]));
          for (const message of incoming) next.set(message.id, message);
          rows = sortInboxMessages([...next.values()]);
          loadedOlder.current = true;
        } else {
          if (loadedOlder.current)
            setPageNotice(
              "Refreshed to the latest conversations. Load more messages to browse older conversations again.",
            );
          loadedOlder.current = false;
        }
        messagesRef.current = rows;
        setMessages(rows);
        setUnreadCounts(counts);
        setNextCursor(value.nextCursor);
      })
      .catch((cause: unknown) => {
        if (
          current &&
          cause instanceof InboxError &&
          (cause.status === 401 || cause.status === 403)
        ) {
          setMessages([]);
          messagesRef.current = [];
          setUnreadCounts(undefined);
          setNextCursor(null);
          setSelected(null);
          setDrafts(new Map());
          setSearch("");
          setUnreadOnly(false);
        }
        if (current)
          setError(
            controller.signal.aborted
              ? "The inbox took too long to load. Please try again."
              : cause instanceof Error
                ? cause.message
                : "Messages could not be loaded.",
          );
      })
      .finally(() => {
        clearTimeout(timeout);
        if (current) {
          loadingRef.current = false;
          setLoading(false);
          // Load the selected conversation after the list to avoid stale unread badges.
          setThreadRefresh((value) => value + 1);
        }
      });
    return () => {
      current = false;
      loadingRef.current = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [available, active, folder, request]);

  function changeFolder(value: InboxFolder) {
    if (folder === value) return;
    setFolder(value);
    setRequest((value) => ({ cursor: null, revision: value.revision + 1, background: false }));
    setNextCursor(null);
    setMessages([]);
    messagesRef.current = [];
    loadedOlder.current = false;
    setPageNotice("");
    setSelected(null);
    setSearch("");
    setUnreadOnly(false);
  }
  function refresh() {
    setRequest((value) => ({ cursor: null, revision: value.revision + 1, background: false }));
  }
  function updateDraft(id: string, text: string) {
    setDrafts((previous) => {
      const next = new Map(previous);
      if (text) next.set(id, text);
      else next.delete(id);
      return next;
    });
  }
  function updateRead(message: ContactMessage) {
    const previous = messagesRef.current.find((row) => row.id === message.id);
    if (!inboxMessageUnread(message)) readSnapshots.current.set(message.id, readSnapshot(message));
    const rows = sortInboxMessages(
      messagesRef.current.map((row) => (row.id === message.id ? message : row)),
    );
    messagesRef.current = rows;
    setMessages(rows);
    if (previous && inboxMessageUnread(previous) && !inboxMessageUnread(message)) {
      const bucket = unreadFolder(message);
      setUnreadCounts((counts) =>
        counts ? { ...counts, [bucket]: Math.max(0, counts[bucket] - 1) } : counts,
      );
    }
  }
  if (!available)
    return (
      <section className="creator-inbox creator-inbox-guest">
        <Mail size={26} aria-hidden="true" />
        <h2>Your private inbox</h2>
        <p>
          Sign in to read private direct messages, donation notes, and replies. Reporting a
          conversation shares it with authorized staff.
        </p>
        {onOpenAccount && (
          <button type="button" onClick={onOpenAccount}>
            Sign in to open inbox
          </button>
        )}
      </section>
    );
  return (
    <section className="creator-inbox" aria-label="Private creator inbox">
      <div className="creator-inbox-heading">
        <div>
          <h2>Private inbox</h2>
          <p>
            Messages and donation notes are private. Reporting shares the conversation with
            authorized staff.
          </p>
          <p className="creator-inbox-sync-note">
            Refreshes every 30 seconds while this inbox is visible and online.
          </p>
        </div>
        <button type="button" onClick={refresh} disabled={loading || !active}>
          <RefreshCw size={14} /> Refresh inbox
        </button>
      </div>
      <div
        ref={foldersRef}
        className="creator-inbox-folders"
        role="tablist"
        aria-label="Inbox folders"
        onKeyDown={(event) => {
          const folders: InboxFolder[] = ["received", "sent", "donations"];
          const index = folders.indexOf(folder);
          const next =
            event.key === "ArrowRight"
              ? (index + 1) % 3
              : event.key === "ArrowLeft"
                ? (index + 2) % 3
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 2
                    : null;
          if (next === null) return;
          event.preventDefault();
          changeFolder(folders[next]);
          foldersRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}
      >
        {(
          [
            ["received", "Received"],
            ["sent", "Sent"],
            ["donations", "Donation notes"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${folderId}-${value}`}
            aria-controls={`${folderId}-panel`}
            tabIndex={folder === value ? 0 : -1}
            aria-selected={folder === value}
            aria-label={label}
            aria-describedby={unreadCounts?.[value] ? `${folderId}-${value}-unread` : undefined}
            onClick={() => changeFolder(value)}
          >
            {label}
            {Boolean(unreadCounts?.[value]) && (
              <>
                <span className="creator-inbox-unread-count" aria-hidden="true">
                  {unreadCounts![value]}
                </span>
                <span id={`${folderId}-${value}-unread`} className="creator-inbox-screen-reader">
                  {unreadCounts![value]} unread conversations
                </span>
              </>
            )}
          </button>
        ))}
      </div>
      <div className="creator-inbox-filters" role="search" aria-label="Filter inbox conversations">
        <label className="creator-inbox-search">
          <span className="creator-inbox-screen-reader">Search loaded conversations</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search loaded conversations"
            maxLength={200}
            autoComplete="off"
          />
        </label>
        <label className="creator-inbox-filter-toggle">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(event) => setUnreadOnly(event.target.checked)}
          />
          Unread only
        </label>
        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setUnreadOnly(false);
            }}
          >
            Reset filters
          </button>
        )}
      </div>
      {messages.length > 0 && (
        <p className="creator-inbox-hint" role="status">
          {visibleMessages.length} of {messages.length} loaded conversations. Filters apply to
          loaded messages and latest replies.
          {nextCursor ? " Load more to include older conversations." : ""}
        </p>
      )}
      <div
        className={`creator-inbox-layout ${selected ? "has-conversation" : ""}`}
        role="tabpanel"
        id={`${folderId}-panel`}
        aria-labelledby={`${folderId}-${folder}`}
        tabIndex={0}
      >
        <div
          className="creator-inbox-list"
          aria-label={`${folder === "donations" ? "Donation notes" : folder === "sent" ? "Sent" : "Received"} messages`}
        >
          {error && (
            <div className="creator-inbox-feedback" role="alert">
              {error}
              {onOpenAccount && /Sign in again/.test(error) && (
                <button type="button" onClick={onOpenAccount}>
                  Open account
                </button>
              )}
            </div>
          )}
          {pageNotice && (
            <p className="creator-inbox-hint" role="status">
              {pageNotice}
            </p>
          )}
          {loading && (!request.background || messages.length === 0) && (
            <p className="creator-inbox-loading" role="status">
              <LoaderCircle size={16} className="creator-inbox-spin" /> Loading messages…
            </p>
          )}
          {!loading && !error && messages.length === 0 && (
            <div className="creator-inbox-empty">
              <Mail size={24} />
              <h3>No messages here yet</h3>
              <p>
                {folder === "sent"
                  ? "Messages sent with your account appear here."
                  : folder === "donations"
                    ? "Donation notes sent to your published profile appear here."
                    : "Publish your profile and enable direct messages to receive messages here."}
              </p>
            </div>
          )}
          {!loading && !error && messages.length > 0 && visibleMessages.length === 0 && (
            <div className="creator-inbox-empty">
              <h3>No matching loaded conversations</h3>
              <p>Change or reset your filters{nextCursor ? ", or load more messages" : ""}.</p>
            </div>
          )}
          {visibleMessages.map((message) => (
            <button
              key={message.id}
              type="button"
              className={`creator-inbox-row ${selected === message.id ? "selected" : ""}`}
              onClick={() => setSelected(message.id)}
              aria-label={`Open ${message.kind === "donation" ? "donation note" : "message"} ${senderLabel(message)}${drafts.has(message.id) ? " · Unsaved draft" : ""}`}
              aria-pressed={selected === message.id}
            >
              <span className="creator-inbox-row-top">
                <strong>{senderLabel(message)}</strong>
                <span className="creator-inbox-row-badges">
                  {inboxMessageUnread(message) && (
                    <span className="creator-inbox-unread">Unread</span>
                  )}
                  {drafts.has(message.id) && <span className="creator-inbox-unread">Draft</span>}
                </span>
              </span>
              <span className="creator-inbox-preview">{inboxMessagePreview(message)}</span>
              <span className="creator-inbox-row-bottom">
                <span>
                  {message.kind === "donation" ? "Donation note" : "Direct message"} ·{" "}
                  {paymentLabel(message.paymentStatus)}
                </span>
                <time dateTime={inboxMessageActivity(message)}>
                  {date(inboxMessageActivity(message))}
                </time>
              </span>
              <ChevronRight size={14} className="creator-inbox-row-arrow" aria-hidden="true" />
            </button>
          ))}
          {nextCursor && (
            <button
              type="button"
              className="creator-inbox-more"
              onClick={() =>
                setRequest((value) => ({
                  cursor: nextCursor,
                  revision: value.revision + 1,
                  background: false,
                }))
              }
              disabled={loading || !active}
            >
              Load more messages
            </button>
          )}
        </div>
        {selected ? (
          <Conversation
            key={selected}
            id={selected}
            active={active}
            refreshToken={threadRefresh}
            draft={drafts.get(selected) ?? ""}
            onDraftChange={(text) => updateDraft(selected, text)}
            onBack={() => setSelected(null)}
            onRead={updateRead}
            onOpenAccount={onOpenAccount}
          />
        ) : (
          <div className="creator-inbox-no-selection">
            <Mail size={26} />
            <p>Choose a conversation to read or reply.</p>
          </div>
        )}
      </div>
      <ModerationReviewPanel active={active} onOpenAccount={onOpenAccount} />
    </section>
  );
}

function Conversation({
  id,
  active,
  refreshToken,
  draft,
  onDraftChange,
  onBack,
  onRead,
  onOpenAccount,
}: {
  id: string;
  active: boolean;
  refreshToken: number;
  draft: string;
  onDraftChange: (text: string) => void;
  onBack: () => void;
  onRead: (message: ContactMessage) => void;
  onOpenAccount?: () => void;
}) {
  const [thread, setThread] = useState<ContactThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [paymentRequired, setPaymentRequired] = useState(false);
  const [resumePayment, setResumePayment] = useState(false);
  const [moderationReply, setModerationReply] = useState<ModerationReplyState>("checking");
  const alive = useRef(false);
  const loaded = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pending.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!active || busy) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    let current = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    setLoading(!loaded.current);
    setRefreshing(true);
    setLoadError("");
    inboxRequest(`/api/inbox/${encodeURIComponent(id)}`, controller.signal)
      .then(parseInboxThread)
      .then((value) => {
        if (!current) return;
        if (value.message.id !== id) throw new Error("Unexpected conversation.");
        loaded.current = true;
        setThread(value);
        onReadRef.current(value.message);
      })
      .catch((cause: unknown) => {
        if (
          current &&
          cause instanceof InboxError &&
          (cause.status === 401 || cause.status === 403 || cause.status === 404)
        ) {
          loaded.current = false;
          setThread(null);
        }
        if (current)
          setLoadError(
            controller.signal.aborted
              ? "The conversation took too long to load. Please try again."
              : cause instanceof Error
                ? cause.message
                : "The conversation could not be loaded.",
          );
      })
      .finally(() => {
        clearTimeout(timeout);
        if (current) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      current = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [id, revision, refreshToken, active, busy]);
  async function reply(event: FormEvent) {
    event.preventDefault();
    if (busy || !thread || loading || !active || moderationReply !== "available") return;
    let text: string;
    try {
      text = validateContactText(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check your reply.");
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    pending.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    setPaymentRequired(false);
    try {
      await inboxRequest(
        `/api/inbox/${encodeURIComponent(id)}/replies`,
        controller.signal,
        "POST",
        { text },
      );
      if (!alive.current) return;
      onDraftChange("");
      setNotice("Reply sent.");
      setRevision((value) => value + 1);
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof InboxError && cause.status === 402) setPaymentRequired(true);
      setError(
        controller.signal.aborted
          ? "The reply request timed out. Refresh this conversation before trying again."
          : cause instanceof Error
            ? cause.message
            : "Your reply could not be sent.",
      );
    } finally {
      clearTimeout(timeout);
      if (pending.current === controller) pending.current = null;
      if (alive.current) setBusy(false);
    }
  }
  async function copyConversation() {
    if (!thread) return;
    const creator = `@${thread.message.recipientHandle}`;
    const sender = thread.message.anonymous
      ? "Anonymous"
      : thread.message.senderName || "Account sender";
    const entry = (author: string, createdAt: string, text: string) =>
      `${author} · ${date(createdAt)}\n${text}`;
    const transcript = [
      `Private conversation · ${creator}`,
      entry(sender, thread.message.createdAt, thread.message.text),
      ...thread.replies.map((reply) =>
        entry(reply.fromCreator ? creator : sender, reply.createdAt, reply.text),
      ),
    ].join("\n\n");
    try {
      await navigator.clipboard.writeText(transcript);
      if (alive.current) setNotice("Conversation copied.");
    } catch {
      if (alive.current)
        setError("Clipboard access is unavailable. Select and copy the conversation text below.");
    }
  }
  return (
    <article className="creator-inbox-conversation" aria-label="Private conversation">
      <div className="creator-inbox-conversation-heading">
        <button type="button" onClick={onBack} className="creator-inbox-back">
          <ArrowLeft size={14} /> Messages
        </button>
        <button
          type="button"
          onClick={() => void copyConversation()}
          disabled={!thread || loading || busy}
        >
          <Copy size={13} /> Copy conversation
        </button>
        <button
          type="button"
          onClick={() => setRevision((value) => value + 1)}
          disabled={refreshing || busy || !active}
        >
          <RefreshCw size={13} /> Refresh conversation
        </button>
      </div>
      {(error || loadError) && (
        <p className="creator-inbox-feedback" role="alert">
          {error || loadError}
        </p>
      )}
      {notice && (
        <p className="creator-inbox-feedback" role="status">
          <Check size={14} /> {notice}
        </p>
      )}
      {loading && (
        <p className="creator-inbox-loading" role="status">
          <LoaderCircle size={16} className="creator-inbox-spin" /> Loading conversation…
        </p>
      )}
      {!loading && !thread && (
        <button type="button" onClick={() => setRevision((value) => value + 1)} disabled={!active}>
          Try again
        </button>
      )}
      {thread && (
        <>
          <header className="creator-inbox-thread-summary">
            <h3>{senderLabel(thread.message)}</h3>
            <p>
              {thread.message.kind === "donation" ? "Donation note" : "Direct message"} ·{" "}
              {paymentLabel(thread.message.paymentStatus)}
            </p>
            <a
              href={getPublicProfilePath(thread.message.recipientHandle)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open @{thread.message.recipientHandle} profile
            </a>
          </header>
          <ConversationModeration
            id={id}
            active={active}
            disabled={busy}
            refreshToken={refreshToken + revision}
            onReplyStateChange={setModerationReply}
            onOpenAccount={onOpenAccount}
          />
          <div className="creator-inbox-transcript">
            <div className="creator-inbox-message">
              <div>
                <strong>
                  {thread.message.direction === "sent"
                    ? "You"
                    : thread.message.anonymous
                      ? "Anonymous"
                      : thread.message.senderName || "Account sender"}
                </strong>
                <time dateTime={thread.message.createdAt}>{date(thread.message.createdAt)}</time>
              </div>
              <p>{thread.message.text}</p>
            </div>
            {thread.replies.map((message) => (
              <div
                className={`creator-inbox-message ${message.fromCreator ? "from-creator" : ""}`}
                key={message.id}
              >
                <div>
                  <strong>
                    {thread.message.direction === "received"
                      ? message.fromCreator
                        ? "You"
                        : "Sender"
                      : message.fromCreator
                        ? `@${thread.message.recipientHandle}`
                        : "You"}
                  </strong>
                  <time dateTime={message.createdAt}>{date(message.createdAt)}</time>
                </div>
                <p>{message.text}</p>
              </div>
            ))}
          </div>
          {pendingPaymentId(thread.message) && (
            <div className="creator-inbox-pending-payment">
              <p className="creator-inbox-hint">
                This message is waiting for verified payment and has not been delivered to the
                creator.
              </p>
              {resumePayment ? (
                <PaymentProgress
                  paymentId={pendingPaymentId(thread.message)!}
                  onComplete={() => {
                    setResumePayment(false);
                    setRevision((value) => value + 1);
                  }}
                />
              ) : (
                <button type="button" onClick={() => setResumePayment(true)}>
                  Resume payment
                </button>
              )}
            </div>
          )}
          {thread.message.paymentStatus === "pending" ? (
            <p className="creator-inbox-hint">
              Replying becomes available after payment is confirmed.
            </p>
          ) : thread.message.anonymous ? (
            <p className="creator-inbox-hint">
              Anonymous notes do not identify an account and cannot receive replies.
            </p>
          ) : (
            <form className="creator-inbox-reply" onSubmit={(event) => void reply(event)}>
              <label htmlFor={`reply-${id}`}>Private reply</label>
              <textarea
                id={`reply-${id}`}
                value={draft}
                onChange={(event) => onDraftChange(event.target.value)}
                maxLength={4000}
                rows={4}
                disabled={busy}
                placeholder="Write a private reply…"
              />
              <span className="creator-inbox-hint">
                {[...draft].length}/2000 characters · Plain text. Reporting shares this conversation
                with authorized staff.
              </span>
              <span className="creator-inbox-hint">
                Drafts stay in this open inbox. Leaving the inbox, reloading, or signing out clears
                them.
              </span>
              {moderationReply !== "available" && (
                <span className="creator-inbox-hint" role="status">
                  {moderationReply === "blocked"
                    ? "You blocked this account. Unblock it in Safety controls to reply. Your draft is kept."
                    : moderationReply === "checking"
                      ? "Checking whether replies are available…"
                      : "Replies are unavailable until Safety controls can be checked. Refresh Safety controls to try again."}
                </span>
              )}
              <div className="creator-inbox-reply-actions">
                <button
                  type="submit"
                  disabled={
                    busy ||
                    loading ||
                    !active ||
                    moderationReply !== "available" ||
                    !draft.trim() ||
                    [...draft].length > 2000
                  }
                >
                  <Send size={14} />
                  {busy ? "Sending…" : "Send reply"}
                </button>
                {draft && (
                  <button type="button" disabled={busy} onClick={() => onDraftChange("")}>
                    Discard draft
                  </button>
                )}
              </div>
            </form>
          )}
          {paymentRequired && (
            <a
              className="creator-inbox-paid-link"
              href={getPublicProfilePath(thread.message.recipientHandle)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open creator page to send a paid message
            </a>
          )}
        </>
      )}
    </article>
  );
}
