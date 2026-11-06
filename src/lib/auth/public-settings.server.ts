import { resolveDeploymentConfiguration } from "../deployment-config.js";
import { passkeyConfiguration } from "./passkey-configuration.js";
import { readAccountSetup } from "./setup.js";
import {
  configuredSocialProviders,
  socialProviderAvailability,
  socialSignInOrigin,
} from "./social-providers.server.js";

/** Public presence flags only. Reading these settings never initializes authentication or storage. */
export function readPublicAuthConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
  productionBuild = false,
) {
  const deployment = resolveDeploymentConfiguration(environment, productionBuild);
  const { authConfigured, authOrigin, production } = deployment;
  const passkeyOrigin = authOrigin ?? "http://localhost:8080";
  const socialProviders = configuredSocialProviders(environment);
  const signInOrigin = socialSignInOrigin(authOrigin, passkeyOrigin, production, socialProviders);
  const emailConfigured = Boolean(
    environment.RESEND_API_KEY?.trim() && environment.AUTH_EMAIL_FROM?.trim(),
  );
  return {
    configured: authConfigured,
    emailRecovery: authConfigured && emailConfigured,
    passkeys: authConfigured && passkeyConfiguration(passkeyOrigin).enabled,
    passkeyOrigin,
    providers: socialProviderAvailability(socialProviders, authConfigured),
    production,
    setup: readAccountSetup(environment, production),
    ...(signInOrigin ? { signInOrigin } : {}),
  };
}

/** Keep discovery available even when the authentication SDK or database cannot start. */
export async function handlePublicAuthConfigurationRequest(request: Request): Promise<Response> {
  const headers = {
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  if (request.method !== "GET")
    return Response.json(
      { message: "Method not allowed." },
      { status: 405, headers: { ...headers, allow: "GET" } },
    );
  return Response.json(readPublicAuthConfiguration(process.env, import.meta.env?.PROD === true), {
    headers,
  });
}
