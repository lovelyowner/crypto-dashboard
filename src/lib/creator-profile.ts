import { isChainId, isValidAddress, normalizeAddress, type ChainId } from "./chains.js";

export type ProfileLink = { id: string; label: string; url: string };
export type WishlistItem = {
  id: string;
  title: string;
  url: string;
  price: string;
  currency: string;
};
export type DonationAddress = {
  id: string;
  chain: ChainId;
  address: string;
  label: string;
};
export type CreatorProfile = {
  version: 1;
  displayName: string;
  bio: string;
  links: ProfileLink[];
  wishlist: WishlistItem[];
  serviceLinks: {
    allmylinks: string;
    throne: string;
    nowpayments: string;
    bluesky: string;
  };
  donations: { bankLink: string; crypto: DonationAddress[] };
};
export type CreatorProfileData = CreatorProfile;

export const DEFAULT_CREATOR_PROFILE: CreatorProfile = {
  version: 1,
  displayName: "",
  bio: "",
  links: [],
  wishlist: [],
  serviceLinks: { allmylinks: "", throne: "", nowpayments: "", bluesky: "" },
  donations: { bankLink: "", crypto: [] },
};

export const CREATOR_PROFILE_MAX_BYTES = 50_000;
const MAX_SHARE_LENGTH = Math.ceil((CREATOR_PROFILE_MAX_BYTES * 4) / 3);
const encoder = new TextEncoder();
const serviceHosts = {
  allmylinks: "allmylinks.com",
  throne: "throne.com",
  nowpayments: "nowpayments.io",
  bluesky: "bsky.app",
} as const;
const reservedHostEndings = new Set([
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "test",
  "invalid",
  "example",
  "home",
  "lan",
  "corp",
  "onion",
  "alt",
  "arpa",
]);
const credentialParameters = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "auth_token",
  "session",
  "session_token",
  "password",
  "passwd",
  "api_key",
  "apikey",
  "client_secret",
  "secret",
  "private_key",
  "mnemonic",
  "seed",
  "recovery_phrase",
]);
// eslint-disable-next-line no-control-regex -- Explicitly reject hidden controls in public single-line text.
const singleLineControls = /[\u0000-\u001f\u007f-\u009f\u200b\u202a-\u202e\u2066-\u2069\ufeff]/u;
const multilineControls =
  // eslint-disable-next-line no-control-regex -- Multiline bios allow line breaks and tabs, but reject other hidden controls.
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u202a-\u202e\u2066-\u2069\ufeff]/u;
// eslint-disable-next-line no-control-regex -- Control characters and backslashes must not be normalized into clickable URLs.
const unsafeUrlCharacters = /[\s\\\u0000-\u001f\u007f]/u;

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, limit: number, multiline = false): string {
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  // Count Unicode code points, preserving emoji and non-Latin names.
  if (value.length > limit * 2 || [...value].length > limit) {
    throw new Error(`${field} must be at most ${limit} characters.`);
  }
  const invalidControls = multiline ? multilineControls : singleLineControls;
  if (
    invalidControls.test(value) ||
    [...value].some((c) => c.length === 1 && /[\ud800-\udfff]/u.test(c))
  ) {
    throw new Error(`${field} contains unsupported control characters.`);
  }
  return multiline ? value.replace(/\r\n?/g, "\n") : value;
}

function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    throw new Error(`${field} must have a valid ID.`);
  }
  return value;
}

function hasCredentialParameters(parameters: URLSearchParams): boolean {
  return [...parameters.keys()].some((key) => credentialParameters.has(key.toLowerCase()));
}

