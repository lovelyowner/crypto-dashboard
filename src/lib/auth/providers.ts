export const SOCIAL_PROVIDERS = [
  { providerId: "google", label: "Google", mark: "G", supported: true },
  { providerId: "discord", label: "Discord", mark: "◉", supported: true },
  { providerId: "twitter", label: "Twitter / X", mark: "𝕏", supported: true },
  {
    providerId: "bluesky",
    label: "Bluesky",
    mark: "BS",
    supported: false,
    requirement: "Requires an AT Protocol OAuth adapter; profile links are available separately.",
  },
  {
    providerId: "fluxer",
    label: "Fluxer",
    mark: "F",
    supported: false,
    requirement: "Requires a supported Fluxer OAuth integration and registered application.",
  },
  {
    providerId: "stoat",
    label: "Stoat",
    mark: "S",
    supported: false,
    requirement: "Requires a supported Stoat identity integration and registered application.",
  },
] as const;
/** Compatibility for imported components. These are direct providers, never a broker. */
export const GROK_PROVIDERS = SOCIAL_PROVIDERS.filter((provider) => provider.supported);
