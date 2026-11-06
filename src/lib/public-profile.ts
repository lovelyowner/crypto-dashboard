import { validateCreatorProfile, type CreatorProfile } from "./creator-profile.js";

/** This public URL handle is separate from the unrestricted Unicode sign-in name. */
export function normalizePublicHandle(value: unknown): string {
  if (typeof value !== "string" || value.length > 128)
    throw new Error("Choose a public handle of 3–32 letters, digits, underscores, or hyphens.");
  const handle = value.trim();
  // Test ASCII before lowercasing: Unicode lookalikes must not claim an ASCII URL.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,30}[A-Za-z0-9]$/.test(handle)) {
    throw new Error(
      "Use 3–32 letters, digits, underscores, or hyphens. Start and end with a letter or digit.",
    );
  }
  return handle.toLowerCase();
}

export interface PublicCreatorProfile {
  handle: string;
  profile: CreatorProfile;
  updatedAt: string;
}
export interface ProfilePublication extends PublicCreatorProfile {
  published: boolean;
}
export interface PublicationResponse {
  publication: ProfilePublication | null;
}

/** A claimed URL cannot be renamed or silently transferred to another account. */
export class PublicationConflictError extends Error {
  constructor(message = "This public handle is unavailable or differs from your existing handle.") {
    super(message);
    this.name = "PublicationConflictError";
  }
}

export function validatePublishableProfile(value: unknown): CreatorProfile {
  const profile = validateCreatorProfile(value);
  if (!profile.displayName.trim())
    throw new Error("Add a display name before publishing your profile.");
  return profile;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid public profile response.");
  return value as Record<string, unknown>;
}

/** Whitelists the response, never exposing account IDs or identity-provider details. */
export function validatePublicCreatorProfile(value: unknown): PublicCreatorProfile {
  const row = record(value);
  const handle = normalizePublicHandle(row.handle);
  if (row.handle !== handle) throw new Error("Invalid public profile handle.");
  if (typeof row.updatedAt !== "string" || !Number.isFinite(new Date(row.updatedAt).getTime()))
    throw new Error("Invalid public profile timestamp.");
  return {
    handle,
    profile: validatePublishableProfile(row.profile),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
export const validatePublicProfileResponse = validatePublicCreatorProfile;

export function validatePublication(value: unknown): ProfilePublication {
  const row = record(value);
  if (typeof row.published !== "boolean") throw new Error("Invalid profile publication state.");
  return { ...validatePublicCreatorProfile(row), published: row.published };
}

export function validatePublicationResponse(value: unknown): PublicationResponse {
  const row = record(value);
  return { publication: row.publication === null ? null : validatePublication(row.publication) };
}