/** Validates an external link without resolving or fetching its destination. */
export function validatePublicProfileUrl(value: unknown, field = "Link", optional = false): string {
  if (typeof value !== "string") throw new Error(`${field} must be a URL.`);
  const trimmed = value.trim();
  if (optional && !trimmed) return "";
  if (!trimmed || trimmed.length > 2_048 || unsafeUrlCharacters.test(trimmed)) {
    throw new Error(`${field} must be a public HTTPS URL of at most 2048 characters.`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${field} must be a valid HTTPS URL.`);
  }
  const hostname = url.hostname.toLowerCase();
  const labels = hostname.split(".");
  // IP literals include URL-normalized decimal, octal and hexadecimal IPv4 forms.
  const validHost =
    labels.length >= 2 &&
    !hostname.endsWith(".") &&
    !/^[\d.]+$/.test(hostname) &&
    !hostname.includes(":") &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    !reservedHostEndings.has(labels.at(-1)!) &&
    !labels.includes("localhost") &&
    labels.at(-1)!.length >= 2 &&
    !/^\d+$/.test(labels.at(-1)!);
  if (url.protocol !== "https:" || url.username || url.password || !validHost) {
    throw new Error(`${field} must use HTTPS and a public domain, without login credentials.`);
  }
  if (
    hasCredentialParameters(url.searchParams) ||
    (url.hash.includes("=") && hasCredentialParameters(new URLSearchParams(url.hash.slice(1))))
  ) {
    throw new Error(`${field} must not contain account credentials or recovery information.`);
  }
  const normalized = url.href;
  if (normalized.length > 2_048) throw new Error(`${field} must be at most 2048 characters.`);
  return normalized;
}

function serviceUrl(value: unknown, service: keyof typeof serviceHosts): string {
  const normalized = validatePublicProfileUrl(value, `${service} link`, true);
  if (!normalized) return "";
  const hostname = new URL(normalized).hostname;
  const expected = serviceHosts[service];
  if (hostname !== expected && hostname !== `www.${expected}`) {
    throw new Error(`${service} link must use ${expected}.`);
  }
  return normalized;
}

function list<T>(
  value: unknown,
  field: string,
  limit: number,
  validate: (entry: unknown) => T & { id: string },
): T[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`${field} must be a list of at most ${limit} items.`);
  }
  const ids = new Set<string>();
  return value.map((entry) => {
    const checked = validate(entry);
    if (ids.has(checked.id)) throw new Error(`${field} must have unique item IDs.`);
    ids.add(checked.id);
    return checked;
  });
}

function link(value: unknown): ProfileLink {
  const input = record(value, "Profile link");
  const label = text(input.label, "Link label", 80);
  if (!label.trim()) throw new Error("Link label must not be empty.");
  return { id: id(input.id, "Profile link"), label, url: validatePublicProfileUrl(input.url) };
}

function wishlistItem(value: unknown): WishlistItem {
  const input = record(value, "Wishlist item");
  const title = text(input.title, "Wishlist title", 120);
  if (!title.trim()) throw new Error("Wishlist title must not be empty.");
  const price = input.price === undefined ? "" : input.price;
  if (typeof price !== "string" || (price !== "" && !/^\d{1,12}(?:\.\d{1,8})?$/.test(price))) {
    throw new Error(
      "Wishlist price must be empty or a nonnegative decimal with at most 12 integer and 8 decimal digits.",
    );
  }
  const currency = input.currency === undefined ? "USD" : input.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error("Wishlist currency must be a three-letter uppercase currency code.");
  }
  return {
    id: id(input.id, "Wishlist item"),
    title,
    url: validatePublicProfileUrl(input.url, "Wishlist link"),
    price,
    currency,
  };
}

function donationAddress(value: unknown): DonationAddress {
  const input = record(value, "Donation address");
  if (typeof input.chain !== "string" || !isChainId(input.chain)) {
    throw new Error("Donation address must use a supported blockchain.");
  }
  if (typeof input.address !== "string" || !isValidAddress(input.chain, input.address)) {
    throw new Error("Donation address must be a valid public address for its blockchain.");
  }
  return {
    id: id(input.id, "Donation address"),
    chain: input.chain,
    address: normalizeAddress(input.chain, input.address),
    label: text(input.label, "Donation label", 80),
  };
}

/** Returns a new object containing only public profile fields, never account or wallet secrets. */
export function validateCreatorProfile(value: unknown): CreatorProfile {
  const input = record(value, "Creator profile");
  if (input.version !== 1) throw new Error("Unsupported creator profile version.");
  const services = record(input.serviceLinks, "Service links");
  // Profiles saved before donations were added remain importable.
  const donations =
    input.donations === undefined
      ? { bankLink: "", crypto: [] }
      : record(input.donations, "Donations");
  const crypto = list(donations.crypto, "Crypto donation addresses", 10, donationAddress);
  const addresses = new Set<string>();
  for (const donation of crypto) {
    const key = `${donation.chain}:${donation.address}`;
    if (addresses.has(key))
      throw new Error("Crypto donation addresses must not repeat on the same blockchain.");
    addresses.add(key);
  }
  const profile: CreatorProfile = {
    version: 1,
    displayName: text(input.displayName, "Display name", 80),
    bio: text(input.bio, "Bio", 500, true),
    links: list(input.links, "Profile links", 20, link),
    wishlist: list(input.wishlist, "Wishlist", 20, wishlistItem),
    serviceLinks: {
      allmylinks: serviceUrl(services.allmylinks, "allmylinks"),
      throne: serviceUrl(services.throne, "throne"),
      nowpayments: serviceUrl(services.nowpayments, "nowpayments"),
      bluesky: serviceUrl(services.bluesky, "bluesky"),
    },
    donations: {
      bankLink: validatePublicProfileUrl(donations.bankLink, "Bank donation link", true),
      crypto,
    },
  };
  if (encoder.encode(JSON.stringify(profile)).byteLength > CREATOR_PROFILE_MAX_BYTES) {
    throw new Error("Creator profile exceeds the 50 KB public profile limit.");
  }
  return profile;
}

export function serializeCreatorProfile(value: unknown): string {
  return JSON.stringify(validateCreatorProfile(value));
}

export function parseCreatorProfile(source: string): CreatorProfile {
  if (
    typeof source !== "string" ||
    source.length > CREATOR_PROFILE_MAX_BYTES ||
    encoder.encode(source).byteLength > CREATOR_PROFILE_MAX_BYTES
  ) {
    throw new Error("Creator profile file must be at most 50 KB.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Creator profile file must contain valid JSON.");
  }
  return validateCreatorProfile(parsed);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function encodeProfileShare(value: unknown): string {
  return base64url(encoder.encode(JSON.stringify(validateCreatorProfile(value))));
}

export function decodeProfileShare(encoded: string): CreatorProfile {
  if (
    typeof encoded !== "string" ||
    !encoded ||
    encoded.length > MAX_SHARE_LENGTH ||
    encoded.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw new Error("Shared creator profile is invalid or too large.");
  }
  let source: string;
  try {
    const padded =
      encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (encoded.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    if (bytes.byteLength > CREATOR_PROFILE_MAX_BYTES || base64url(bytes) !== encoded) {
      throw new Error("Invalid shared profile encoding.");
    }
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Shared creator profile is invalid or too large.");
  }
  return parseCreatorProfile(source);
}
