import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Flag, LoaderCircle, Shield, UserRoundX } from "lucide-react";
import "./moderation-controls.css";

type ModerationState = {
  canBlock: boolean;
  blocked: boolean;
  canReport: boolean;
  reported: boolean;
};
export type ModerationReplyState = "checking" | "available" | "blocked" | "unavailable";
type ReportReason = "spam" | "harassment" | "scam" | "other";
type ReportStatus = "open" | "reviewed" | "dismissed";
const reasons: Record<ReportReason, string> = {
  spam: "Spam",
  harassment: "Harassment",
  scam: "Scam",
  other: "Other",
};
class ModerationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function request(
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
    throw new ModerationError(
      response.status,
      response.status === 401
        ? "Sign in again to use safety controls."
        : response.status === 403
          ? "This action is unavailable to this account."
          : response.status === 404
            ? "This conversation or report is no longer available."
            : response.status === 400
              ? "Check the selected reason and keep report details within 1000 characters."
              : response.status === 429
                ? "Too many requests. Please wait a little and try again."
                : "Safety controls are unavailable. Please try again.",
    );
  }
  return data;
}
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function parseState(value: unknown): ModerationState {
  if (
    !object(value) ||
    typeof value.canBlock !== "boolean" ||
    typeof value.blocked !== "boolean" ||
    typeof value.canReport !== "boolean" ||
    typeof value.reported !== "boolean"
  )
    throw new Error("Safety controls could not be checked. Please try again.");
  return {
    canBlock: value.canBlock,
    blocked: value.blocked,
    canReport: value.canReport,
    reported: value.reported,
  };
}
function failure(cause: unknown, signal: AbortSignal): string {
  return signal.aborted
    ? "The request timed out. Refresh safety controls before trying again."
    : cause instanceof Error
      ? cause.message
      : "Safety controls are unavailable. Please try again.";
}

