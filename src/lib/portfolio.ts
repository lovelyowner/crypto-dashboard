import { isChainId, isValidAddress, activityKey, type ChainId } from "./chains";
import type { ChainActivity } from "./activity.functions";
export type PublicWatch = { chain: ChainId; address: string; label: string; pinned?: boolean };
export function parseWatchlist(input: unknown): PublicWatch[] {
  if (
    !input ||
    typeof input !== "object" ||
    !("version" in input) ||
    input.version !== 1 ||
    !("addresses" in input) ||
    !Array.isArray(input.addresses)
  )
    throw new Error("Choose a Fathom watchlist (version 1).");
  if (input.addresses.length > 100) throw new Error("A watchlist can contain up to 100 addresses.");
  const keys = new Set<string>();
  return input.addresses.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid address entry.");
    const r = item as Record<string, unknown>;
    if (
      typeof r.chain !== "string" ||
      !isChainId(r.chain) ||
      typeof r.address !== "string" ||
      !isValidAddress(r.chain, r.address) ||
      typeof r.label !== "string" ||
      r.label.length > 80 ||
      (r.pinned !== undefined && typeof r.pinned !== "boolean")
    )
      throw new Error("The watchlist contains an invalid network, address, or label.");
    const key = activityKey(r.chain, r.address);
    if (keys.has(key)) throw new Error("The watchlist contains a duplicate address.");
    keys.add(key);
    return {
      chain: r.chain,
      address: r.address.trim(),
      label: r.label,
      ...(typeof r.pinned === "boolean" ? { pinned: r.pinned } : {}),
    };
  });
}
export function portfolioSummary(results: ChainActivity[], total: number) {
  const good = results.filter((r) => r.ok);
  const priced = good.filter((r) => r.usd !== null);
  return {
    knownUsd: priced.reduce((sum, r) => sum + (r.usd ?? 0), 0),
    priced: priced.length,
    loaded: good.length,
    unavailable: results.filter((r) => !r.ok).length,
    complete: total > 0 && priced.length === total,
  };
}
export function csvCell(value: string) {
  return '"' + (/^[=+\-@\t\r]/.test(value) ? "'" + value : value).replaceAll('"', '""') + '"';
}
export function downloadFile(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
