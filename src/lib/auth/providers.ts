export const SOCIAL_PROVIDERS = [
  { providerId: "google", label: "Google", mark: "G", supported: true },
  { providerId: "discord", label: "Discord", mark: "◉", supported: true },
  { providerId: "twitter", label: "Twitter / X", mark: "𝕏", supported: true },
  { providerId: "github", label: "GitHub", mark: "GH", supported: true },
  { providerId: "twitch", label: "Twitch", mark: "T", supported: true },
  {
    providerId: "bluesky",
    label: "Bluesky",
    mark: "BS",
    supported: false,
    requirement:
      "Bluesky sign-in is possible through AT Protocol OAuth. This website still needs that integration and verified Bluesky identity support; ordinary OAuth buttons cannot enable it.",
  },
  {
    providerId: "fluxer",
    label: "Fluxer",
    mark: "F",
    supported: false,
    requirement:
      "Fluxer is not connected to this website yet. Its application registration and account-verification flow must be confirmed and integrated before it can be used to sign in.",
  },
  {
    providerId: "stoat",
    label: "Stoat",
    mark: "S",
    supported: false,
    requirement:
      "Stoat is not connected to this website yet. A supported third-party sign-in flow and proof of account control must be confirmed and integrated first.",
  },
  {
    providerId: "hey",
    label: "hey.xyz",
    mark: "hey",
    supported: false,
    requirement:
      "hey.xyz sign-in needs Lens account authentication and proof that you control the account. That integration is not connected to this website yet.",
  },
  {
    providerId: "mastodon",
    label: "Mastodon",
    mark: "M",
    supported: false,
    requirement:
      "Mastodon sign-in is possible through your Mastodon server. This website still needs server selection and verified account mapping; Mastodon does not provide the email required by the current login adapter.",
  },
] as const;

export type SupportedSocialProviderId = Extract<
  (typeof SOCIAL_PROVIDERS)[number],
  { supported: true }
>["providerId"];

export function isSupportedSocialProviderId(value: string): value is SupportedSocialProviderId {
  return SOCIAL_PROVIDERS.some((provider) => provider.supported && provider.providerId === value);
}

export function socialProviderLabel(value: string): string {
  return SOCIAL_PROVIDERS.find((provider) => provider.providerId === value)?.label ?? value;
}
/** Compatibility for imported components. These are direct providers, never a broker. */
export const GROK_PROVIDERS = SOCIAL_PROVIDERS.filter((provider) => provider.supported);
