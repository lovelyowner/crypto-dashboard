import { twoFactorClient, usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ plugins: [usernameClient(), twoFactorClient()] });
export const useSession = authClient.useSession;
export const authEnabled = true;
export { GROK_PROVIDERS, SOCIAL_PROVIDERS } from "./providers";
/** Sessions use HttpOnly same-origin cookies; no token is kept in browser storage. */
export function getBearerToken(): null {
  return null;
}
export async function signIn(providerId: string, options?: { callbackURL?: string }) {
  const response = await authClient.signIn.social({
    provider: providerId as "google" | "discord" | "twitter",
    callbackURL: options?.callbackURL ?? "/",
  });
  if (response.error) throw new Error(response.error.message || "Sign-in failed.");
}
export async function signOut(redirectTo?: string) {
  const response = await authClient.signOut();
  if (response.error) throw new Error(response.error.message || "Sign-out failed.");
  if (redirectTo) window.location.assign(redirectTo);
}
