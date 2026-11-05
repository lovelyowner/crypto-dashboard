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
    requirement: "Needs an AT Protocol OAuth integration with verified DID identity.",
  },
  {
    providerId: "fluxer",
    label: "Fluxer",
    mark: "F",
    supported: false,
    requirement: "Needs a verified Fluxer identity integration and registered application.",
  },
  {
    providerId: "stoat",
    label: "Stoat",
    mark: "S",
    supported: false,
    requirement: "Needs a verified Stoat identity integration and registered application.",
  },
  {
    providerId: "hey",
    label: "hey.xyz",
    mark: "hey",
    supported: false,
    requirement: "Needs Lens account authentication and proof of account control.",
  },
  {
    providerId: "mastodon",
    label: "Mastodon",
    mark: "M",
    supported: false,
    requirement:
      "Needs instance-specific OAuth and verified account mapping without inventing an email.",
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
