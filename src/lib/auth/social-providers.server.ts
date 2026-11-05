/** Credentials remain server-side. Each adapter needs its complete registered app pair. */
const environmentPrefixes = {
  google: "GOOGLE",
  discord: "DISCORD",
  twitter: "TWITTER",
  github: "GITHUB",
  twitch: "TWITCH",
} as const;

export type SupportedSocialProvider = keyof typeof environmentPrefixes;
type SocialProviderConfiguration = Partial<
  Record<SupportedSocialProvider, { clientId: string; clientSecret: string }>
>;

export function configuredSocialProviders(
  environment: Readonly<Record<string, string | undefined>>,
): SocialProviderConfiguration {
  const result: SocialProviderConfiguration = {};
  for (const provider of Object.keys(environmentPrefixes) as SupportedSocialProvider[]) {
    const prefix = environmentPrefixes[provider];
    const clientId = environment[`${prefix}_CLIENT_ID`]?.trim();
    const clientSecret = environment[`${prefix}_CLIENT_SECRET`]?.trim();
    if (clientId && clientSecret) result[provider] = { clientId, clientSecret };
  }
  return result;
}

export function socialProviderAvailability(
  configuration: SocialProviderConfiguration,
  authConfigured: boolean,
): Record<SupportedSocialProvider, boolean> {
  return Object.fromEntries(
    (Object.keys(environmentPrefixes) as SupportedSocialProvider[]).map((provider) => [
      provider,
      Boolean(authConfigured && configuration[provider]),
    ]),
  ) as Record<SupportedSocialProvider, boolean>;
}
