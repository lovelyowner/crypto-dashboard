import { socialProviderLabel } from "./providers.js";

/** Initiation failures come from the same-origin account API, not callback query text. */
export function socialAuthError(
  provider: string,
  error: { code?: string; message?: string; status?: number },
): string {
  if (error.code === "ACCOUNT_SETUP_REQUIRED")
    return "Account sign-in is not set up on this website. Open Website sign-in setup for the required settings.";
  if (error.code === "PROVIDER_NOT_FOUND")
    return `${socialProviderLabel(provider)} sign-in is not enabled on this website. The website owner must register and configure its OAuth application.`;
  return (
    error.message?.trim() ||
    `Could not start ${socialProviderLabel(provider)} sign-in. Please try again.`
  );
}
