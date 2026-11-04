import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Check, ChevronRight, LoaderCircle, Mail, RefreshCw, Send } from "lucide-react";
import {
  validateContactText,
  type ContactMessage,
  type ContactReply,
  type ContactThread,
  type InboxFolder,
  type InboxResponse,
} from "@/lib/creator-contact";
import { formatTransactionDate } from "@/lib/format";
import { normalizePublicHandle } from "@/lib/public-profile";
import { getPublicProfilePath } from "@/lib/profile-url";
import { PaymentProgress } from "./public-profile-contact";
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
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The inbox response could not be read.");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    throw new Error("The inbox response could not be read.");
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("The message date could not be read.");
  return new Date(value).toISOString();
}
function parseMessage(value: unknown): ContactMessage {
  const row = record(value);
  if (
    !["dm", "donation"].includes(row.kind as string) ||
    typeof row.anonymous !== "boolean" ||
    typeof row.senderName !== "string" ||
    row.senderName.length > 320 ||
    !["free", "unverified", "pending", "paid"].includes(row.paymentStatus as string) ||
    !["received", "sent"].includes(row.direction as string)
  )
    throw new Error("The inbox response could not be read.");
  return {
    id: identifier(row.id),
    kind: row.kind as ContactMessage["kind"],
    text: validateContactText(row.text),
    anonymous: row.anonymous,
    senderName: row.anonymous
      ? "Anonymous"
      : row.senderName.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 160),
    recipientHandle: normalizePublicHandle(row.recipientHandle),
    createdAt: timestamp(row.createdAt),
    paymentStatus: row.paymentStatus as ContactMessage["paymentStatus"],
    direction: row.direction as ContactMessage["direction"],
    readAt: row.readAt === null ? null : timestamp(row.readAt),
    ...(row.paymentStatus === "pending" && row.direction === "sent" && row.paymentId != null
      ? { paymentId: identifier(row.paymentId) }
      : {}),
  };
}
function parseInbox(value: unknown): InboxResponse {
  const row = record(value);
  if (
    !Array.isArray(row.messages) ||
    row.messages.length > 50 ||
    (row.nextCursor !== null &&
      (typeof row.nextCursor !== "string" || !row.nextCursor || row.nextCursor.length > 512))
  )
    throw new Error("The inbox response could not be read.");
  return { messages: row.messages.map(parseMessage), nextCursor: row.nextCursor as string | null };
}
function parseThread(value: unknown): ContactThread {
  const row = record(value);
  if (!Array.isArray(row.replies) || row.replies.length > 500)
    throw new Error("The conversation could not be read.");
  return {
    message: parseMessage(row.message),
    replies: row.replies.map((value): ContactReply => {
      const reply = record(value);
      if (typeof reply.fromCreator !== "boolean")
        throw new Error("The conversation could not be read.");
      return {
        id: identifier(reply.id),
        text: validateContactText(reply.text),
        createdAt: timestamp(reply.createdAt),
        fromCreator: reply.fromCreator,
      };
    }),
  };
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

/** Keep every private response and pending request scoped to the current account. */
export function CreatorInbox(props: CreatorInboxProps) {
  return <InboxWorkspace key={props.accountKey ?? "guest"} {...props} />;
}
function InboxWorkspace({ accountKey, accountAvailable, onOpenAccount }: CreatorInboxProps) {
  const available = accountAvailable && Boolean(accountKey);
  const [folder, setFolder] = useState<InboxFolder>("received");
  const [messages, setMessages] = useState<ContactMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(available);
  const [error, setError] = useState("");
  const folderId = useId();
  const foldersRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!available) return;
    let current = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ folder });
    if (cursor) query.set("cursor", cursor);
    inboxRequest(`/api/inbox?${query}`, controller.signal)
      .then(parseInbox)
      .then((value) => {
        if (!current) return;
        setMessages((previous) => {
          if (!cursor) return value.messages;
          const seen = new Set(previous.map((row) => row.id));
          return [...previous, ...value.messages.filter((row) => !seen.has(row.id))];
        });
        setNextCursor(value.nextCursor);
      })
      .catch((cause: unknown) => {
        if (
          current &&
          cause instanceof InboxError &&
          (cause.status === 401 || cause.status === 403)
        ) {
          setMessages([]);
          setNextCursor(null);
          setSelected(null);
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
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [available, folder, cursor, revision]);

  function changeFolder(value: InboxFolder) {
    if (folder === value) return;
    setFolder(value);
    setCursor(null);
    setNextCursor(null);
    setMessages([]);
    setSelected(null);
  }
  function refresh() {
    setCursor(null);
    setRevision((value) => value + 1);
  }
  if (!available)
    return (
      <section className="creator-inbox creator-inbox-guest">
        <Mail size={26} aria-hidden="true" />
        <h2>Your private inbox</h2>
        <p>
          Sign in to read direct messages, donation notes, and replies. Messages are available only
          to their participants.
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
          <p>Messages and donation notes are visible only to their participants.</p>
        </div>
        <button type="button" onClick={refresh} disabled={loading}>
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
            onClick={() => changeFolder(value)}
          >
            {label}
          </button>
        ))}
      </div>
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
          {loading && (
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
          {messages.map((message) => (
            <button
              key={message.id}
              type="button"
              className={`creator-inbox-row ${selected === message.id ? "selected" : ""}`}
              onClick={() => setSelected(message.id)}
              aria-label={`Open ${message.kind === "donation" ? "donation note" : "message"} ${senderLabel(message)}`}
              aria-pressed={selected === message.id}
            >
              <span className="creator-inbox-row-top">
                <strong>{senderLabel(message)}</strong>
                {message.direction === "received" && !message.readAt && (
                  <span className="creator-inbox-unread">Unread</span>
                )}
              </span>
              <span className="creator-inbox-preview">
                {message.text.replace(/\s+/gu, " ").slice(0, 170)}
              </span>
              <span className="creator-inbox-row-bottom">
                <span>
                  {message.kind === "donation" ? "Donation note" : "Direct message"} ·{" "}
                  {paymentLabel(message.paymentStatus)}
                </span>
                <time dateTime={message.createdAt}>{date(message.createdAt)}</time>
              </span>
              <ChevronRight size={14} className="creator-inbox-row-arrow" aria-hidden="true" />
            </button>
          ))}
          {nextCursor && (
            <button
              type="button"
              className="creator-inbox-more"
              onClick={() => setCursor(nextCursor)}
              disabled={loading}
            >
              Load more messages
            </button>
          )}
        </div>
        {selected ? (
          <Conversation
            key={selected}
            id={selected}
            onBack={() => setSelected(null)}
            onRead={(message) =>
              setMessages((rows) => rows.map((row) => (row.id === message.id ? message : row)))
            }
          />
        ) : (
          <div className="creator-inbox-no-selection">
            <Mail size={26} />
            <p>Choose a conversation to read or reply.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function Conversation({
  id,
  onBack,
  onRead,
}: {
  id: string;
  onBack: () => void;
  onRead: (message: ContactMessage) => void;
}) {
  const [thread, setThread] = useState<ContactThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [paymentRequired, setPaymentRequired] = useState(false);
  const [resumePayment, setResumePayment] = useState(false);
  const alive = useRef(false);
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
    let current = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    setLoading(true);
    setError("");
    inboxRequest(`/api/inbox/${encodeURIComponent(id)}`, controller.signal)
      .then(parseThread)
      .then((value) => {
        if (!current) return;
        if (value.message.id !== id) throw new Error("Unexpected conversation.");
        setThread(value);
        onReadRef.current(value.message);
      })
      .catch((cause: unknown) => {
        if (
          current &&
          cause instanceof InboxError &&
          (cause.status === 401 || cause.status === 403 || cause.status === 404)
        )
          setThread(null);
        if (current)
          setError(
            controller.signal.aborted
              ? "The conversation took too long to load. Please try again."
              : cause instanceof Error
                ? cause.message
                : "The conversation could not be loaded.",
          );
      })
      .finally(() => {
        clearTimeout(timeout);
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [id, revision]);
  async function reply(event: FormEvent) {
    event.preventDefault();
    if (busy || !thread || loading) return;
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
      setDraft("");
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
  return (
    <article className="creator-inbox-conversation" aria-label="Private conversation">
      <div className="creator-inbox-conversation-heading">
        <button type="button" onClick={onBack} className="creator-inbox-back">
          <ArrowLeft size={14} /> Messages
        </button>
        <button
          type="button"
          onClick={() => setRevision((value) => value + 1)}
          disabled={loading || busy}
        >
          <RefreshCw size={13} /> Refresh conversation
        </button>
      </div>
      {error && (
        <p className="creator-inbox-feedback" role="alert">
          {error}
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
        <button type="button" onClick={() => setRevision((value) => value + 1)}>
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
                onChange={(event) => setDraft(event.target.value)}
                maxLength={4000}
                rows={4}
                disabled={busy}
                placeholder="Write a private reply…"
              />
              <span className="creator-inbox-hint">
                {[...draft].length}/2000 characters · Plain text, visible only to this
                conversation's participants.
              </span>
              <button
                type="submit"
                disabled={busy || loading || !draft.trim() || [...draft].length > 2000}
              >
                <Send size={14} />
                {busy ? "Sending…" : "Send reply"}
              </button>
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
