import { normalizePublicHandle } from "./public-profile";

/** Application entry points cannot be claimed as new top-level creator IDs. */
export const RESERVED_ROOT_HANDLES = [
  "account",
  "accounts",
  "activity",
  "admin",
  "api",
  "assets",
  "auth",
  "dashboard",
  "inbox",
  "login",
  "logout",
  "messages",
  "networks",
  "profile",
  "public",
  "settings",
  "signin",
  "signup",
  "site",
  "static",
  "support",
  "u",
  "wallets",
] as const;
const reserved = new Set<string>(RESERVED_ROOT_HANDLES);

export function isReservedRootHandle(value: string): boolean {
  return reserved.has(value.trim().toLowerCase());
}

/** Old reserved IDs keep their original /u/ address instead of shadowing an app page. */
export function getPublicProfilePath(value: string): string {
  const handle = normalizePublicHandle(value);
  return `${isReservedRootHandle(handle) ? "/u/" : "/"}${encodeURIComponent(handle)}`;
}

/** Resolve only public profile pages; static files and application routes stay separate. */
export function publicHandleFromPath(pathname: string, protocol = "https:"): string | null {
  if (protocol !== "https:" && protocol !== "http:") return null;
  const legacy = /^\/u\/([^/]+)\/?$/.exec(pathname);
  const root = /^\/([^/]+)\/?$/.exec(pathname);
  const part = legacy?.[1] ?? root?.[1];
  if (part === undefined) return null;
  try {
    const handle = normalizePublicHandle(decodeURIComponent(part));
    return !legacy && isReservedRootHandle(handle) ? null : handle;
  } catch {
    // Keep malformed legacy profile URLs on the read-only missing-page screen.
    return legacy ? "" : null;
  }
}

// Explicit case pairs keep reservations safe even if the host's route matching
// is case-sensitive. Every group is non-capturing for Vercel's path matcher.
const reservedPattern = RESERVED_ROOT_HANDLES.map((handle) =>
  [...handle].map((letter) => `[${letter}${letter.toUpperCase()}]`).join(""),
).join("|");
export const ROOT_PROFILE_HANDLE_PATTERN = `(?!(?:${reservedPattern})(?:/|$))[A-Za-z0-9][A-Za-z0-9_-]{1,30}[A-Za-z0-9]`;
export const ROOT_PROFILE_ROUTE_SOURCE = `/:handle(${ROOT_PROFILE_HANDLE_PATTERN})`;
