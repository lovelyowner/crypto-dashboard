export const SOCIAL_PROVIDERS = [
  { providerId: "google", label: "Google", mark: "G", supported: true },
  { providerId: "discord", label: "Discord", mark: "◉", supported: true },
  { providerId: "twitter", label: "Twitter / X", mark: "𝕏", supported: true },
  { providerId: "github", label: "GitHub", mark: "GH", supported: true },
  { providerId: "twitch", label: "Twitch", mark: "T", supported: true },
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
