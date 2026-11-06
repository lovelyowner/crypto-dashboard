import { useState } from "react";
import { Check } from "lucide-react";
import { SOCIAL_PROVIDERS, type SupportedSocialProviderId } from "@/lib/auth/providers";

type Props = {
  availability: "loading" | "ready" | "unavailable";
  accounts: readonly { providerId: string }[];
  linking: boolean;
  busy: boolean;
  authPending: boolean;
  helpOpen: boolean;
  onConnect: (provider: SupportedSocialProviderId, linking: boolean) => void;
  onHelp: () => void;
  onDismissSetup: () => void;
};

export function AccountProviders({
  availability,
  accounts,
  linking,
  busy,
  authPending,
  helpOpen,
  onConnect,
  onHelp,
  onDismissSetup,
}: Props) {
  const [infoProvider, setInfoProvider] = useState<string | null>(null);
  const otherServices = SOCIAL_PROVIDERS.filter((provider) => !provider.supported);
  const selectedInfo = otherServices.find((provider) => provider.providerId === infoProvider);

  return (
    <section
      className="account-provider-options"
      data-availability={availability}
      aria-label={linking ? "Connect sign-in services" : "Social sign-in options"}
    >
      <div className="account-providers">
        {SOCIAL_PROVIDERS.map((provider) => {
          if (!provider.supported) return null;
          const connected = accounts.some((account) => account.providerId === provider.providerId);
          if (linking && connected)
            return (
              <span className="account-provider-connected" key={provider.providerId}>
                <Check size={14} aria-hidden="true" /> {provider.label} connected
              </span>
            );
          const label = `${linking ? "Connect" : "Continue with"} ${provider.label}`;
          return (
            <button
              className="account-provider"
              type="button"
              key={provider.providerId}
              disabled={busy || authPending}
              data-provider-id={provider.providerId}
              data-provider-action="oauth"
              aria-label={label}
              onClick={() => {
                if (busy || authPending) return;
                setInfoProvider(null);
                onDismissSetup();
                onConnect(provider.providerId, linking);
              }}
            >
              <span className="account-provider-mark" aria-hidden="true">
                {provider.mark}
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="account-text-button account-signin-help"
        aria-expanded={helpOpen}
        disabled={busy}
        onClick={() => {
          setInfoProvider(null);
          onHelp();
        }}
      >
        Website sign-in setup
      </button>
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
