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
