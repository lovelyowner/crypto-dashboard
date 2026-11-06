import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Monitor, RefreshCw, ShieldCheck } from "lucide-react";
import { formatTransactionDate } from "@/lib/format";
import "./account-sessions.css";

type ActiveSession = {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string;
};

function readSessions(value: unknown): ActiveSession[] {
  if (!Array.isArray(value))
    throw new Error("The account service returned an invalid session list.");
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("The session list could not be read.");
    const row = entry as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !row.id ||
      typeof row.token !== "string" ||
      !row.token ||
      typeof row.createdAt !== "string" ||
      !Number.isFinite(Date.parse(row.createdAt)) ||
      typeof row.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(row.expiresAt))
    )
      throw new Error("The session list could not be read.");
    return {
      id: row.id,
      token: row.token,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      // Device headers are self-reported. Keep them plain text and bounded.
      userAgent:
        typeof row.userAgent === "string"
          ? row.userAgent.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 512)
          : "",
    };
  });
}

function sessionDate(value: string): string {
  const date = new Date(value);
  return `${formatTransactionDate(date.getTime())} ${date.toISOString().slice(11, 16)} UTC`;
}

function deviceLabel(userAgent: string): string {
  if (!userAgent) return "Unreported device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser or app";
  const platform = /Android/i.test(userAgent)
    ? "Android"
    : /iPhone|iPad/i.test(userAgent)
      ? "iOS"
      : /Windows/i.test(userAgent)
        ? "Windows"
        : /Macintosh|Mac OS X/i.test(userAgent)
          ? "macOS"
          : /Linux/i.test(userAgent)
            ? "Linux"
            : "unreported system";
  return `${browser} on ${platform}`;
}

