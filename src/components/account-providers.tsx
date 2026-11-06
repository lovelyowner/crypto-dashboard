import { Check } from "lucide-react";
import { SOCIAL_PROVIDERS, type SupportedSocialProviderId } from "@/lib/auth/providers";

type Props = {
  availability: "loading" | "ready" | "unavailable";
  accounts: readonly { providerId: string }[];
  linking: boolean;
  busy: boolean;
  pendingProvider: SupportedSocialProviderId | null;
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
  pendingProvider,
  authPending,
  helpOpen,
  onConnect,
  onHelp,
  onDismissSetup,
}: Props) {
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
              aria-busy={pendingProvider === provider.providerId}
              onClick={() => {
                if (busy || authPending) return;
                onDismissSetup();
                onConnect(provider.providerId, linking);
              }}
            >
              <span className="account-provider-mark" aria-hidden="true">
                {provider.mark}
              </span>
              <span>
                {pendingProvider === provider.providerId ? `Opening ${provider.label}…` : label}
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="account-text-button account-signin-help"
        aria-expanded={helpOpen}
        disabled={busy}
        onClick={onHelp}
      >
        Website sign-in setup
      </button>
    </section>
  );
}
