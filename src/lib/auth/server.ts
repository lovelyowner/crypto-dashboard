/** Server-only, same-origin authentication. No platform broker or embedded OAuth credentials. */
import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { getPglite } from "../db.js";
import { pgliteDialect } from "./pglite-dialect.js";
import {
  isValidUsername,
  normalizeUsername,
  ACCOUNT_SESSION_POLICY,
  ACCOUNT_RATE_LIMIT_POLICY,
} from "./policy.js";
import { sessionDurationPlugin } from "./session-duration.js";
import { resolveDeploymentConfiguration } from "../deployment-config.js";
import { configuredSocialProviders } from "./social-providers.server.js";
import { readPublicAuthConfiguration } from "./public-settings.server.js";
import { accountPasskeys, accountTwoFactor, passkeyPolicyPlugin } from "./passkeys.server.js";
import { identifierSignIn } from "./identifier-sign-in.server.js";

const env = (name: string) => process.env[name]?.trim() || undefined;
const deployment = resolveDeploymentConfiguration(process.env, import.meta.env?.PROD === true);
export const authIsProduction = deployment.production;
const production = authIsProduction;
export const authOrigin = deployment.authOrigin;
const explicitBaseURL = authOrigin;
const passkeyOrigin = explicitBaseURL ?? "http://localhost:8080";
const databaseUrl = deployment.databaseUrl;
const configuredSecret = deployment.authSecret;
export const authConfigured = deployment.authConfigured;

function developmentSecret(): string {
  const directory = join(process.cwd(), ".local");
  const path = join(directory, "auth-secret");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readFileSync(path, "utf8").trim();
}
const secret =
  configuredSecret ?? (production ? randomBytes(32).toString("hex") : developmentSecret());

const socialProviders = configuredSocialProviders(process.env);
const emailConfigured = Boolean(env("RESEND_API_KEY") && env("AUTH_EMAIL_FROM"));

export function publicAuthConfiguration() {
  return readPublicAuthConfiguration(process.env, import.meta.env?.PROD === true);
}

async function sendEmail(to: string, subject: string, url: string) {
  if (!emailConfigured) throw new Error("Email delivery has not been configured.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("RESEND_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env("AUTH_EMAIL_FROM"),
      to,
      subject,
      text: `${subject}\n\n${url}\n\nIf you did not request this, ignore this email.`,
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error("Email could not be delivered. Please retry later.");
}

export const auth = betterAuth({
  appName: "Fathom",
  secret,
  baseURL: explicitBaseURL ?? "http://localhost:8080",
  trustedOrigins: explicitBaseURL
    ? [explicitBaseURL]
    : ["http://localhost:8080", "http://127.0.0.1:8080"],
  onAPIError: { errorURL: new URL("/login", passkeyOrigin).href },
  database: databaseUrl
    ? new Pool({ connectionString: databaseUrl })
    : { dialect: pgliteDialect(() => getPglite()), type: "postgres" as const },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 256,
    revokeSessionsOnPasswordReset: true,
    ...(emailConfigured
      ? {
          sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) =>
            sendEmail(user.email, "Reset your Fathom password", url),
        }
      : {}),
  },
  ...(emailConfigured
    ? {
        emailVerification: {
          sendOnSignUp: true,
          sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) =>
            sendEmail(user.email, "Verify your Fathom email", url),
        },
      }
    : {}),
  socialProviders,
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      disableImplicitLinking: true,
      allowDifferentEmails: false,
      allowUnlinkingAll: false,
    },
  },
  session: ACCOUNT_SESSION_POLICY,
  rateLimit: ACCOUNT_RATE_LIMIT_POLICY,
  advanced: { cookiePrefix: "fathom", useSecureCookies: production },
  plugins: [
    identifierSignIn(),
    username({
      minUsernameLength: 1,
      maxUsernameLength: 128,
      usernameValidator: isValidUsername,
      usernameNormalization: normalizeUsername,
      displayUsernameNormalization: normalizeUsername,
    }),
    accountPasskeys(passkeyOrigin),
    passkeyPolicyPlugin(passkeyOrigin),
    accountTwoFactor(passkeyOrigin),
    sessionDurationPlugin(),
  ],
});

/** Server-only key material for encrypting creator-owned provider credentials. */
export function getAuthEncryptionSecret(): string {
  return secret;
}

export const SESSION_TOKEN_COOKIE = production
  ? "__Secure-fathom.session_token"
  : "fathom.session_token";
export { GROK_PROVIDERS } from "./providers.js";
