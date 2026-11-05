import { isValidAddress, normalizeAddress } from "./chains";
import type { TokenWatch } from "./token-watch";

const ETHEREUM_RPC = "https://ethereum-rpc.publicnode.com";
const SOLANA_RPC = "https://solana-rpc.publicnode.com";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SPL_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type TokenBalance =
  | {
      status: "ready";
      rawAmount: string;
      decimals: number;
      amount: string;
      symbol: string | null;
      name: string | null;
      metadataUnavailable: boolean;
      accountCount?: number;
      program?: "SPL Token" | "Token-2022";
      updatedAt: number;
    }
  | { status: "unavailable" | "unsupported"; message: string; updatedAt: number };

class TokenReadError extends Error {
  constructor(
    readonly status: "unavailable" | "unsupported",
    message: string,
  ) {
    super(message);
  }
}
function unsupported(
  message = "This token's public balance data is unsupported or malformed.",
): never {
  throw new TokenReadError("unsupported", message);
}
function unavailable(): never {
  throw new TokenReadError(
    "unavailable",
    "Public RPC unavailable. Browser access, rate limits, or the provider may be blocking this read. Try refreshing later.",
  );
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) unsupported();
  return value as Record<string, unknown>;
}
function decimals(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255)
    unsupported(
      "Token decimals are unavailable or unsupported; no balance can be displayed safely.",
    );
  return value;
}
function integer(value: unknown, maximum: bigint): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value)) unsupported();
  const amount = BigInt(value);
  if (amount > maximum) unsupported();
  return amount;
}
function abiUint(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) unsupported();
  return BigInt(value);
}

function publicTokenExtensions(info: Record<string, unknown>): void {
  if (!Object.hasOwn(info, "extensions")) return;
  if (!Array.isArray(info.extensions) || info.extensions.length > 64)
    unsupported("The RPC returned malformed token extension data; this balance is unsupported.");
  const seen = new Set<string>();
  for (const value of info.extensions) {
    const extension = record(value);
    if (
      typeof extension.extension !== "string" ||
      !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(extension.extension)
    )
      unsupported("The RPC returned malformed token extension data; this balance is unsupported.");
    const name = extension.extension.toLowerCase();
    if (seen.has(name)) unsupported("The RPC returned duplicate token extension data.");
    seen.add(name);
    if (name === "unparseableextension")
      unsupported("The RPC could not parse a Token-2022 extension; this balance is unsupported.");
    if (name.startsWith("confidential"))
      unsupported(
        "Confidential Token-2022 balances are unsupported; public amounts may omit hidden balances.",
      );
    if (name.startsWith("interestbearing") || name.startsWith("scaleduiamount"))
      unsupported("This Token-2022 extension changes displayed token amounts and is unsupported.");
    if (Object.hasOwn(extension, "state")) record(extension.state);
  }
}

/** Decimal arithmetic stays in integers; this never rounds even very small or large balances. */
export function formatExactTokenAmount(rawAmount: string, places: number): string {
  const amount = integer(rawAmount, MAX_UINT256).toString();
  decimals(places);
  if (!places) return amount;
  const padded = amount.padStart(places + 1, "0");
  const fraction = padded.slice(-places).replace(/0+$/, "");
  return fraction ? `${padded.slice(0, -places)}.${fraction}` : padded.slice(0, -places);
}

/** Supports ABI strings and legacy bytes32 metadata, with bounded UTF-8 and no control text. */
export function decodeTokenText(value: unknown, maximum = 64): string | null {
  if (
    typeof value !== "string" ||
    value.length > 2 + 64 * 8 ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)
  )
    return null;
  try {
    const hex = value.slice(2);
    let textHex: string;
    if (hex.length === 64) {
      const firstNull = hex.search(/(?:00)+$/);
      textHex = firstNull < 0 ? hex : hex.slice(0, firstNull);
    } else {
      if (hex.length < 128 || BigInt(`0x${hex.slice(0, 64)}`) !== 32n) return null;
      const size = BigInt(`0x${hex.slice(64, 128)}`);
      if (size < 1n || size > BigInt(maximum)) return null;
      const length = Number(size) * 2;
      const padded = Math.ceil(Number(size) / 32) * 64;
      if (hex.length !== 128 + padded || !/^0*$/.test(hex.slice(128 + length))) return null;
      textHex = hex.slice(128, 128 + length);
    }
    if (!textHex || textHex.length > maximum * 2) return null;
    const bytes = new Uint8Array(textHex.match(/../g)!.map((byte) => parseInt(byte, 16)));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    if (!text || text.length > maximum || /[\p{Cc}\p{Cf}]/u.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    unavailable();
  }
  if (!response.body) unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        unavailable();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    unavailable();
  }
}

