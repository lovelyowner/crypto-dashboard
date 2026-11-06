import { useEffect, useRef, useState } from "react";
import type { PublicAuthConfiguration } from "@/lib/auth/public-configuration";
import { socialProviderLabel, type SupportedSocialProviderId } from "@/lib/auth/providers";
import type { AuthRequestDiagnostic } from "@/lib/auth/request-diagnostic";

export function AccountSetupStatus({
  configuration,
  availability,
  request,
  diagnostic,
  onRetry,
  onClose,
}: {
  configuration: PublicAuthConfiguration | null;
  availability: "loading" | "ready" | "unavailable";
  request?: { provider: SupportedSocialProviderId | null; version: number } | null;
  diagnostic?: (AuthRequestDiagnostic & { provider: SupportedSocialProviderId }) | null;
  onRetry: () => void;
  onClose?: () => void;
}) {
  const [notice, setNotice] = useState("");
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!request || !details.current) return;
    details.current.open = true;
  }, [request]);
  if (!request) return null;
  const setup = configuration?.setup;
  const prefix = setup?.environment === "preview" ? "PREVIEW_" : "";
  const settingName = (name: string) => (setup ? `${prefix}${name}` : `${name} / PREVIEW_${name}`);
  const reportStatus = (value: boolean | undefined, needed = "needed") =>
    value === undefined ? "Unknown" : value ? "configured" : needed;
  const report = [
    `Website sign-in setup (${setup?.environment ?? "Unknown environment"})`,
    ...(!configuration
      ? [`Configuration request: ${availability === "loading" ? "Loading" : "Unavailable"}`]
      : []),
    `${settingName("DATABASE_URL")}: ${reportStatus(setup?.database)}`,
    `${settingName("BETTER_AUTH_SECRET")}: ${reportStatus(setup?.secret, "needed (at least 32 random characters)")}`,
    `${settingName("BETTER_AUTH_URL")}: ${reportStatus(setup?.origin, "needed (exact stable HTTPS origin)")}`,
    ...["google", "discord", "twitter", "github", "twitch"].map(
      (provider) =>
        `${provider.toUpperCase()}_CLIENT_ID / ${provider.toUpperCase()}_CLIENT_SECRET: ${configuration ? (configuration.providers[provider] ? "configured" : "not enabled") : "Unknown"}`,
    ),
    `OAuth callback format: ${configuration?.signInOrigin ?? "<stable HTTPS origin>"}/api/auth/callback/<provider>`,
    ...(diagnostic
      ? [
          `Last ${socialProviderLabel(diagnostic.provider)} request: HTTP ${diagnostic.status}`,
          `Response type: ${diagnostic.responseType}`,
          ...(diagnostic.requestId ? [`Vercel request ID: ${diagnostic.requestId}`] : []),
        ]
      : []),
    ...(!configuration
      ? [
          "Unknown means the website settings could not be read; it does not establish that credentials are missing.",
        ]
      : []),
    "Configure these in the matching server environment, register callbacks with each provider, then redeploy. This checklist contains no credential values.",
  ].join("\n");
  return (
    <details ref={details} className="account-service-details account-setup-details">
      <summary>Website sign-in setup</summary>
      {!configuration && request && (
        <p className="account-help account-setup-availability" role="status">
          {request.provider ? socialProviderLabel(request.provider) : "Social"} sign-in availability{" "}
          {availability === "loading"
            ? "is still being checked."
            : "could not be checked. Retry to load this website’s sign-in settings."}
        </p>
      )}
      <p className="account-help">
        {configuration
          ? "The website owner can use this checklist to finish account setup. These checks show settings are present; they do not test provider connections."
          : "Settings are unknown because the website has not returned valid sign-in information. This does not mean provider credentials are missing."}
      </p>
      {diagnostic && (
        <p className="account-help account-request-diagnostic">
          Last {socialProviderLabel(diagnostic.provider)} request: HTTP {diagnostic.status};{" "}
          {diagnostic.responseType}.
          {diagnostic.requestId && (
            <>
              {" "}
              Request ID: <span>{diagnostic.requestId}</span>.
            </>
          )}{" "}
          The website owner can use this response information to inspect deployment access and
          function logs.
        </p>
      )}
      <ul className="account-service-statuses">
        {(
          [
            ["Account storage", setup?.database],
            ["Account security", setup?.secret],
            ["Sign-in address", setup?.origin],
          ] as const
        ).map(([label, ready]) => (
          <li key={label}>
            <span className="account-service-name">{label}</span>
            <span>{ready === undefined ? "Unknown" : ready ? "Configured" : "Needs setup"}</span>
          </li>
        ))}
        {request.provider && (
          <li>
            <span className="account-service-name">
              {socialProviderLabel(request.provider)} sign-in
            </span>
            <span>
              {!configuration
                ? "Unknown"
                : configuration.configured && configuration.providers[request.provider] === true
                  ? "Configured"
                  : "Needs setup"}
            </span>
          </li>
        )}
      </ul>
      {request.provider && configuration && (
        <p className="account-help">
          {socialProviderLabel(request.provider)} needs its registered application ID, client
          secret, and exact website callback URL configured by the website owner.
        </p>
      )}
      {!configuration && availability === "unavailable" && (
        <button
          type="button"
          className="account-secondary"
          aria-label="Retry sign-in options"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
      <button
        type="button"
        className="account-secondary"
        onClick={() => {
          if (!navigator.clipboard?.writeText) {
            setNotice("Clipboard access is unavailable. The setup status is shown above.");
            return;
          }
          void navigator.clipboard.writeText(report).then(
            () => setNotice("Setup checklist copied. It contains no credential values."),
            () => setNotice("Could not copy. The setup status is shown above."),
          );
        }}
      >
        Copy setup checklist
      </button>
      {notice && (
        <p className="account-help" role="status">
          {notice}
        </p>
      )}
      {onClose && (
        <button type="button" className="account-text-button" onClick={onClose}>
          Close setup help
        </button>
      )}
    </details>
  );
}
