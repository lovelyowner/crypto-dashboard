import { getPublicProfilePath, publicHandleFromPath } from "../profile-url.js";

/** Authentication may return only to a validated creator page on this site. */
export function safeAccountReturnPath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\s]/u.test(value)
  )
    return null;
  try {
    const url = new URL(value, "https://fathom.invalid");
    if (url.origin !== "https://fathom.invalid" || url.search || url.hash) return null;
    const handle = publicHandleFromPath(url.pathname);
    return handle ? getPublicProfilePath(handle) : null;
  } catch {
    return null;
  }
}
