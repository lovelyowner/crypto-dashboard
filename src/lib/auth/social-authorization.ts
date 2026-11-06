import { socialProviderLabel, type SupportedSocialProviderId } from "./providers.js";
import { socialAuthError } from "./social-error.js";

export const SOCIAL_AUTHORIZATION_TIMEOUT_MS = 12_000;

const authorizationEndpoints: Record<SupportedSocialProviderId, readonly string[]> = {
  google: ["https://accounts.google.com/o/oauth2/v2/auth"],
  discord: ["https://discord.com/api/oauth2/authorize", "https://discord.com/oauth2/authorize"],
  twitter: ["https://x.com/i/oauth2/authorize"],
  github: ["https://github.com/login/oauth/authorize"],
  twitch: ["https://id.twitch.tv/oauth2/authorize"],
};

type Authorization = { kind: "redirect"; url: string } | { kind: "two-factor" };

class SocialAuthorizationError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cancelled() {
  return new DOMException("Sign-in request cancelled.", "AbortError");
}

function readAuthorization(provider: SupportedSocialProviderId, result: unknown): Authorization {
  const label = socialProviderLabel(provider);
  if (record(result) && result.error) {
    const error = record(result.error) ? result.error : {};
    throw new SocialAuthorizationError(
      socialAuthError(provider, {
        ...(typeof error.code === "string" ? { code: error.code } : {}),
        ...(typeof error.message === "string" ? { message: error.message } : {}),
        ...(typeof error.status === "number" ? { status: error.status } : {}),
      }),
    );
  }
  const data = record(result) && record(result.data) ? result.data : null;
  if (data?.twoFactorRedirect === true) return { kind: "two-factor" };
  if (typeof data?.url !== "string" || !data.url.trim())
    throw new SocialAuthorizationError(
      `${label} did not return an authorization link. Please try again.`,
    );
  try {
    const url = new URL(data.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      data.url.includes("#") ||
      !authorizationEndpoints[provider].includes(url.origin + url.pathname)
    )
      throw new Error("Invalid authorization endpoint.");
    return { kind: "redirect", url: url.href };
  } catch {
    throw new SocialAuthorizationError(
      `${label} returned an invalid authorization link. Please try again.`,
    );
  }
}

/** Bound initiation, response/body parsing, and SDK hooks; never navigate from a late response. */
export async function requestSocialAuthorization(
  provider: SupportedSocialProviderId,
  initiate: (signal: AbortSignal) => Promise<unknown>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Authorization> {
  if (options.signal?.aborted) throw cancelled();
  const controller = new AbortController();
  const label = socialProviderLabel(provider);
  const requestedTimeout = options.timeoutMs ?? SOCIAL_AUTHORIZATION_TIMEOUT_MS;
  const timeoutMs =
    Number.isFinite(requestedTimeout) && requestedTimeout >= 0
      ? requestedTimeout
      : SOCIAL_AUTHORIZATION_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let cancel = () => {};
  const timeoutError = () =>
    new SocialAuthorizationError(`${label} sign-in took too long. Please try again.`);
  const deadline = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      controller.abort();
      reject(cancelled());
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  const operation = Promise.resolve()
    .then(() => {
      if (controller.signal.aborted) throw cancelled();
      return initiate(controller.signal);
    })
    .then((result) => {
      if (controller.signal.aborted) throw cancelled();
      return readAuthorization(provider, result);
    });
  try {
    return await Promise.race([operation, deadline]);
  } catch (cause) {
    if (options.signal?.aborted) throw cancelled();
    if (timedOut) throw timeoutError();
    if (
      cause instanceof SocialAuthorizationError ||
      (cause instanceof Error && cause.name === "AbortError")
    )
      throw cause;
    throw new SocialAuthorizationError(`${label} sign-in is unavailable. Please try again.`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
