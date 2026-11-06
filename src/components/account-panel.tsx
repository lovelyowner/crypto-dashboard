import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  LoaderCircle,
  LogOut,
  ShieldCheck,
} from "lucide-react";
import { authClient } from "@/lib/auth/client";
import {
  isValidUsername,
  normalizeUsername,
  DEFAULT_SESSION_DURATION,
  SESSION_DURATION_HEADER,
  type SessionDuration,
} from "@/lib/auth/policy";
import { AccountRecoveryReadiness, AccountSessions } from "./account-sessions";
import { safeAccountReturnPath } from "@/lib/auth/return-to";
import { AccountPasskeys } from "./account-passkeys";
import {
  beginPasskeyCeremony,
  browserSupportsPasskeys,
  cancelPasskeyCeremony,
  endPasskeyCeremony,
} from "@/lib/auth/passkeys-browser";
import { AccountProviders } from "./account-providers";
import { socialProviderLabel, type SupportedSocialProviderId } from "@/lib/auth/providers";
import { useAuthConfiguration } from "@/lib/auth/use-configuration";
import { socialReturnError, socialReturnPath } from "@/lib/auth/social-return";
import { AccountSetupStatus } from "./account-setup";
import { AccountDataExport } from "./account-data-export";
import "./account.css";

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
  const {
    configuration,
    status: configurationStatus,
    error: configurationError,
    retry: reloadConfiguration,
  } = useAuthConfiguration();
  const [mode, setMode] = useState<"login" | "signup" | "recover" | "reset">("login");
  const [identifierKind, setIdentifierKind] = useState<"email" | "username">("email");
  const [identifier, setIdentifier] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const sessionDuration = DEFAULT_SESSION_DURATION;
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
  const [setupRequest, setSetupRequest] = useState<{
    provider: SupportedSocialProviderId;
    version: number;
  } | null>(null);
  const [currentOrigin, setCurrentOrigin] = useState("");
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const passkeyOperation = useRef<AbortController | null>(null);
  const user = session?.user;
  const twoFactorEnabled = Boolean(user?.twoFactorEnabled);

  useEffect(() => {
    setPasskeySupported(browserSupportsPasskeys(configuration?.passkeyOrigin));
    return () => {
      passkeyOperation.current?.abort();
      cancelPasskeyCeremony();
    };
  }, [configuration?.passkeyOrigin, user?.id]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setCurrentOrigin(window.location.origin);
    setReturnTo(safeAccountReturnPath(params.get("next")));
    const providerError = socialReturnError(params.get("error"));
    if (providerError) setError(providerError);
    if (params.get("twoFactor") === "1") {
      setMode("login");
      setChallenge(true);
    }
    if (params.has("error") || params.has("twoFactor") || params.has("error_description")) {
      params.delete("error");
      params.delete("error_description");
      params.delete("twoFactor");
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`,
      );
    }
    const token = params.get("token");
    if (params.get("reset") && token) {
      setResetToken(token);
      setMode("reset");
    }
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
      if (otherSignInOrigin) throw new Error("Open the configured sign-in website to continue.");
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
        window.history.replaceState(window.history.state, "", window.location.pathname);
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

  const connect = (provider: SupportedSocialProviderId, linking: boolean) =>
    void run(async () => {
      if (!configuration?.configured || configuration.providers[provider] !== true)
        throw new Error(`${socialProviderLabel(provider)} sign-in needs website-owner setup.`);
      if (
        configuration?.signInOrigin &&
        currentOrigin &&
        configuration.signInOrigin !== currentOrigin
      )
        throw new Error("Open the configured sign-in website before continuing with a service.");
      const result = linking
        ? await authClient.linkSocial({
            provider,
            callbackURL: socialReturnPath(returnTo),
            errorCallbackURL: socialReturnPath(returnTo),
          })
        : await authClient.signIn.social({
            provider,
            callbackURL: socialReturnPath(returnTo),
            errorCallbackURL: socialReturnPath(returnTo),
            fetchOptions: {
              headers: {
                [SESSION_DURATION_HEADER]: sessionDuration,
                "x-fathom-remember-me": String(rememberMe),
              },
            },
          });
      if (result.error)
        throw new Error(result.error.message || "Could not start provider sign-in.");
      if (result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect) {
        setMode("login");
        setChallenge(true);
      }
    });

  const otherSignInOrigin =
    configuration?.signInOrigin && currentOrigin && configuration.signInOrigin !== currentOrigin
      ? configuration.signInOrigin
      : null;
  const ordinarySignIn = !user && !challenge && (mode === "login" || mode === "signup");
  const setupHelp = setupRequest && !challenge && (user || ordinarySignIn) && (
    <AccountSetupStatus
      configuration={configuration}
      availability={configurationStatus}
      request={setupRequest}
      onRetry={() => {
        setError("");
        reloadConfiguration();
      }}
      onClose={() => {
        const provider = setupRequest.provider;
        setSetupRequest(null);
        document
          .querySelector<HTMLButtonElement>(`.account-provider[data-provider-id="${provider}"]`)
          ?.focus({ preventScroll: true });
      }}
    />
  );
  const providerButtons = (linking: boolean) =>
    otherSignInOrigin ? null : (
      <>
        <AccountProviders
          configuration={configuration}
          availability={configurationStatus}
          accounts={accounts}
          linking={linking}
          busy={busy}
          authPending={isPending}
          selectedProvider={setupRequest?.provider ?? null}
          onConnect={connect}
          onSetup={(provider) =>
            setSetupRequest((value) => ({ provider, version: (value?.version ?? 0) + 1 }))
          }
          onDismissSetup={() => setSetupRequest(null)}
        />
        {setupHelp}
      </>
    );

  const signInChoices = ordinarySignIn && (
    <>
      {mode === "login" &&
        configuration?.configured &&
        configuration.passkeys &&
        passkeySupported && (
          <>
            <button
              type="button"
              className="account-secondary account-passkey-signin"
              disabled={busy || isPending}
              onClick={() =>
                void run(async () => {
                  const controller = beginPasskeyCeremony();
                  passkeyOperation.current = controller;
                  setPasskeyBusy(true);
                  try {
                    const result = await authClient.signIn.passkey({
                      fetchOptions: {
                        signal: controller.signal,
                        headers: {
                          [SESSION_DURATION_HEADER]: sessionDuration,
                          "x-fathom-remember-me": String(rememberMe),
                        },
                      },
                    });
                    if (controller.signal.aborted) return;
                    if (result.error)
                      throw new Error(
                        result.error.message ||
                          "Passkey sign-in was cancelled. Retry or use another method.",
                      );
                    if (
                      (result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect
                    ) {
                      setChallenge(true);
                      return;
                    }
                    await refetch();
                    setNotice("Signed in with your passkey.");
                  } finally {
                    if (passkeyOperation.current === controller) passkeyOperation.current = null;
                    endPasskeyCeremony(controller);
                    setPasskeyBusy(false);
                  }
                })
              }
            >
              <KeyRound size={15} /> Sign in with a passkey
            </button>
            {passkeyBusy && (
              <button
                className="account-text-button"
                type="button"
                onClick={() => {
                  passkeyOperation.current?.abort();
                  cancelPasskeyCeremony();
                }}
              >
                Cancel passkey sign-in
              </button>
            )}
          </>
        )}
      {providerButtons(false)}
    </>
  );

  const accountFeedback = (
    <>
      {(error || configurationError) && (
        <p className={error ? "account-message account-error" : "account-help"} role="alert">
          {error || configurationError}
        </p>
      )}
      {configurationStatus === "unavailable" && !setupHelp && (
        <button
          className="account-text-button"
          aria-label="Retry sign-in options"
          type="button"
          onClick={() => {
            setError("");
            reloadConfiguration();
          }}
        >
          Retry
        </button>
      )}
      {configuration && !configuration.configured && (
        <p className="account-help" role="alert">
          Account sign-in needs website setup.
        </p>
      )}
      {otherSignInOrigin && (
        <p className="account-message">
          <a
            href={new URL(socialReturnPath(returnTo), otherSignInOrigin).href}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open the configured sign-in website
          </a>{" "}
          to keep verification on the correct address. Local wallets and watchlists stay with their
          original website address.
        </p>
      )}
      {notice && (
        <p className="account-message account-success" role="status">
          {notice}
        </p>
      )}
    </>
  );

  return (
    <section className="account-panel">
      {user || challenge || mode === "recover" || mode === "reset" ? (
        <>
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
          {user && (
            <p className="account-intro">
              Keep independent ways to sign in, so losing a social account doesn’t lock you out.
            </p>
          )}
        </>
      ) : (
        <h2 className="sr-only">{mode === "signup" ? "Create account" : "Sign in"}</h2>
      )}
      {!ordinarySignIn && accountFeedback}
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
              </>
            )}
            <button
              className="account-primary"
              disabled={
                busy ||
                !configuration?.configured ||
                Boolean(otherSignInOrigin) ||
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
              {twoFactorEnabled ? "Account 2FA on" : "Account 2FA off"}
            </span>
          </div>
          <p className="account-help">
            When enabled, authenticator codes protect email, username, passkey, and social sign-in.
            Codes use 6 digits and a 30-second interval. Save your single-use backup codes to
            recover authenticator access. You can also enable MFA with each social provider.
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
                <span>{socialProviderLabel(account.providerId)}</span>
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
          <AccountPasskeys
            key={user.id}
            userId={user.id}
            createdAt={session.session.createdAt}
            available={Boolean(configuration?.configured && configuration.passkeys)}
            origin={configuration?.passkeyOrigin}
          />
          <AccountSessions key={session.session.id} currentSessionId={session.session.id} />
          <AccountDataExport key={`export:${user.id}`} />
        </>
      )}
      {ordinarySignIn && (
        <div className="account-signin-options">
          {signInChoices}
          {accountFeedback}
        </div>
      )}
      {user && (
        <p className="account-footnote">
          Account recovery does not recover a lost wallet passphrase or recovery phrase. Identity
          verification and service-held keys are not enabled.
        </p>
      )}
      <button className="account-text-button account-done" type="button" onClick={onClose}>
        Back to dashboard
      </button>
    </section>
  );
}
