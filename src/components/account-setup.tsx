import { useState } from "react";
import type { PublicAuthConfiguration } from "@/lib/auth/public-configuration";

export function AccountSetupStatus({
  configuration,
}: {
  configuration: PublicAuthConfiguration | null;
}) {
  const [notice, setNotice] = useState("");
  if (
    !configuration?.setup ||
    (configuration.configured && Object.values(configuration.providers).some(Boolean))
  )
    return null;
  const setup = configuration.setup;
  const prefix = setup.environment === "preview" ? "PREVIEW_" : "";
  const report = [
    `Website sign-in setup (${setup.environment})`,
    `${prefix}DATABASE_URL: ${setup.database ? "configured" : "needed"}`,
    `${prefix}BETTER_AUTH_SECRET: ${setup.secret ? "configured" : "needed (at least 32 random characters)"}`,
    `${prefix}BETTER_AUTH_URL: ${setup.origin ? "configured" : "needed (exact stable HTTPS origin)"}`,
    ...["google", "discord", "twitter", "github", "twitch"].map(
      (provider) =>
        `${provider.toUpperCase()}_CLIENT_ID / ${provider.toUpperCase()}_CLIENT_SECRET: ${configuration.providers[provider] ? "configured" : "not enabled"}`,
    ),
    `OAuth callback format: ${configuration.signInOrigin ?? "<stable HTTPS origin>"}/api/auth/callback/<provider>`,
    "Configure these in the matching server environment, register callbacks with each provider, then redeploy. This checklist contains no credential values.",
  ].join("\n");
  return (
    <details className="account-service-details account-setup-details">
      <summary>Website sign-in setup</summary>
      <p className="account-help">
        The website owner can use this checklist to finish account setup. These checks show settings
        are present; they do not test provider connections.
      </p>
      <ul className="account-service-statuses">
        {(
          [
            ["Account storage", setup.database],
            ["Account security", setup.secret],
            ["Sign-in address", setup.origin],
          ] as const
        ).map(([label, ready]) => (
          <li key={label}>
            <span className="account-service-name">{label}</span>
            <span>{ready ? "Configured" : "Needs setup"}</span>
          </li>
        ))}
      </ul>
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
    </details>
  );
}
