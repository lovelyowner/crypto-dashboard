/** Exact RP host and origins, never derived from a request's Host/Origin header. */
export function passkeyConfiguration(origin: string) {
  const url = new URL(origin);
  const enabled =
    url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  return { enabled, rpID: url.hostname, origin: [url.origin] };
}
