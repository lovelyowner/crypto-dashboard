export function humanAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  const places = whole >= 1000n ? 2 : whole >= 1n ? 4 : 8;
  const fractionText = fraction
    .toString()
    .padStart(decimals, "0")
    .slice(0, places)
    .replace(/0+$/, "");
  const body = fractionText ? `${whole.toString()}.${fractionText}` : whole.toString();
  return negative ? `-${body}` : body;
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.01) return "<$0.01";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

export function shortAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

export function relativeTime(ms: number): string {
  if (!ms) return "Unconfirmed";
  const delta = Date.now() - ms;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "Just now";
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`;
  if (delta < day) return `${Math.floor(delta / hour)}h ago`;
  if (delta < 14 * day) return `${Math.floor(delta / day)}d ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(ms);
}

/** Transaction calendar dates use UTC consistently across browsers and CSV exports. */
export function formatTransactionDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "Unconfirmed";
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "Unconfirmed";
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = String(date.getUTCFullYear()).slice(-2).padStart(2, "0");
  return `${day}.${month}.${year}`;
}
