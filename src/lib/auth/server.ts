/** Server-only, same-origin authentication. No platform broker or embedded OAuth credentials. */
import { betterAuth } from "better-auth";
import { twoFactor, username } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { getCookie } from "@tanstack/react-start/server";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { getPglite } from "../db";
import { pgliteDialect } from "./pglite-dialect";
import { isValidUsername, normalizeUsername, ACCOUNT_SESSION_POLICY } from "./policy";

const env = (name: string) => process.env[name]?.trim() || undefined;
export const authIsProduction = import.meta.env.PROD || env("NODE_ENV") === "production";
const production = authIsProduction;
const explicitBaseURL = env("BETTER_AUTH_URL");
const databaseUrl = env("DATABASE_URL");
const configuredSecret = env("BETTER_AUTH_SECRET");
export const authConfigured =
  !production ||
  Boolean(
    databaseUrl &&
    configuredSecret &&
    configuredSecret.length >= 32 &&
    explicitBaseURL?.startsWith("https://"),
  );

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

const googleId = env("GOOGLE_CLIENT_ID"),
  googleSecret = env("GOOGLE_CLIENT_SECRET");
const discordId = env("DISCORD_CLIENT_ID"),
  discordSecret = env("DISCORD_CLIENT_SECRET");
const twitterId = env("TWITTER_CLIENT_ID"),
  twitterSecret = env("TWITTER_CLIENT_SECRET");
const emailConfigured = Boolean(env("RESEND_API_KEY") && env("AUTH_EMAIL_FROM"));

export function publicAuthConfiguration() {
  return {
    configured: authConfigured,
    emailRecovery: emailConfigured,
    providers: {
      google: Boolean(googleId && googleSecret),
      discord: Boolean(discordId && discordSecret),
      twitter: Boolean(twitterId && twitterSecret),
    },
    production,
  };
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
  socialProviders: {
    ...(googleId && googleSecret
      ? { google: { clientId: googleId, clientSecret: googleSecret } }
      : {}),
    ...(discordId && discordSecret
      ? { discord: { clientId: discordId, clientSecret: discordSecret } }
      : {}),
    ...(twitterId && twitterSecret
      ? { twitter: { clientId: twitterId, clientSecret: twitterSecret } }
      : {}),
  },
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
  rateLimit: {
    enabled: true,
    storage: "memory",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/*": { window: 60, max: 10 },
      "/sign-up/*": { window: 60, max: 5 },
      "/two-factor/*": { window: 60, max: 10 },
      "/request-password-reset": { window: 60, max: 3 },
      "/send-verification-email": { window: 60, max: 3 },
    },
  },
  advanced: { cookiePrefix: "fathom", useSecureCookies: production },
  plugins: [
    username({
      minUsernameLength: 1,
      maxUsernameLength: 128,
      usernameValidator: isValidUsername,
      usernameNormalization: normalizeUsername,
      displayUsernameNormalization: normalizeUsername,
    }),
    twoFactor({
      issuer: "Fathom",
      totpOptions: { digits: 6, period: 30 },
      backupCodeOptions: { amount: 10, length: 10, storeBackupCodes: "encrypted" },
    }),
    tanstackStartCookies(),
  ],
});

export const SESSION_TOKEN_COOKIE = production
  ? "__Secure-fathom.session_token"
  : "fathom.session_token";
export function readSessionToken(): string | null {
  return getCookie(SESSION_TOKEN_COOKIE) ?? null;
}
export { GROK_PROVIDERS } from "./providers";
