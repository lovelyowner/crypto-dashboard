import { useEffect, useState, type FormEvent } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  LoaderCircle,
  LogOut,
  ShieldCheck,
} from "lucide-react";
import { authClient, SOCIAL_PROVIDERS } from "@/lib/auth/client";
import {
  isValidUsername,
  normalizeUsername,
  DEFAULT_SESSION_DURATION,
  SESSION_DURATION_HEADER,
  SESSION_DURATION_OPTIONS,
  type SessionDuration,
} from "@/lib/auth/policy";
import { AccountRecoveryReadiness, AccountSessions } from "./account-sessions";
import { safeAccountReturnPath } from "@/lib/auth/return-to";
import "./account.css";

type Configuration = {
  configured: boolean;
  emailRecovery: boolean;
  providers: Record<string, boolean>;
  production: boolean;
};
type LinkedAccount = { id: string; providerId: string; accountId: string };
type Setup = { totpURI: string; backupCodes: string[] };

async function request<T>(
  path: string,
  body?: Record<string, unknown>,
  duration?: SessionDuration,
): Promise<T> {
  const response = await fetch(`/api/auth/${path}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    headers: body
      ? {
          "content-type": "application/json",
          ...(duration ? { [SESSION_DURATION_HEADER]: duration } : {}),
        }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "The request failed. Please retry.");
  return result as T;
}

export function AccountPanel({ onClose }: { onClose: () => void }) {
  const { data: session, isPending, refetch } = authClient.useSession();
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [configurationError, setConfigurationError] = useState("");
  const [mode, setMode] = useState<"login" | "signup" | "recover" | "reset">("login");
  const [identifierKind, setIdentifierKind] = useState<"email" | "username">("email");
  const [identifier, setIdentifier] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [sessionDuration, setSessionDuration] = useState<SessionDuration>(DEFAULT_SESSION_DURATION);
  const [challenge, setChallenge] = useState(false);
  const [backupMode, setBackupMode] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [newPassword, setNewPassword] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const user = session?.user;
  const twoFactorEnabled = Boolean(user?.twoFactorEnabled);

  useEffect(() => {
    let active = true;
    request<Configuration>("config")
      .then((value) => {
        if (active) setConfiguration(value);
      })
      .catch(() => {
        if (active)
          setConfigurationError(
            "Account service unavailable. Watching addresses and local wallets still work.",
          );
      });
    const params = new URLSearchParams(window.location.search);
    setReturnTo(safeAccountReturnPath(params.get("next")));
    const token = params.get("token");
    if (params.get("reset") && token) {
      setResetToken(token);
      setMode("reset");
    }
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (user?.id && returnTo && mode !== "reset" && !challenge) window.location.assign(returnTo);
  }, [user?.id, returnTo, mode, challenge]);

  useEffect(() => {
    if (!user?.id) {
      setAccounts([]);
      return;
    }
    let active = true;
    request<LinkedAccount[]>("list-accounts")
      .then((value) => {
        if (active) setAccounts(value);
      })
      .catch(() => {
        if (active) setError("Could not load linked accounts. Retry by reopening this panel.");
      });
    return () => {
      active = false;
    };
  }, [user?.id]);

  const run = async (operation: () => Promise<void>) => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (challenge) {
        await request(backupMode ? "two-factor/verify-backup-code" : "two-factor/verify-totp", {
          code,
          trustDevice: false,
        });
        setChallenge(false);
        setCode("");
        await refetch();
        setNotice("Signed in. Your second factor was verified.");
        return;
      }
      if (mode === "recover") {
        const redirect = new URL("/login?reset=1", window.location.origin);
        if (returnTo) redirect.searchParams.set("next", returnTo);
        await request("request-password-reset", { email, redirectTo: redirect.href });
        setNotice("If an account exists for that email, a reset link has been sent.");
        return;
      }
      if (mode === "reset") {
        await request("reset-password", { newPassword: password, token: resetToken });
        setResetToken("");
        setPassword("");
        setMode("login");
        window.history.replaceState(null, "", window.location.pathname);
        setNotice("Password reset. Sign in with your new password.");
        return;
      }
      if (mode === "signup") {
        if (!isValidUsername(username))
          throw new Error(
            "Use 1–64 characters. Symbols, spaces, and Unicode are welcome; remove surrounding whitespace or invisible/control characters.",
          );
        await request(
          "sign-up/email",
          {
            email,
            password,
            name: username,
            username: normalizeUsername(username),
            displayUsername: normalizeUsername(username),
            rememberMe,
          },
          sessionDuration,
        );
        setPassword("");
        await refetch();
        setNotice("Account created. Add a second factor and another sign-in method below.");
        return;
      }
      const response = await request<{ twoFactorRedirect?: boolean }>(
        identifierKind === "username" ? "sign-in/username" : "sign-in/email",
        {
          [identifierKind]:
            identifierKind === "username" ? normalizeUsername(identifier) : identifier,
          password,
          rememberMe,
        },
        sessionDuration,
      );
      setPassword("");
      if (response.twoFactorRedirect) {
        setChallenge(true);
        return;
      }
      await refetch();
      setNotice("Signed in.");
    });
  };

  const connect = (provider: string, linking: boolean) =>
    void run(async () => {
      const result = linking
        ? await authClient.linkSocial({
            provider: provider as "google" | "discord" | "twitter",
            callbackURL: returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : "/login",
          })
        : await authClient.signIn.social({
            provider: provider as "google" | "discord" | "twitter",
            callbackURL: returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : "/login",
            fetchOptions: { headers: { [SESSION_DURATION_HEADER]: sessionDuration } },
          });
      if (result.error)
        throw new Error(result.error.message || "Could not start provider sign-in.");
    });

  const providerButtons = (linking: boolean) => (
    <div className="account-providers">
      {SOCIAL_PROVIDERS.map((provider) => {
        const connected = accounts.some((account) => account.providerId === provider.providerId);
        const available = Boolean(
          configuration?.configured && configuration.providers[provider.providerId],
        );
        return (
          <button
            className="account-provider"
            type="button"
            key={provider.providerId}
            disabled={busy || !available || (linking && connected)}
            onClick={() => connect(provider.providerId, linking)}
            title={
              available
                ? provider.label
                : provider.supported
                  ? "Requires this provider's OAuth credentials on the server"
                  : provider.requirement
            }
          >
            <span className="account-provider-mark" aria-hidden="true">
              {provider.mark}
            </span>
            <span>
              {provider.label}
              <small>
                {connected
                  ? "Connected"
                  : available
                    ? linking
                      ? "Connect account"
                      : "Continue"
                    : provider.supported
                      ? "Setup required"
                      : "Not integrated"}
              </small>
            </span>
            {connected && <Check size={15} />}
          </button>
        );
      })}
    </div>
  );

  return (
    <section className="account-panel">
      <div className="account-heading">
        <div className="account-icon">
          <ShieldCheck size={23} />
        </div>
        <div>
          <p className="account-eyebrow">YOUR ACCOUNT</p>
          <h2>
            {user
              ? "Account & security"
              : challenge
                ? "Verify it’s you"
                : mode === "signup"
                  ? "Create your account"
                  : mode === "recover" || mode === "reset"
                    ? "Recover access"
                    : "Welcome back"}
          </h2>
        </div>
      </div>
      <p className="account-intro">
        {user
          ? "Keep independent ways to sign in, so losing a social account doesn’t lock you out."
          : "An account is optional. Your watched addresses and locally encrypted wallets stay in this browser."}
      </p>
      {(error || configurationError) && (
        <p className="account-message account-error" role="alert">
          {error || configurationError}
        </p>
      )}
      {configuration && !configuration.configured && (
        <p className="account-message account-error" role="alert">
          The account service needs its production database, signing secret, and HTTPS origin
          configured.
        </p>
      )}
      {notice && (
        <p className="account-message account-success" role="status">
          {notice}
        </p>
      )}
      {isPending ? (
        <p className="account-muted">
          <LoaderCircle className="account-spin" size={16} /> Loading account…
        </p>
      ) : !user || mode === "reset" ? (
        <>
          <form className="account-form" onSubmit={submit}>
            {challenge ? (
              <>
                <label>
                  {backupMode ? "Single-use backup code" : "Authenticator code"}
                  <input
                    autoFocus
                    autoComplete="one-time-code"
                    inputMode={backupMode ? "text" : "numeric"}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    required
                  />
                </label>
                <p className="account-help">
                  {backupMode
                    ? "Each backup code works once. Keep your remaining codes somewhere safe."
                    : "Enter the 6-digit code from your authenticator app. Each code changes every 30 seconds."}
                </p>
                <button
                  type="button"
                  className="account-text-button"
                  onClick={() => {
                    setBackupMode(!backupMode);
                    setCode("");
                  }}
                >
                  {backupMode ? "Use an authenticator code" : "Use a backup code"}
                </button>
              </>
            ) : (
              <>
                {mode === "login" && (
                  <div className="account-segment" aria-label="Sign in using">
                    {(["email", "username"] as const).map((kind) => (
                      <button
                        type="button"
                        key={kind}
                        aria-pressed={identifierKind === kind}
                        onClick={() => setIdentifierKind(kind)}
                      >
                        {kind === "email" ? "Email" : "Username"}
                      </button>
                    ))}
                  </div>
                )}
                {mode === "login" && (
                  <label>
                    {identifierKind === "email" ? "Email address" : "Username"}
                    <input
                      autoFocus
                      type={identifierKind === "email" ? "email" : "text"}
                      autoComplete={identifierKind === "email" ? "email" : "username"}
                      value={identifier}
                      onChange={(event) => setIdentifier(event.target.value)}
                      required
                    />
                  </label>
                )}
                {(mode === "signup" || mode === "recover") && (
                  <label>
                    Email address
                    <input
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      required
                    />
                  </label>
                )}
                {mode === "signup" && (
                  <label>
                    Username
                    <input
                      autoComplete="username"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      required
                    />
                    <small>
                      Symbols, spaces, and Unicode welcome. Case-sensitive; NFC normalization
                      applies.
                    </small>
                  </label>
                )}
                {mode !== "recover" && (
                  <label>
                    {mode === "reset" ? "New password" : "Password"}
                    <input
                      type="password"
                      autoComplete={mode === "login" ? "current-password" : "new-password"}
                      minLength={mode === "login" ? undefined : 12}
                      maxLength={256}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                    />
                    <small>
                      {mode === "signup" || mode === "reset"
                        ? "12–256 characters. Any symbols; no required character categories. Passwords use Unicode NFKC normalization."
                        : ""}
                    </small>
                  </label>
                )}
                {(mode === "login" || mode === "signup") && (
                  <label>
                    Sign in again after
                    <select
                      value={sessionDuration}
                      onChange={(event) =>
                        setSessionDuration(event.target.value as SessionDuration)
                      }
                    >
                      {SESSION_DURATION_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <small>
                      The server ends this session at the chosen time, including after two-factor
                      verification.
                    </small>
                  </label>
                )}
                {(mode === "login" || mode === "signup") && (
                  <label className="account-checkbox">
                    <input
                      type="checkbox"
                      checked={rememberMe}
                      onChange={(event) => setRememberMe(event.target.checked)}
                    />
                    Remember me in this browser
                  </label>
                )}
                {(mode === "login" || mode === "signup") && (
                  <p className="account-help">
                    Unchecked: a browser-session cookie. Browser restore may keep that cookie; the
                    selected server deadline still applies. Social providers may also keep their own
                    sessions.
                  </p>
                )}
              </>
            )}
            <button
              className="account-primary"
              disabled={
                busy ||
                !configuration?.configured ||
                (mode === "recover" && !configuration.emailRecovery)
              }
              type="submit"
            >
              {busy
                ? "Please wait…"
                : challenge
                  ? "Verify & sign in"
                  : mode === "signup"
                    ? "Create account"
                    : mode === "recover"
                      ? "Send reset link"
                      : mode === "reset"
                        ? "Set new password"
                        : "Sign in"}
            </button>
          </form>
          {!challenge && mode !== "reset" && (
            <div className="account-form-links">
              <button
                type="button"
                onClick={() => {
                  setMode(mode === "signup" ? "login" : "signup");
                  setError("");
                }}
              >
                {mode === "signup"
                  ? "Already have an account? Sign in"
                  : "New here? Create an account"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode(mode === "recover" ? "login" : "recover");
                  setError("");
                }}
              >
                {mode === "recover" ? "Back to sign in" : "Forgot password?"}
              </button>
            </div>
          )}
          {mode === "recover" && !configuration?.emailRecovery && (
            <p className="account-help">
              Password reset emails require a configured email delivery service. Use another linked
              sign-in method if available.
            </p>
          )}
          {!challenge && mode === "login" && (
            <>
              <div className="account-divider">OR CONTINUE WITH</div>
              {providerButtons(false)}
            </>
          )}
        </>
      ) : (
        <>
          <div className="account-identity">
            <div>
              <strong>{user.name}</strong>
              <p>{user.email}</p>
              <small>{user.emailVerified ? "Verified email" : "Email not verified"}</small>
              {session.session.expiresAt && (
                <p className="account-session-expiry">
                  Sign in again by {new Date(session.session.expiresAt).toLocaleString()}
                </p>
              )}
            </div>
            <button
              type="button"
              className="account-secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await authClient.signOut();
                  if (result.error) throw new Error(result.error.message);
                  setSetup(null);
                  setBackupCodes([]);
                  setPassword("");
                  await refetch();
                })
              }
            >
              <LogOut size={15} /> Sign out
            </button>
          </div>
          {!user.emailVerified && configuration?.emailRecovery && (
            <button
              className="account-text-button"
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await request("send-verification-email", {
                    email: user.email,
                    callbackURL: returnTo
                      ? `/login?next=${encodeURIComponent(returnTo)}`
                      : "/login",
                  });
                  setNotice("Check your email to verify ownership before linking accounts.");
                })
              }
            >
              Send email verification
            </button>
          )}
          <div className="account-section-heading">
            <KeyRound size={17} />
            <h3>Authenticator & recovery</h3>
            <span
              className={twoFactorEnabled ? "account-badge" : "account-badge account-badge-muted"}
            >
              {twoFactorEnabled ? "Password 2FA on" : "Password 2FA off"}
            </span>
          </div>
          <p className="account-help">
            Authenticator codes protect email and username sign-in, using the standard 6 digits and
            30-second interval. Social sign-in uses the provider’s security settings; enable MFA
            there too. Save the 16-character single-use backup codes to recover authenticator
            access.
          </p>
          <label className="account-label">
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {!twoFactorEnabled && !setup && (
            <button
              className="account-secondary"
              type="button"
              disabled={busy || !password}
              onClick={() =>
                void run(async () => {
                  const result = await request<Setup>("two-factor/enable", { password });
                  setSetup(result);
                  setCode("");
                  setNotice(
                    "Add the secret to your authenticator, then enter its code to activate 2FA.",
                  );
                })
              }
            >
              Set up authenticator
            </button>
          )}
          {setup && (
            <div className="account-setup">
              <p className="account-help">
                In your authenticator app, add an account with this secret (time-based, SHA-1, 6
                digits, 30 seconds):
              </p>
              <code>{new URL(setup.totpURI).searchParams.get("secret")}</code>
              <a href={setup.totpURI}>
                Open in authenticator <ExternalLink size={12} />
              </a>
              <label className="account-label">
                Authenticator code
                <input
                  value={code}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              <button
                className="account-primary"
                disabled={busy || !code}
                type="button"
                onClick={() =>
                  void run(async () => {
                    await request("two-factor/verify-totp", { code, trustDevice: false });
                    setBackupCodes(setup.backupCodes);
                    setSetup(null);
                    setCode("");
                    setPassword("");
                    await refetch();
                    setNotice(
                      "2FA is active. Save your backup codes now; they are only shown here during setup.",
                    );
                  })
                }
              >
                Verify & activate 2FA
              </button>
            </div>
          )}
          {twoFactorEnabled && (
            <div className="account-actions">
              <button
                type="button"
                className="account-secondary"
                disabled={busy || !password}
                onClick={() =>
                  void run(async () => {
                    const result = await request<{ backupCodes: string[] }>(
                      "two-factor/generate-backup-codes",
                      { password },
                    );
                    setBackupCodes(result.backupCodes);
                    setNotice(
                      "New backup codes generated. All previous backup codes are now invalid.",
                    );
                  })
                }
              >
                Replace backup codes
              </button>
              <button
                type="button"
                className="account-danger"
                disabled={busy || !password}
                onClick={() => {
                  if (
                    window.confirm(
                      "Disable the authenticator and invalidate its backup codes? Your account will rely on your remaining sign-in methods.",
                    )
                  )
                    void run(async () => {
                      await request("two-factor/disable", { password });
                      setPassword("");
                      setBackupCodes([]);
                      await refetch();
                      setNotice("Authenticator disabled.");
                    });
                }}
              >
                Disable 2FA
              </button>
            </div>
          )}
          {backupCodes.length > 0 && (
            <div className="account-backup">
              <strong>Save these somewhere private</strong>
              <p className="account-help">
                Each code works once. These are account recovery codes, not wallet recovery words.
              </p>
              <pre>{backupCodes.join("\n")}</pre>
              <div className="account-actions">
                <button
                  className="account-secondary"
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      await navigator.clipboard.writeText(backupCodes.join("\n"));
                      setCopied(true);
                    })
                  }
                >
                  <Copy size={14} />
                  {copied ? "Copied" : "Copy codes"}
                </button>
                <button
                  className="account-secondary"
                  type="button"
                  onClick={() => setBackupCodes([])}
                >
                  I saved them — hide
                </button>
              </div>
            </div>
          )}
          <div className="account-section-heading">
            <Link2 size={17} />
            <h3>Independent sign-in methods</h3>
          </div>
          <AccountRecoveryReadiness
            providerIds={accounts.map((account) => account.providerId)}
            emailVerified={user.emailVerified}
            emailRecoveryConfigured={configuration?.emailRecovery ?? null}
            twoFactorEnabled={twoFactorEnabled}
          />
          <p className="account-help">
            Connect another provider and keep an email/password login. A suspended Discord account
            won’t then be your only route back. Linking requires proving ownership through that
            provider and a verified local email.
          </p>
          {providerButtons(true)}
          {accounts
            .filter((account) => account.providerId !== "credential")
            .map((account) => (
              <div className="account-linked" key={account.id}>
                <span>{account.providerId}</span>
                <button
                  type="button"
                  className="account-text-button"
                  disabled={busy || accounts.length < 2}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Disconnect ${account.providerId}? Make sure you can still sign in with another method.`,
                      )
                    )
                      void run(async () => {
                        await request("unlink-account", {
                          providerId: account.providerId,
                          accountId: account.accountId,
                        });
                        setAccounts(await request<LinkedAccount[]>("list-accounts"));
                        setNotice("Provider disconnected.");
                      });
                  }}
                >
                  Disconnect
                </button>
              </div>
            ))}
          <div className="account-section-heading">
            <KeyRound size={17} />
            <h3>
              {accounts.some((account) => account.providerId === "credential")
                ? "Change password"
                : "Add password recovery"}
            </h3>
          </div>
          <label className="account-label">
            New password
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={256}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          <button
            className="account-secondary"
            type="button"
            disabled={
              busy ||
              newPassword.length < 12 ||
              (accounts.some((account) => account.providerId === "credential") && !password)
            }
            onClick={() =>
              void run(async () => {
                const credential = accounts.some((account) => account.providerId === "credential");
                await request(
                  credential ? "change-password" : "add-password",
                  credential
                    ? { currentPassword: password, newPassword, revokeOtherSessions: true }
                    : { newPassword },
                );
                setPassword("");
                setNewPassword("");
                setAccounts(await request<LinkedAccount[]>("list-accounts"));
                setNotice(
                  "Password saved. Use your email to sign in independently of a social provider.",
                );
              })
            }
          >
            Save password
          </button>
          {!configuration?.emailRecovery && (
            <p className="account-help">
              Email delivery is not configured: email verification and password reset links are
              unavailable. Existing passwords and 2FA backup codes work independently.
            </p>
          )}
          <AccountSessions key={session.session.id} currentSessionId={session.session.id} />
        </>
      )}
      <p className="account-footnote">
        Account recovery does not recover a lost wallet passphrase or recovery phrase. Identity
        verification and service-held keys are not enabled.
      </p>
      <button className="account-text-button account-done" type="button" onClick={onClose}>
        Back to dashboard
      </button>
    </section>
  );
}