export function createTokenBalanceClient(
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
) {
  const fetcher =
    options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 12_000, 30_000));
  let nextId = 0;
  async function rpc(
    network: "ethereum" | "solana",
    method: string,
    params: unknown[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = ++nextId;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetcher(network === "ethereum" ? ETHEREUM_RPC : SOLANA_RPC, {
        method: "POST",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        unavailable();
      }
      const body = record(await boundedJson(response));
      if (
        body.jsonrpc !== "2.0" ||
        body.id !== id ||
        Object.hasOwn(body, "error") ||
        !Object.hasOwn(body, "result")
      )
        unavailable();
      return body.result;
    } catch {
      unavailable();
    }
  }

  async function ethereum(watch: TokenWatch, signal?: AbortSignal): Promise<TokenBalance> {
    const owner = normalizeAddress("ethereum", watch.ownerAddress);
    const token = normalizeAddress("ethereum", watch.tokenAddress);
    const call = (data: string) =>
      rpc("ethereum", "eth_call", [{ to: token, data }, "latest"], signal);
    const [chain, raw, precision] = await Promise.all([
      rpc("ethereum", "eth_chainId", [], signal),
      call(`0x70a08231${owner.slice(2).padStart(64, "0")}`),
      call("0x313ce567"),
    ]);
    if (chain !== "0x1") unsupported("This RPC is not on Ethereum mainnet.");
    const amount = abiUint(raw).toString();
    const decimalValue = abiUint(precision);
    if (decimalValue > 255n)
      unsupported(
        "Token decimals are unavailable or unsupported; no balance can be displayed safely.",
      );
    const places = decimals(Number(decimalValue));
    if (signal?.aborted) unavailable();
    const [symbol, name] = await Promise.all([
      call("0x95d89b41")
        .then((value) => decodeTokenText(value, 32))
        .catch(() => null),
      call("0x06fdde03")
        .then((value) => decodeTokenText(value, 128))
        .catch(() => null),
    ]);
    return {
      status: "ready",
      rawAmount: amount,
      decimals: places,
      amount: formatExactTokenAmount(amount, places),
      symbol,
      name,
      metadataUnavailable: !symbol || !name,
      updatedAt: Date.now(),
    };
  }

  async function solana(watch: TokenWatch, signal?: AbortSignal): Promise<TokenBalance> {
    const [mintResult, accountsResult] = await Promise.all([
      rpc(
        "solana",
        "getAccountInfo",
        [watch.tokenAddress, { encoding: "jsonParsed", commitment: "finalized" }],
        signal,
      ),
      rpc(
        "solana",
        "getTokenAccountsByOwner",
        [
          watch.ownerAddress,
          { mint: watch.tokenAddress },
          { encoding: "jsonParsed", commitment: "finalized" },
        ],
        signal,
      ),
    ]);
    const mint = record(record(mintResult).value);
    const program = mint.owner;
    if (program !== SPL_TOKEN_PROGRAM && program !== SPL_TOKEN_2022_PROGRAM)
      unsupported("This mint is not owned by the SPL Token or Token-2022 program.");
    if (mint.executable !== false) unsupported();
    const mintData = record(mint.data);
    const expectedParser = program === SPL_TOKEN_PROGRAM ? "spl-token" : "spl-token-2022";
    if (mintData.program !== expectedParser)
      unsupported("The RPC cannot parse this token mint safely.");
    const mintParsed = record(mintData.parsed);
    if (mintParsed.type !== "mint") unsupported("This address is not a parsed SPL token mint.");
    const mintInfo = record(mintParsed.info);
    if (mintInfo.isInitialized !== true) unsupported("This SPL mint is not initialized.");
    publicTokenExtensions(mintInfo);
    const places = decimals(mintInfo.decimals);
    integer(mintInfo.supply, MAX_UINT64);
    const accounts = record(accountsResult).value;
    if (!Array.isArray(accounts) || accounts.length > 1000) unsupported();
    let amount = 0n;
    const seen = new Set<string>();
    for (const value of accounts) {
      const row = record(value);
      if (
        typeof row.pubkey !== "string" ||
        !isValidAddress("solana", row.pubkey) ||
        seen.has(row.pubkey)
      )
        unsupported();
      seen.add(row.pubkey);
      const account = record(row.account);
      if (account.owner !== program || account.executable !== false) unsupported();
      const data = record(account.data);
      if (data.program !== expectedParser)
        unsupported("The RPC cannot parse this token account safely.");
      const parsed = record(data.parsed);
      if (parsed.type !== "account") unsupported();
      const info = record(parsed.info);
      publicTokenExtensions(info);
      if (
        info.owner !== watch.ownerAddress ||
        info.mint !== watch.tokenAddress ||
        (info.state !== "initialized" && info.state !== "frozen")
      )
        unsupported(
          "The RPC returned a token account for a different owner, mint, or account state.",
        );
      const tokenAmount = record(info.tokenAmount);
      if (decimals(tokenAmount.decimals) !== places)
        unsupported("The RPC returned inconsistent token decimals.");
      amount += integer(tokenAmount.amount, MAX_UINT64);
      if (amount > MAX_UINT64) unsupported("The RPC returned an impossible SPL token total.");
    }
    return {
      status: "ready",
      rawAmount: amount.toString(),
      decimals: places,
      amount: formatExactTokenAmount(amount.toString(), places),
      symbol: null,
      name: null,
      metadataUnavailable: true,
      accountCount: accounts.length,
      program: program === SPL_TOKEN_PROGRAM ? "SPL Token" : "Token-2022",
      updatedAt: Date.now(),
    };
  }

  async function readTokenBalance(watch: TokenWatch, signal?: AbortSignal): Promise<TokenBalance> {
    try {
      if (
        (watch.chain !== "ethereum" && watch.chain !== "solana") ||
        !isValidAddress(watch.chain, watch.ownerAddress) ||
        !isValidAddress(watch.chain, watch.tokenAddress)
      )
        unsupported("Choose valid public owner and token addresses on Ethereum or Solana.");
      if (signal?.aborted) unavailable();
      const result =
        watch.chain === "ethereum" ? await ethereum(watch, signal) : await solana(watch, signal);
      if (signal?.aborted) unavailable();
      return result;
    } catch (error) {
      return {
        status: error instanceof TokenReadError ? error.status : "unavailable",
        message:
          error instanceof TokenReadError
            ? error.message
            : "The public token balance could not be read. Try refreshing later.",
        updatedAt: Date.now(),
      };
    }
  }
  return { readTokenBalance };
}

export const { readTokenBalance } = createTokenBalanceClient();