export function ConversationModeration({
  id,
  active,
  disabled,
  refreshToken,
  onReplyStateChange,
  onOpenAccount,
}: {
  id: string;
  active: boolean;
  disabled: boolean;
  refreshToken: number;
  onReplyStateChange: (state: ModerationReplyState) => void;
  onOpenAccount?: () => void;
}) {
  const [state, setState] = useState<ModerationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason>("spam");
  const [details, setDetails] = useState("");
  const [error, setError] = useState("");
  const [reauthenticate, setReauthenticate] = useState(false);
  const [notice, setNotice] = useState("");
  const alive = useRef(false);
  const busyRef = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const onReplyStateRef = useRef(onReplyStateChange);
  onReplyStateRef.current = onReplyStateChange;
  const formId = useId();
  const path = `/api/inbox/${encodeURIComponent(id)}`;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pending.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!active || busyRef.current) return;
    let current = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setLoading(true);
    setError("");
    setReauthenticate(false);
    onReplyStateRef.current("checking");
    request(`${path}/moderation`, controller.signal)
      .then(parseState)
      .then((value) => {
        if (!current) return;
        setState(value);
        onReplyStateRef.current(value.blocked ? "blocked" : "available");
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setState(null);
        onReplyStateRef.current("unavailable");
        setReauthenticate(cause instanceof ModerationError && cause.status === 401);
        setError(failure(cause, controller.signal));
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [active, path, refreshToken, revision]);

  async function mutate(action: "block" | "report") {
    if (!state || busyRef.current || disabled || loading || !active) return;
    if (action === "block" && !state.canBlock) return;
    if (action === "report" && (!state.canReport || state.reported)) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    pending.current = controller;
    busyRef.current = true;
    setBusy(true);
    onReplyStateRef.current("checking");
    setError("");
    setNotice("");
    setReauthenticate(false);
    try {
      const value = await request(
        action === "block" ? `${path}/moderation` : `${path}/reports`,
        controller.signal,
        action === "block" ? "PUT" : "POST",
        action === "block" ? { blocked: !state.blocked } : { reason, details: details.trim() },
      );
      if (!alive.current) return;
      const next =
        action === "block"
          ? parseState(value)
          : object(value) && value.reported === true
            ? { ...state, reported: true }
            : null;
      if (!next) throw new Error("The report response could not be confirmed. Refresh to check.");
      setState(next);
      onReplyStateRef.current(next.blocked ? "blocked" : "available");
      setConfirmBlock(false);
      setReportOpen(false);
      setNotice(
        action === "report"
          ? "Report saved."
          : next.blocked
            ? "Account blocked."
            : "Account unblocked.",
      );
    } catch (cause) {
      if (!alive.current) return;
      setState(null);
      onReplyStateRef.current("unavailable");
      setReauthenticate(cause instanceof ModerationError && cause.status === 401);
      setError(failure(cause, controller.signal));
    } finally {
      window.clearTimeout(timeout);
      if (pending.current === controller) pending.current = null;
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function report(event: FormEvent) {
    event.preventDefault();
    if ([...details].length > 1000) return;
    void mutate("report");
  }
  const locked = busy || disabled || loading || !active;
  return (
    <details className="conversation-moderation">
      <summary>
        <Shield size={13} aria-hidden="true" /> Safety controls
      </summary>
      <div className="conversation-moderation-content">
        <p>
          Blocking stops new contact between your accounts. Existing pending payments may still
          complete. Blocking does not issue a refund.
        </p>
        {loading && (
          <p role="status">
            <LoaderCircle size={13} className="creator-inbox-spin" aria-hidden="true" /> Checking
            safety controls…
          </p>
        )}
        {error && (
          <div className="creator-inbox-feedback" role="alert">
            {error}
            {reauthenticate && onOpenAccount && (
              <button type="button" onClick={onOpenAccount}>
                Open account
              </button>
            )}
            <button
              type="button"
              disabled={locked}
              onClick={() => setRevision((value) => value + 1)}
            >
              Refresh safety controls
            </button>
          </div>
        )}
        {notice && (
          <p className="creator-inbox-feedback" role="status">
            {notice}
          </p>
        )}
        {state && (
          <>
            {state.blocked && (
              <p>You blocked this account. Existing messages stay available to read and copy.</p>
            )}
            {!state.canBlock && (
              <p>
                This conversation has no other account available to block. Anonymous notes do not
                identify an account to block.
              </p>
            )}
            <div className="conversation-moderation-actions">
              {state.canBlock && (
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => {
                    setConfirmBlock(true);
                    setReportOpen(false);
                  }}
                >
                  <UserRoundX size={13} aria-hidden="true" />{" "}
                  {state.blocked ? "Unblock account" : "Block account"}
                </button>
              )}
              {state.canReport && (
                <button
                  type="button"
                  disabled={locked || state.reported}
                  onClick={() => {
                    setReportOpen(true);
                    setConfirmBlock(false);
                  }}
                >
                  <Flag size={13} aria-hidden="true" />{" "}
                  {state.reported ? "Report saved" : "Report conversation"}
                </button>
              )}
            </div>
            {confirmBlock && (
              <div className="conversation-moderation-confirm">
                <h4>{state.blocked ? "Unblock this account?" : "Block this account?"}</h4>
                <p>
                  {state.blocked
                    ? "This allows new contact between your accounts again."
                    : "You will not be able to send new messages or replies to each other. Your unsent reply draft will be kept in this open inbox."}
                </p>
                <p>
                  Existing pending payments may still complete. No refund is issued automatically.
                </p>
                <div className="conversation-moderation-actions">
                  <button type="button" disabled={locked} onClick={() => void mutate("block")}>
                    {busy ? "Saving…" : state.blocked ? "Confirm unblock" : "Confirm block"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirmBlock(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {reportOpen && !state.reported && (
              <form className="conversation-moderation-report" onSubmit={report}>
                <label htmlFor={`${formId}-reason`}>Report reason</label>
                <select
                  id={`${formId}-reason`}
                  value={reason}
                  disabled={locked}
                  onChange={(event) => setReason(event.target.value as ReportReason)}
                >
                  {Object.entries(reasons).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <label htmlFor={`${formId}-details`}>Details (optional)</label>
                <textarea
                  id={`${formId}-details`}
                  rows={3}
                  maxLength={2000}
                  value={details}
                  disabled={locked}
                  onChange={(event) => setDetails(event.target.value)}
                />
                <p>
                  {[...details].length}/1000 characters. Saving a report shares this message, its
                  current replies, and these details with authorized staff.
                </p>
                <div className="conversation-moderation-actions">
                  <button type="submit" disabled={locked || [...details].length > 1000}>
                    {busy ? "Saving…" : "Save report"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setReportOpen(false)}>
                    Cancel report
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </details>
  );
}

type ReviewReport = {
  id: string;
  reason: ReportReason;
  details: string;
  status: ReportStatus;
  createdAt: string;
  message: { text: string; kind: "dm" | "donation"; anonymous: boolean };
  replies: { text: string; fromCreator: boolean; createdAt: string }[];
};
function validDate(value: unknown): value is string {
  return typeof value === "string" && value.length < 50 && Number.isFinite(Date.parse(value));
}
function parseReports(value: unknown): ReviewReport[] {
  if (!object(value) || !Array.isArray(value.reports) || value.reports.length > 50)
    throw new Error("Reports could not be read. Please refresh.");
  return value.reports.map((row: unknown) => {
    if (
      !object(row) ||
      typeof row.id !== "string" ||
      !row.id ||
      row.id.length > 100 ||
      typeof row.reason !== "string" ||
      !Object.hasOwn(reasons, row.reason) ||
      typeof row.details !== "string" ||
      [...row.details].length > 1000 ||
      !["open", "reviewed", "dismissed"].includes(String(row.status)) ||
      !validDate(row.createdAt) ||
      !object(row.message) ||
      typeof row.message.text !== "string" ||
      [...row.message.text].length > 2000 ||
      !["dm", "donation"].includes(String(row.message.kind)) ||
      typeof row.message.anonymous !== "boolean" ||
      !Array.isArray(row.replies) ||
      row.replies.length > 1000
    )
      throw new Error("Reports could not be read. Please refresh.");
    const replies = row.replies.map((reply: unknown) => {
      if (
        !object(reply) ||
        typeof reply.text !== "string" ||
        [...reply.text].length > 2000 ||
        typeof reply.fromCreator !== "boolean" ||
        !validDate(reply.createdAt)
      )
        throw new Error("Reports could not be read. Please refresh.");
      return { text: reply.text, fromCreator: reply.fromCreator, createdAt: reply.createdAt };
    });
    return {
      id: row.id,
      reason: row.reason as ReportReason,
      details: row.details,
      status: row.status as ReportStatus,
      createdAt: row.createdAt,
      message: {
        text: row.message.text,
        kind: row.message.kind as "dm" | "donation",
        anonymous: row.message.anonymous,
      },
      replies,
    };
  });
}

export function ModerationReviewPanel({
  active,
  onOpenAccount,
}: {
  active: boolean;
  onOpenAccount?: () => void;
}) {
  const [canReview, setCanReview] = useState(false);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ReportStatus>("open");
  const [reports, setReports] = useState<ReviewReport[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reauthenticate, setReauthenticate] = useState(false);
  const [notice, setNotice] = useState("");
  const alive = useRef(false);
  const busyRef = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const filterId = useId();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pending.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    let current = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    request("/api/moderation/access", controller.signal)
      .then((value) => {
        if (current) setCanReview(object(value) && value.canReview === true);
      })
      .catch(() => {
        if (current) {
          setCanReview(false);
          setReports([]);
        }
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      current = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [active]);
  useEffect(() => {
    if (!active || !canReview || !open || busyRef.current) return;
    let current = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setLoading(true);
    setError("");
    setReauthenticate(false);
    setReports([]);
    request(`/api/moderation/reports?status=${status}`, controller.signal)
      .then(parseReports)
      .then((value) => {
        if (current) setReports(value);
      })
      .catch((cause: unknown) => {
        if (!current) return;
        if (cause instanceof ModerationError && cause.status === 403) setCanReview(false);
        setReauthenticate(cause instanceof ModerationError && cause.status === 401);
        setError(failure(cause, controller.signal));
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [active, canReview, open, revision, status]);
  async function review(id: string, nextStatus: "reviewed" | "dismissed") {
    if (!active || busyRef.current || loading) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    pending.current = controller;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await request(
        `/api/moderation/reports/${encodeURIComponent(id)}`,
        controller.signal,
        "PATCH",
        { status: nextStatus },
      );
      if (!alive.current) return;
      if (!object(value) || value.updated !== true)
        throw new Error("The status update could not be confirmed. Refresh reports to check.");
      setNotice(nextStatus === "reviewed" ? "Report marked reviewed." : "Report dismissed.");
      setRevision((value) => value + 1);
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof ModerationError && cause.status === 403) {
        setCanReview(false);
        setReports([]);
      }
      if (cause instanceof ModerationError && cause.status === 401) {
        setReauthenticate(true);
        setReports([]);
      }
      setError(failure(cause, controller.signal));
    } finally {
      window.clearTimeout(timeout);
      if (pending.current === controller) pending.current = null;
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }
  if (!canReview) return null;
  return (
    <details
      className="moderation-review-panel"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <Shield size={14} aria-hidden="true" /> Staff moderation
      </summary>
      <div className="moderation-review-content">
        <h3>Private staff review</h3>
        <p>
          Your account has permission to review reported conversations. Report contents are private
          staff information.
        </p>
        <div className="conversation-moderation-actions">
          <label htmlFor={filterId}>Report status</label>
          <select
            id={filterId}
            value={status}
            disabled={busy || loading}
            onChange={(event) => {
              setStatus(event.target.value as ReportStatus);
              setNotice("");
            }}
          >
            <option value="open">Open</option>
            <option value="reviewed">Reviewed</option>
            <option value="dismissed">Dismissed</option>
          </select>
          <button
            type="button"
            disabled={busy || loading || !active}
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh reports
          </button>
        </div>
        <p>
          Showing up to 50 newest reports with this status. Changing a report status does not block
          an account or issue a refund.
        </p>
        {error && (
          <div className="creator-inbox-feedback" role="alert">
            {error}
            {reauthenticate && onOpenAccount && (
              <button type="button" onClick={onOpenAccount}>
                Open account
              </button>
            )}
          </div>
        )}
        {notice && (
          <p className="creator-inbox-feedback" role="status">
            {notice}
          </p>
        )}
        {loading && <p role="status">Loading reports…</p>}
        {!loading && !error && reports.length === 0 && <p>No {status} reports.</p>}
        {reports.map((item) => (
          <article className="moderation-review-report" key={item.id}>
            <h4>
              {reasons[item.reason]} · {item.status}
            </h4>
            <p>
              Reported{" "}
              <time dateTime={item.createdAt}>
                {new Date(item.createdAt).toLocaleString(undefined, { timeZone: "UTC" })} UTC
              </time>
            </p>
            {item.details && (
              <>
                <h5>Report details</h5>
                <p className="moderation-review-text">{item.details}</p>
              </>
            )}
            <details>
              <summary>Reported conversation</summary>
              <h5>
                {item.message.anonymous ? "Anonymous " : ""}
                {item.message.kind === "donation" ? "Donation note" : "Direct message"}
              </h5>
              <p className="moderation-review-text">{item.message.text}</p>
              {item.replies.map((reply, index) => (
                <div className="moderation-review-reply" key={`${reply.createdAt}-${index}`}>
                  <h5>{reply.fromCreator ? "Creator reply" : "Sender reply"}</h5>
                  <p className="moderation-review-text">{reply.text}</p>
                </div>
              ))}
            </details>
            <div className="conversation-moderation-actions">
              <button
                type="button"
                disabled={busy || loading || !active || item.status === "reviewed"}
                onClick={() => void review(item.id, "reviewed")}
              >
                Mark reviewed
              </button>
              <button
                type="button"
                disabled={busy || loading || !active || item.status === "dismissed"}
                onClick={() => void review(item.id, "dismissed")}
              >
                Dismiss report
              </button>
            </div>
          </article>
        ))}
      </div>
    </details>
  );
}