async function sessionRequest(
  path: string,
  body?: { token?: string },
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`/api/auth/${path}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    ...(body
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new Error(
        "Sign in again before reviewing or signing out other sessions. Your current session may need fresh authentication.",
      );
    throw new Error("Sessions could not be loaded or changed. Please try again.");
  }
  return data;
}

export function AccountSessions({ currentSessionId }: { currentSessionId: string }) {
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const active = useRef(false);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoading(true);
    setError("");
    sessionRequest("list-sessions", undefined, controller.signal)
      .then(readSessions)
      .then((value) => {
        if (current) setSessions(value);
      })
      .catch((cause: unknown) => {
        if (current) {
          setSessions(null);
          setError(cause instanceof Error ? cause.message : "Sessions could not be loaded.");
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [currentSessionId, revision]);

  const others = sessions?.filter((session) => session.id !== currentSessionId) ?? [];
  const change = async (operation: () => Promise<unknown>, message: string) => {
    if (busy || loading) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      if (active.current) {
        setNotice(message);
        setRevision((value) => value + 1);
      }
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : "Sessions could not be changed.");
    } finally {
      if (active.current) setBusy(false);
    }
  };

  return (
    <section className="account-sessions" aria-label="Signed-in sessions">
      <div className="account-section-heading">
        <Monitor size={17} aria-hidden="true" />
        <h3>Signed-in sessions</h3>
        <button
          type="button"
          className="account-text-button account-sessions-refresh"
          disabled={busy || loading}
          onClick={() => {
            setNotice("");
            setRevision((value) => value + 1);
          }}
        >
          <RefreshCw size={13} aria-hidden="true" /> Refresh sessions
        </button>
      </div>
      <p className="account-help">
        Review active account sessions and sign out other browsers or apps. Device details are
        self-reported and do not prove identity. Dates use UTC.
      </p>
      {error && (
        <p className="account-message account-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="account-message account-success" role="status">
          <Check size={14} aria-hidden="true" /> {notice}
        </p>
      )}
      {loading && (
        <p className="account-muted" role="status">
          <LoaderCircle size={15} className="account-spin" aria-hidden="true" /> Loading sessions…
        </p>
      )}
      {!loading && sessions && (
        <>
          <ul className="account-session-list">
            {[...sessions]
              .sort(
                (a, b) =>
                  Number(b.id === currentSessionId) - Number(a.id === currentSessionId) ||
                  Date.parse(b.createdAt) - Date.parse(a.createdAt),
              )
              .map((session) => {
                const isCurrent = session.id === currentSessionId;
                return (
                  <li className="account-session-card" key={session.id}>
                    <div className="account-session-card-heading">
                      <strong>{deviceLabel(session.userAgent)}</strong>
                      {isCurrent ? (
                        <span className="account-badge">Current session</span>
                      ) : (
                        <button
                          type="button"
                          className="account-text-button"
                          disabled={busy || loading}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Sign out the ${deviceLabel(session.userAgent)} session? This browser stays signed in.`,
                              )
                            )
                              void change(
                                () => sessionRequest("revoke-session", { token: session.token }),
                                "The selected session was signed out.",
                              );
                          }}
                        >
                          Sign out session
                        </button>
                      )}
                    </div>
                    <dl>
                      <div>
                        <dt>Signed in</dt>
                        <dd>
                          <time dateTime={session.createdAt}>{sessionDate(session.createdAt)}</time>
                        </dd>
                      </div>
                      <div>
                        <dt>Expires</dt>
                        <dd>
                          <time dateTime={session.expiresAt}>{sessionDate(session.expiresAt)}</time>
                        </dd>
                      </div>
                    </dl>
                    {session.userAgent && (
                      <details>
                        <summary>Reported device details</summary>
                        <p>{session.userAgent}</p>
                      </details>
                    )}
                  </li>
                );
              })}
          </ul>
          {!sessions.length && (
            <p className="account-help">
              No active sessions were returned. Refresh or sign in again.
            </p>
          )}
          <button
            type="button"
            className="account-secondary"
            disabled={busy || loading || !others.length}
            onClick={() => {
              if (
                window.confirm(
                  `Sign out ${others.length} other active session${others.length === 1 ? "" : "s"}? This browser stays signed in.`,
                )
              )
                void change(
                  () => sessionRequest("revoke-other-sessions", {}),
                  "Other sessions were signed out. This browser stays signed in.",
                );
            }}
          >
            Sign out other sessions
          </button>
          <p className="account-help">
            Signing out a session does not delete its local watchlist or encrypted wallet files.
          </p>
        </>
      )}
    </section>
  );
}

export function AccountRecoveryReadiness({
  providerIds,
  emailVerified,
  emailRecoveryConfigured,
  twoFactorEnabled,
}: {
  providerIds: string[];
  emailVerified: boolean;
  emailRecoveryConfigured: boolean | null;
  twoFactorEnabled: boolean;
}) {
  const hasPassword = providerIds.includes("credential");
  const providers = new Set(providerIds.filter((provider) => provider !== "credential")).size;
  return (
    <section className="account-recovery-readiness" aria-label="Independent access readiness">
      <h4>
        <ShieldCheck size={15} aria-hidden="true" /> Independent access
      </h4>
      <p>
        {!providerIds.length
          ? "Checking your sign-in methods. Reopen this panel if they do not appear."
          : hasPassword
            ? "Password sign-in is available independently of social providers."
            : providers > 1
              ? `${providers} social providers are linked. Enrolled passkeys or an independent password can provide another way in.`
              : "One social provider is linked. Enrolled passkeys or an independent password can provide another way in."}
      </p>
      {!emailVerified && (
        <p>
          Your email is not verified. Verify it before linking accounts or adding a password to a
          social account.
        </p>
      )}
      {emailRecoveryConfigured === false && (
        <p>Email reset links are unavailable until email delivery is configured.</p>
      )}
      <p>
        {twoFactorEnabled
          ? "Authenticator protection is on. Keep its backup codes somewhere private; the app cannot check whether you saved them."
          : "Authenticator protection is off. You can enable it after setting an account password."}
      </p>
    </section>
  );
}
