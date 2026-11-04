/** Accept an origin, never a path, credentials, query, or fragment. */
export function configuredAuthOrigin(
  value: string | undefined,
  production: boolean,
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (
      (production ? url.protocol !== "https:" : !["https:", "http:"].includes(url.protocol)) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
