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
  authPending: boolean;
  selectedProvider: SupportedSocialProviderId | null;
  onConnect: (provider: SupportedSocialProviderId, linking: boolean) => void;
  onSetup: (provider: SupportedSocialProviderId) => void;
  onDismissSetup: () => void;
};

export function AccountProviders({
  configuration,
  availability,
  accounts,
  linking,
  busy,
  authPending,
  selectedProvider,
  onConnect,
  onSetup,
  onDismissSetup,
}: Props) {
  const [infoProvider, setInfoProvider] = useState<string | null>(null);
  const otherServices = SOCIAL_PROVIDERS.filter((provider) => !provider.supported);
  const selectedInfo = otherServices.find((provider) => provider.providerId === infoProvider);
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
              disabled={busy || (ready && authPending)}
              data-provider-id={provider.providerId}
              aria-pressed={!ready ? selectedProvider === provider.providerId : undefined}
              data-provider-action={availability !== "ready" ? "check" : ready ? "oauth" : "setup"}
              onClick={() => {
                if (busy || (ready && authPending)) return;
                setInfoProvider(null);
                if (ready) {
                  onDismissSetup();
                  onConnect(provider.providerId, linking);
                } else {
                  onSetup(provider.providerId);
                }
              }}
              aria-label={
                availability !== "ready"
                  ? `${provider.label} sign-in status`
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
                <small>
                  {availability !== "ready"
                    ? "Check status"
                    : ready
                      ? linking
                        ? "Connect account"
                        : "Continue"
                      : "Setup needed"}
                </small>
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
      {availability === "ready" && !enabled.length && !selectedProvider && !selectedInfo && (
        <p className="account-provider-note">
          The website owner needs to enable social sign-in. Choose a service to view setup help.
        </p>
      )}
      {availability === "ready" &&
        selectedProvider &&
        !(configuration?.configured && configuration.providers[selectedProvider] === true) && (
          <p className="account-provider-note" role="status">
            {socialProviderLabel(selectedProvider)} sign-in is not enabled on this website yet. The
            website owner must finish account and provider setup before one-click sign-in can work.
          </p>
        )}
      <details className="account-service-details account-other-services">
        <summary>More services</summary>
        <div className="account-providers account-provider-information">
          {otherServices.map((provider) => (
            <button
              key={provider.providerId}
              type="button"
              className="account-provider-info"
              disabled={busy}
              data-provider-id={provider.providerId}
              aria-label={`${provider.label} availability`}
              aria-pressed={infoProvider === provider.providerId}
              onClick={() => {
                onDismissSetup();
                setInfoProvider(provider.providerId);
              }}
            >
              <span className="account-provider-mark" aria-hidden="true">
                {provider.mark}
              </span>
              <span>
                {provider.label}
                <small>Integration needed</small>
              </span>
            </button>
          ))}
        </div>
        {selectedInfo && (
          <p
            className="account-provider-note account-provider-explanation"
            data-provider-info={selectedInfo.providerId}
            role="status"
          >
            {selectedInfo.requirement}
          </p>
        )}
      </details>
    </section>
  );
}
