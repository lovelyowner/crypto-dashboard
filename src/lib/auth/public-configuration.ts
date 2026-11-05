import { configuredAuthOrigin } from "./configuration";
import { SOCIAL_PROVIDERS } from "./providers";
import type { AccountSetup } from "./setup";

export type PublicAuthConfiguration = {
  configured: boolean;
  emailRecovery: boolean;
  providers: Record<string, boolean>;
  production: boolean;
  passkeys: boolean;
  passkeyOrigin?: string;
  signInOrigin?: string;
  setup?: AccountSetup;
};

export const AUTH_CONFIGURATION_TIMEOUT_MS = 8_000;
export const AUTH_CONFIGURATION_ERROR = "Sign-in options could not be loaded. Try again.";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Select public fields only; malformed availability must never enable a sign-in button. */
export function parsePublicAuthConfiguration(value: unknown): PublicAuthConfiguration {
  if (
    !record(value) ||
    typeof value.configured !== "boolean" ||
    typeof value.emailRecovery !== "boolean" ||
    typeof value.production !== "boolean" ||
    !record(value.providers) ||
    (value.passkeys !== undefined && typeof value.passkeys !== "boolean")
  )
    throw new Error(AUTH_CONFIGURATION_ERROR);

  const providers: Record<string, boolean> = {};
  for (const provider of SOCIAL_PROVIDERS) {
    if (!provider.supported) continue;
    const enabled = value.providers[provider.providerId];
    if (enabled !== undefined && typeof enabled !== "boolean")
      throw new Error(AUTH_CONFIGURATION_ERROR);
    providers[provider.providerId] = value.configured && enabled === true;
  }
  const origin =
    typeof value.passkeyOrigin === "string"
      ? configuredAuthOrigin(value.passkeyOrigin, value.production)
      : null;
  const signInOrigin =
    typeof value.signInOrigin === "string"
      ? configuredAuthOrigin(value.signInOrigin, value.production)
      : null;
  if (value.signInOrigin !== undefined && !signInOrigin) throw new Error(AUTH_CONFIGURATION_ERROR);
  let setup: AccountSetup | undefined;
  if (value.setup !== undefined) {
    const item = value.setup;
    if (
      !record(item) ||
      typeof item.environment !== "string" ||
      !["local", "preview", "production"].includes(item.environment) ||
      typeof item.database !== "boolean" ||
      typeof item.secret !== "boolean" ||
      typeof item.origin !== "boolean"
    )
      throw new Error(AUTH_CONFIGURATION_ERROR);
    setup = {
      environment: item.environment as AccountSetup["environment"],
      database: item.database,
      secret: item.secret,
      origin: item.origin,
    };
  }
  if (value.passkeys === true && value.configured && !origin)
    throw new Error(AUTH_CONFIGURATION_ERROR);
  return {
    configured: value.configured,
    emailRecovery: value.configured && value.emailRecovery,
    production: value.production,
    providers,
    passkeys: value.configured && value.passkeys === true,
    ...(origin ? { passkeyOrigin: origin } : {}),
    ...(signInOrigin ? { signInOrigin } : {}),
    ...(setup ? { setup } : {}),
  };
}

/** Bound the complete request, including body reading, even if a transport ignores abort. */
export async function loadPublicAuthConfiguration({
  signal,
  timeoutMs = AUTH_CONFIGURATION_TIMEOUT_MS,
  fetcher = fetch,
}: {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetcher?: typeof fetch;
} = {}): Promise<PublicAuthConfiguration> {
  if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => {
      controller.abort();
      reject(new DOMException("Request cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(AUTH_CONFIGURATION_ERROR));
    }, timeoutMs);
  });
  const request = (async () => {
    const response = await fetcher("/api/auth/config", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (
      !response.ok ||
      response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
        "application/json"
    )
      throw new Error(AUTH_CONFIGURATION_ERROR);
    const raw = await response.text();
    if (raw.length > 65_536) throw new Error(AUTH_CONFIGURATION_ERROR);
    return parsePublicAuthConfiguration(JSON.parse(raw));
  })();
  try {
    return await Promise.race([request, deadline]);
  } catch {
    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    throw new Error(AUTH_CONFIGURATION_ERROR);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
