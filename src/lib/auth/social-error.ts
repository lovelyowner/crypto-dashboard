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
  const message = error.message?.trim();
  if (message) return message;
  const label = socialProviderLabel(provider);
  if (error.status === 401 || error.status === 403)
    return `${label} sign-in was blocked by this website (HTTP ${error.status}). Open the configured sign-in website in a full browser tab, or ask the website owner to check deployment access.`;
  if (error.status === 404)
    return `${label} sign-in could not reach the account API (HTTP 404). The website owner needs to check API routing in the deployed version.`;
  if (error.status === 429)
    return `${label} sign-in has too many attempts (HTTP 429). Wait before trying again.`;
  if (
    typeof error.status === "number" &&
    Number.isInteger(error.status) &&
    error.status >= 500 &&
    error.status <= 599
  )
    return `${label} sign-in failed because this website’s account server is unavailable (HTTP ${error.status}). Try again, or ask the website owner to check the deployment’s function logs.`;
  if (
    typeof error.status === "number" &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 499
  )
    return `${label} sign-in request failed (HTTP ${error.status}). Please try again.`;
  return `Could not start ${label} sign-in. Please try again.`;
}
