/** Usernames are NFC-normalized and case-sensitive. Passwords follow Better Auth’s built-in Unicode NFKC normalization. */
export function normalizeUsername(username: string): string {
  return username.normalize("NFC");
}

export function isValidUsername(username: string): boolean {
  const normalized = normalizeUsername(username);
  const length = Array.from(normalized).length;
  return (
    length >= 1 &&
    length <= 64 &&
    normalized.trim() === normalized &&
    !/[\p{Cc}\p{Cs}\p{Cf}]/u.test(normalized)
  );
}

/** Adding a password requires a recent session, independent of cookie lifetime. */
export function isFreshAccountSession(createdAt: Date | string, now = Date.now()): boolean {
  const created = new Date(createdAt).getTime();
  const age = now - created;
  return Number.isFinite(created) && age >= 0 && age < 10 * 60_000;
}

/** Absolute server expiry; activity does not roll the deadline forward. */
export const ACCOUNT_SESSION_POLICY = {
  expiresIn: 60 * 60 * 24 * 7,
  freshAge: 60 * 10,
  disableSessionRefresh: true,
} as const;

/** Shared PostgreSQL counters protect every serverless instance. */
export const ACCOUNT_RATE_LIMIT_POLICY = {
  enabled: true,
  storage: "database",
  window: 60,
  max: 100,
  customRules: {
    "/sign-in/*": { window: 60, max: 10 },
    "/sign-up/*": { window: 60, max: 5 },
    "/two-factor/*": { window: 60, max: 10 },
    "/request-password-reset": { window: 60, max: 3 },
    "/send-verification-email": { window: 60, max: 3 },
  },
} as const;

export const SESSION_DURATION_OPTIONS = [
  { value: "1h", label: "1 hour", seconds: 60 * 60 },
  { value: "1d", label: "1 day", seconds: 24 * 60 * 60 },
  { value: "7d", label: "7 days", seconds: 7 * 24 * 60 * 60 },
] as const;
export type SessionDuration = (typeof SESSION_DURATION_OPTIONS)[number]["value"];
export const DEFAULT_SESSION_DURATION: SessionDuration = "1d";
export const SESSION_DURATION_HEADER = "x-fathom-session-duration";
export function sessionDurationSeconds(value: unknown): number | null {
  return SESSION_DURATION_OPTIONS.find((option) => option.value === value)?.seconds ?? null;
}
