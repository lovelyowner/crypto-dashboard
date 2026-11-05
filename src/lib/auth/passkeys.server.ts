import { passkey } from "@better-auth/passkey";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import type { BetterAuthPlugin } from "better-auth";
import { isFreshAccountSession } from "./policy";
import { safeAccountReturnPath } from "./return-to";
import { passkeyConfiguration } from "./passkey-configuration";

export { passkeyConfiguration } from "./passkey-configuration";

export const PASSKEY_AUTHENTICATION_PATH = "/passkey/verify-authentication";
export const PASSKEY_REMEMBER_HEADER = "x-fathom-remember-me";

export function accountPasskeys(origin: string) {
  const configuration = passkeyConfiguration(origin);
  return passkey({
    rpID: configuration.rpID,
    rpName: "Fathom",
    origin: configuration.origin,
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
    registration: {
      requireSession: true,
      afterVerification({ verification }) {
        // The official plugin currently verifies UV as optional. Require the signed flag.
        if (!verification.registrationInfo?.userVerified)
          throw new APIError("FORBIDDEN", {
            message: "Verify your identity on the authenticator.",
          });
      },
    },
    authentication: {
      afterVerification({ verification }) {
        if (!verification.authenticationInfo.userVerified)
          throw new APIError("FORBIDDEN", {
            message: "Verify your identity on the authenticator.",
          });
      },
    },
  });
}

/** Use Better Auth's own challenge, attempt limits, TOTP, and recovery implementation. */
export function accountTwoFactor(origin?: string) {
  const plugin = twoFactor({
    issuer: "Fathom",
    totpOptions: { digits: 6, period: 30 },
    backupCodeOptions: { amount: 10, length: 16, storeBackupCodes: "encrypted" },
  });
  for (const hook of plugin.hooks.after) {
    const original = hook.matcher;
    hook.matcher = (ctx) =>
      ctx.path === PASSKEY_AUTHENTICATION_PATH ||
      ctx.path === "/sign-in/social" ||
      Boolean(ctx.path?.startsWith("/callback/")) ||
      original(ctx);
  }
  plugin.hooks.after.push({
    matcher: (ctx) => Boolean(ctx.path?.startsWith("/callback/")),
    handler: createAuthMiddleware(async (ctx) => {
      const result = ctx.context.returned;
      if (
        !result ||
        typeof result !== "object" ||
        !("twoFactorRedirect" in result) ||
        result.twoFactorRedirect !== true
      )
        return undefined;
      // The official hook has removed the temporary session and issued its signed
      // challenge cookie. Continue in our existing TOTP/recovery UI, not a JSON page.
      const canonical = origin ?? new URL(ctx.context.baseURL).origin;
      const login = new URL("/login", canonical);
      login.searchParams.set("twoFactor", "1");
      const previous = ctx.context.responseHeaders?.get("location");
      if (previous) {
        const target = new URL(previous, canonical);
        const next =
          target.origin === canonical
            ? safeAccountReturnPath(target.searchParams.get("next"))
            : null;
        if (next) login.searchParams.set("next", next);
      }
      throw ctx.redirect(login.href);
    }),
  });
  return plugin;
}

export function passkeyPolicyPlugin(origin: string): BetterAuthPlugin {
  const configuration = passkeyConfiguration(origin);
  return {
    id: "fathom-passkey-policy",
    rateLimit: [
      {
        pathMatcher: (path) =>
          path === PASSKEY_AUTHENTICATION_PATH || path === "/passkey/generate-authenticate-options",
        window: 60,
        max: 10,
      },
    ],
    hooks: {
      before: [
        {
          matcher: (ctx) => Boolean(ctx.path?.startsWith("/passkey/")),
          handler: createAuthMiddleware(async (ctx) => {
            if (!configuration.enabled)
              throw new APIError("FORBIDDEN", { message: "Passkeys require HTTPS or localhost." });
            const requestOrigin = ctx.headers?.get("origin");
            if (requestOrigin && !configuration.origin.includes(requestOrigin))
              throw new APIError("FORBIDDEN", { message: "Invalid passkey origin." });
            if (["/passkey/delete-passkey", "/passkey/update-passkey"].includes(ctx.path)) {
              const session = await getSessionFromCtx(ctx);
              if (!session)
                throw new APIError("UNAUTHORIZED", { message: "Sign in to manage passkeys." });
              if (!isFreshAccountSession(session.session.createdAt))
                throw new APIError("FORBIDDEN", {
                  message: "Sign in again before managing passkeys (within 10 minutes).",
                });
            }
            if (
              ctx.body?.name !== undefined &&
              (typeof ctx.body.name !== "string" ||
                !ctx.body.name.trim() ||
                ctx.body.name.length > 80)
            )
              throw new APIError("BAD_REQUEST", {
                message: "Use a passkey name of 1–80 characters.",
              });
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === "/passkey/generate-authenticate-options",
          handler: createAuthMiddleware(async (ctx) => {
            const result = ctx.context.returned;
            if (result && typeof result === "object" && "challenge" in result)
              return ctx.json({ ...result, userVerification: "required" });
          }),
        },
      ],
    },
  };
}
