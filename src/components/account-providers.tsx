import { useState } from "react";
import { Check } from "lucide-react";
import {
  SOCIAL_PROVIDERS,
  socialProviderLabel,
  type SupportedSocialProviderId,
} from "@/lib/auth/providers";

type Props = {
  configuration: { configured: boolean; providers: Record<string, boolean> } | null;
  availability: "loading" | "ready" | "unavailable";
  accounts: readonly { providerId: string }[];
  linking: boolean;
  busy: boolean;
  onConnect: (provider: SupportedSocialProviderId, linking: boolean) => void;
  onSetup: (provider: SupportedSocialProviderId) => void;
};

export function AccountProviders({
  configuration,
  availability,
  accounts,
  linking,
  busy,
  onConnect,
  onSetup,
}: Props) {
  const [helpProvider, setHelpProvider] = useState<SupportedSocialProviderId | null>(null);
  const supported = SOCIAL_PROVIDERS.filter((provider) => provider.supported);
  const enabled = supported.filter(
    (provider) =>
      provider.supported &&
      configuration?.configured === true &&
      configuration.providers[provider.providerId] === true,
  );

  return (
    <section
      className="account-provider-options"
      data-availability={availability}
      aria-label={linking ? "Connect sign-in services" : "Social sign-in options"}
    >
      <div className="account-providers">
        {supported.map((provider) => {
          if (!provider.supported) return null;
          const ready =
            availability === "ready" &&
            configuration?.configured === true &&
            configuration.providers[provider.providerId] === true;
          const connected = accounts.some((account) => account.providerId === provider.providerId);
          if (linking && connected && ready)
            return (
              <span className="account-provider-connected" key={provider.providerId}>
                <Check size={14} aria-hidden="true" /> {provider.label} connected
              </span>
            );
          return (
            <button
              className="account-provider"
              type="button"
              key={provider.providerId}
              disabled={busy || availability !== "ready"}
              data-provider-action={
                availability !== "ready" ? "pending" : ready ? "oauth" : "setup"
              }
              onClick={() => {
                if (availability !== "ready") return;
                if (ready) onConnect(provider.providerId, linking);
                else {
                  setHelpProvider(provider.providerId);
                  onSetup(provider.providerId);
                }
              }}
              aria-label={
                availability !== "ready"
                  ? `${provider.label} sign-in`
                  : ready
                    ? `${linking ? "Connect" : "Continue with"} ${provider.label}`
                    : `${provider.label} sign-in setup`
              }
            >
              <span className="account-provider-mark" aria-hidden="true">
                {provider.mark}
              </span>
              <span>
                <span>{linking && connected ? `${provider.label} connected` : provider.label}</span>
                {availability === "ready" && (
                  <small>
                    {ready ? (linking ? "Connect account" : "Continue") : "Setup needed"}
                  </small>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {availability === "loading" && (
        <p className="account-provider-note" role="status">
          Checking sign-in services…
        </p>
      )}
      {availability === "ready" && !enabled.length && !helpProvider && (
        <p className="account-provider-note">
          The website owner needs to enable social sign-in. Choose a service to view setup help.
        </p>
      )}
      {availability === "ready" &&
        helpProvider &&
        !(configuration?.configured && configuration.providers[helpProvider] === true) && (
          <p className="account-provider-note" role="status">
            {socialProviderLabel(helpProvider)} sign-in is not enabled on this website yet. The
            website owner must finish account and provider setup before one-click sign-in can work.
          </p>
        )}
    </section>
  );
}
