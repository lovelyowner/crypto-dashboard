import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { expireCookie } from "better-auth/cookies";
// Kept browser-safe; importing the server plugin here would pull WebAuthn verification into clients.
const passkeyLogin = "/passkey/verify-authentication";
const passkeyRememberHeader = "x-fathom-remember-me";
import {
  DEFAULT_SESSION_DURATION,
  SESSION_DURATION_HEADER,
  sessionDurationSeconds,
} from "./policy";

const startsLogin = (path = "") =>
  [
    "/sign-in/email",
    "/sign-in/username",
    "/sign-in/social",
    "/sign-up/email",
    passkeyLogin,
  ].includes(path);
const completesLogin = (path = "") =>
  startsLogin(path) || path.startsWith("/callback/") || path.startsWith("/two-factor/verify-");

/** The signed, short-lived cookie carries a bounded policy through 2FA/OAuth.
 * The database expiry is authoritative; changing a browser clock cannot extend it.
 * Keep this plugin after twoFactor so a pending challenge is never treated as a session.
 */
export function sessionDurationPlugin(): BetterAuthPlugin {
  return {
    id: "fathom-session-duration",
    init() {
      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                async before(_session, ctx) {
                  if (!ctx) return;
                  const cookie = ctx.context.createAuthCookie("login_duration", { maxAge: 600 });
                  const selection = startsLogin(ctx.path)
                    ? (ctx.headers?.get(SESSION_DURATION_HEADER) ?? DEFAULT_SESSION_DURATION)
                    : await ctx.getSignedCookie(cookie.name, ctx.context.secret);
                  // A lost or invalid continuation cookie gets the shortest policy.
                  const seconds = sessionDurationSeconds(selection) ?? 3600;
                  const deadline = Date.now() + seconds * 1000;
                  // Security actions can rotate a session, but must not extend its deadline.
                  const priorExpiry = ctx.context.session?.session.expiresAt.getTime();
                  return { data: { expiresAt: new Date(priorExpiry ?? deadline) } };
                },
              },
            },
          },
        },
      };
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => startsLogin(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const selection = ctx.headers?.get(SESSION_DURATION_HEADER) ?? DEFAULT_SESSION_DURATION;
            if (sessionDurationSeconds(selection) === null)
              throw new APIError("BAD_REQUEST", {
                message: "Choose a session duration of 1 hour, 1 day, or 7 days.",
              });
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => completesLogin(ctx.path) || ctx.path === "/sign-out",
          handler: createAuthMiddleware(async (ctx) => {
            const session = ctx.context.newSession;
            if (ctx.path === passkeyLogin) {
              const remember = ctx.headers?.get(passkeyRememberHeader) === "true";
              if (remember) expireCookie(ctx, ctx.context.authCookies.dontRememberToken);
              else
                await ctx.setSignedCookie(
                  ctx.context.authCookies.dontRememberToken.name,
                  "true",
                  ctx.context.secret,
                  ctx.context.authCookies.dontRememberToken.attributes,
                );
            }
            if (!session && startsLogin(ctx.path)) {
              const result = ctx.context.returned;
              if (
                result &&
                typeof result === "object" &&
                ("twoFactorRedirect" in result || "url" in result)
              ) {
                const cookie = ctx.context.createAuthCookie("login_duration", { maxAge: 600 });
                const selection =
                  ctx.headers?.get(SESSION_DURATION_HEADER) ?? DEFAULT_SESSION_DURATION;
                await ctx.setSignedCookie(
                  cookie.name,
                  selection,
                  ctx.context.secret,
                  cookie.attributes,
                );
              }
              return;
            }
            if (!session && ctx.path !== "/sign-out") return;
            expireCookie(ctx, ctx.context.createAuthCookie("login_duration", { maxAge: 600 }));
            if (!session) return;
            const dontRemember = startsLogin(ctx.path)
              ? ctx.path === passkeyLogin
                ? ctx.headers?.get(passkeyRememberHeader) !== "true"
                : ctx.body?.rememberMe === false
              : Boolean(
                  await ctx.getSignedCookie(
                    ctx.context.authCookies.dontRememberToken.name,
                    ctx.context.secret,
                  ),
                );
            const cookie = ctx.context.authCookies.sessionToken;
            const maxAge = Math.max(
              0,
              Math.floor((session.session.expiresAt.getTime() - Date.now()) / 1000),
            );
            // Replace the library's default 7-day cookie with this session's actual lifetime.
            // Clear only this cookie; OAuth, 2FA and CSRF cookies must be preserved.
            const headers = ctx.context.responseHeaders;
            if (headers) {
              const keep = headers
                .getSetCookie()
                .filter((line) => !line.startsWith(`${cookie.name}=`));
              headers.delete("set-cookie");
              for (const line of keep) headers.append("set-cookie", line);
            }
            await ctx.setSignedCookie(cookie.name, session.session.token, ctx.context.secret, {
              ...cookie.attributes,
              maxAge: dontRemember ? undefined : maxAge,
            });
          }),
        },
      ],
    },
  };
}
