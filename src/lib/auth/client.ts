import { twoFactorClient, usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";
import { passkeyRequestSignal } from "./passkeys-browser";
import { isSupportedSocialProviderId } from "./providers";
import { requestSocialAuthorization } from "./social-authorization";

export const authClient = createAuthClient({
  disableDefaultFetchPlugins: true,
  plugins: [usernameClient(), twoFactorClient(), passkeyClient()],
  fetchOptions: {
    onRequest(context) {
      // The official client passes per-call signals only to verification. Also
      // cancel option generation before a stale account can open a native prompt.
      const signal = passkeyRequestSignal();
      if (signal && String(context.url).includes("/passkey/")) return { ...context, signal };
    },
  },
});
export const useSession = authClient.useSession;
export const authEnabled = true;
export { GROK_PROVIDERS, SOCIAL_PROVIDERS } from "./providers";
/** Sessions use HttpOnly same-origin cookies; no token is kept in browser storage. */
export function getBearerToken(): null {
  return null;
}
export async function signIn(providerId: string, options?: { callbackURL?: string }) {
  if (!isSupportedSocialProviderId(providerId))
    throw new Error("This sign-in service is not integrated.");
  const result = await requestSocialAuthorization(providerId, (signal) =>
    authClient.signIn.social({
      provider: providerId,
      callbackURL: options?.callbackURL ?? "/",
      errorCallbackURL: "/login",
      disableRedirect: true,
      fetchOptions: { signal, retry: 0 },
    }),
  );
  window.location.assign(result.kind === "two-factor" ? "/login?twoFactor=1" : result.url);
}
export async function signOut(redirectTo?: string) {
  const response = await authClient.signOut();
  if (response.error) throw new Error(response.error.message || "Sign-out failed.");
  if (redirectTo) window.location.assign(redirectTo);
}
