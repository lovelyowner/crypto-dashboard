import { Check } from "lucide-react";
import { SOCIAL_PROVIDERS, type SupportedSocialProviderId } from "@/lib/auth/providers";

type Props = {
  configuration: { configured: boolean; providers: Record<string, boolean> } | null;
  accounts: readonly { providerId: string }[];
  linking: boolean;
  busy: boolean;
  onConnect: (provider: SupportedSocialProviderId, linking: boolean) => void;
};

export function AccountProviders({ configuration, accounts, linking, busy, onConnect }: Props) {
  const enabled = SOCIAL_PROVIDERS.filter(
    (provider) =>
      provider.supported &&
      configuration?.configured === true &&
      configuration.providers[provider.providerId] === true,
  );

  return (
    <section
      className="account-provider-options"
      aria-label={linking ? "Connect sign-in services" : "Social sign-in options"}
    >
      <div className="account-providers">
        {enabled.map((provider) => {
          if (!provider.supported) return null;
          const connected = accounts.some((account) => account.providerId === provider.providerId);
          if (linking && connected)
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
              disabled={busy}
              onClick={() => onConnect(provider.providerId, linking)}
              aria-label={`${linking ? "Connect" : "Continue with"} ${provider.label}`}
            >
              <span className="account-provider-mark" aria-hidden="true">
                {provider.mark}
              </span>
              <span>
                {provider.label}
                <small>{linking ? "Connect account" : "Continue"}</small>
              </span>
            </button>
          );
        })}
      </div>
      {!enabled.length && (
        <p className="account-provider-note">
          Social sign-in needs server setup. Email and passkeys use the account service.
        </p>
      )}
      <details className="account-service-details">
        <summary>Sign-in services</summary>
        <ul className="account-service-statuses">
          {SOCIAL_PROVIDERS.map((provider) => {
            const ready =
              provider.supported &&
              configuration?.configured === true &&
              configuration.providers[provider.providerId] === true;
            return (
              <li key={provider.providerId}>
                <span className="account-service-name">{provider.label}</span>
                <span>
                  {!configuration
                    ? "Checking availability…"
                    : ready
                      ? "Available"
                      : provider.supported
                        ? "Server setup required"
                        : "Integration needed"}
                </span>
                {"requirement" in provider && <small>{provider.requirement}</small>}
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}
