import { isValidAddress, normalizeAddress } from "./chains";

const DEFAULT_RPC_URL = "https://ethereum-rpc.publicnode.com";
const MAX_RPC_BYTES = 1024 * 1024;
const MAX_UINT256 = (1n << 256n) - 1n;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

export interface EthereumPaymentIntent {
  recipientAddress: string;
  amountWei: string;
  /** Random intent commitment only; never the private message text. */
  nonceData: string;
  /** Payments mined before this quoted deadline may still confirm afterward. */
  expiresAt?: string;
}
export type EthereumVerification =
  | {
      status: "confirmed";
      transactionHash: string;
      confirmations: number;
      amountWei: string;
      fromAddress: string;
      blockNumber: number;
      blockHash: string;
    }
  | { status: "pending"; confirmations: number; reason: string }
  | { status: "rejected"; reason: string };

export class EthereumPaymentUnavailableError extends Error {
  constructor() {
    super("Ethereum payment verification is unavailable. Please try again later.");
    this.name = "EthereumPaymentUnavailableError";
  }
}
export class EthereumPaymentRecipientError extends Error {
  constructor(message = "Choose a regular Ethereum receiving address for direct payments.") {
    super(message);
    this.name = "EthereumPaymentRecipientError";
  }
}

export interface EthereumPaymentVerifierOptions {
  fetch?: typeof fetch;
  rpcUrl?: string;
  timeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new EthereumPaymentUnavailableError();
  return value as Record<string, unknown>;
}
function quantity(value: unknown, maximum = MAX_UINT256): bigint {
  if (typeof value !== "string" || value.length > 66 || !QUANTITY.test(value))
    throw new EthereumPaymentUnavailableError();
  const number = BigInt(value);
  if (number > maximum) throw new EthereumPaymentUnavailableError();
  return number;
}
function blockNumber(value: unknown): number {
  return Number(quantity(value, BigInt(Number.MAX_SAFE_INTEGER)));
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new EthereumPaymentUnavailableError();
  return value.toLowerCase();
}
function address(value: unknown): string {
  if (typeof value !== "string" || !ADDRESS.test(value))
    throw new EthereumPaymentUnavailableError();
  return value.toLowerCase();
}
function recipientAddress(value: string): string {
  if (!isValidAddress("ethereum", value)) throw new EthereumPaymentRecipientError();
  const normalized = normalizeAddress("ethereum", value);
  if (normalized === ZERO_ADDRESS) throw new EthereumPaymentRecipientError();
  return normalized;
}
function rpcUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("Invalid RPC URL");
    return url.href;
  } catch {
    // A provider URL may contain a key. Never include it in an error or log.
    throw new EthereumPaymentUnavailableError();
  }
}
async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RPC_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    throw new EthereumPaymentUnavailableError();
  }
  if (!response.body) throw new EthereumPaymentUnavailableError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RPC_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new EthereumPaymentUnavailableError();
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
    throw new EthereumPaymentUnavailableError();
  }
}

/** Read-only JSON-RPC checks. This module never signs or submits a transaction. */
export function createEthereumPaymentVerifier(options: EthereumPaymentVerifierOptions = {}) {
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 5_000, 30_000));
  let nextId = 0;
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const url = rpcUrl(
      options.rpcUrl ?? process.env.ETHEREUM_PAYMENTS_RPC_URL?.trim() ?? DEFAULT_RPC_URL,
    );
    const id = ++nextId;
    try {
      const response = await request(url, {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new EthereumPaymentUnavailableError();
      }
      const body = record(await boundedJson(response));
      if (
        body.jsonrpc !== "2.0" ||
        body.id !== id ||
        Object.hasOwn(body, "error") ||
        !Object.hasOwn(body, "result")
      )
        throw new EthereumPaymentUnavailableError();
      return body.result;
    } catch {
      throw new EthereumPaymentUnavailableError();
    }
  }
  async function checkRecipient(recipient: string): Promise<void> {
    const [chain, code] = await Promise.all([
      rpc("eth_chainId", []),
      rpc("eth_getCode", [recipient, "latest"]),
    ]);
    if (quantity(chain) !== 1n)
      throw new EthereumPaymentRecipientError("Direct payments require Ethereum mainnet.");
    if (code !== "0x")
      throw new EthereumPaymentRecipientError(
        "Direct payments with a payment reference require a regular Ethereum address, not a contract or delegated smart account.",
      );
  }
  async function assertEthereumRecipient(value: string): Promise<void> {
    await checkRecipient(recipientAddress(value));
  }
  async function verifyEthereumPayment(
    intent: EthereumPaymentIntent,
    transactionHash: string,
  ): Promise<EthereumVerification> {
    if (typeof transactionHash !== "string" || !HASH.test(transactionHash))
      return { status: "rejected", reason: "Enter a valid Ethereum transaction hash." };
    let recipient: string;
    let amount: bigint;
    try {
      recipient = recipientAddress(intent.recipientAddress);
      if (!/^[1-9]\d{0,77}$/.test(intent.amountWei)) throw new Error("Invalid amount");
      amount = BigInt(intent.amountWei);
      if (amount > MAX_UINT256 || !HASH.test(intent.nonceData)) throw new Error("Invalid intent");
    } catch {
      return { status: "rejected", reason: "This Ethereum payment request is invalid." };
    }
    const requestedHash = transactionHash.toLowerCase();
    // Recipient safety is checked before a quote is issued. Once funds have
    // been sent, a later EOA delegation must not invalidate a real transfer.
    if (quantity(await rpc("eth_chainId", [])) !== 1n)
      return { status: "rejected", reason: "This provider is not on Ethereum mainnet." };
    const [rawTx, rawReceipt] = await Promise.all([
      rpc("eth_getTransactionByHash", [requestedHash]),
      rpc("eth_getTransactionReceipt", [requestedHash]),
    ]);
    if (rawTx === null || rawReceipt === null)
      return {
        status: "pending",
        confirmations: 0,
        reason: "The payment has not been included in an Ethereum block yet.",
      };
    const tx = record(rawTx);
    const receipt = record(rawReceipt);
    if (hash(tx.hash) !== requestedHash || hash(receipt.transactionHash) !== requestedHash)
      return {
        status: "rejected",
        reason: "The returned transaction does not match this payment.",
      };
    if (tx.chainId !== undefined && quantity(tx.chainId) !== 1n)
      return { status: "rejected", reason: "This transaction is not on Ethereum mainnet." };
    if (address(tx.to) !== recipient || address(receipt.to) !== recipient)
      return { status: "rejected", reason: "This payment was sent to a different recipient." };
    const fromAddress = address(tx.from);
    if (receipt.from !== undefined && address(receipt.from) !== fromAddress)
      return { status: "rejected", reason: "The transaction and receipt sender do not agree." };
    const actualAmount = quantity(tx.value);
    if (actualAmount < amount)
      return { status: "rejected", reason: "This payment is smaller than the requested amount." };
    if (
      typeof tx.input !== "string" ||
      !HASH.test(tx.input) ||
      tx.input.toLowerCase() !== intent.nonceData.toLowerCase()
    )
      return {
        status: "rejected",
        reason: "This transaction does not contain this message's unique payment reference.",
      };
    const status = quantity(receipt.status);
    if (status === 0n) return { status: "rejected", reason: "This Ethereum transaction failed." };
    if (status !== 1n) throw new EthereumPaymentUnavailableError();
    const includedBlock = blockNumber(receipt.blockNumber);
    if (
      blockNumber(tx.blockNumber) !== includedBlock ||
      hash(tx.blockHash) !== hash(receipt.blockHash)
    )
      return {
        status: "pending",
        confirmations: 0,
        reason: "This transaction's block inclusion is updating. Check again shortly.",
      };
    const [rawBlock, rawLatest] = await Promise.all([
      rpc("eth_getBlockByNumber", [receipt.blockNumber, false]),
      rpc("eth_blockNumber", []),
    ]);
    if (rawBlock === null)
      return {
        status: "pending",
        confirmations: 0,
        reason: "Ethereum is updating this payment's block. Try again shortly.",
      };
    const block = record(rawBlock);
    const blockHash = hash(receipt.blockHash);
    if (blockNumber(block.number) !== includedBlock || hash(block.hash) !== blockHash)
      return {
        status: "pending",
        confirmations: 0,
        reason: "Ethereum is reorganizing this payment's block. Check again shortly.",
      };
    if (
      !Array.isArray(block.transactions) ||
      block.transactions.some((value) => !HASH.test(String(value)))
    )
      throw new EthereumPaymentUnavailableError();
    if (!block.transactions.some((value) => String(value).toLowerCase() === requestedHash))
      return {
        status: "pending",
        confirmations: 0,
        reason: "The provider has not confirmed this payment in its canonical block yet.",
      };
    if (intent.expiresAt !== undefined) {
      const deadline = Date.parse(intent.expiresAt);
      if (!Number.isFinite(deadline))
        return { status: "rejected", reason: "The payment deadline is invalid." };
      const minedAt =
        Number(quantity(block.timestamp, BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)))) *
        1000;
      if (minedAt > deadline)
        return { status: "rejected", reason: "This payment was mined after the request expired." };
    }
    const latest = blockNumber(rawLatest);
    if (latest < includedBlock)
      return {
        status: "pending",
        confirmations: 0,
        reason: "The Ethereum provider is still catching up with this payment.",
      };
    const confirmations = latest - includedBlock + 1;
    if (confirmations < 3)
      return {
        status: "pending",
        confirmations,
        reason: "Waiting for at least 3 Ethereum confirmations.",
      };
    return {
      status: "confirmed",
      transactionHash: requestedHash,
      confirmations,
      amountWei: actualAmount.toString(),
      fromAddress,
      blockNumber: includedBlock,
      blockHash,
    };
  }
  return { assertEthereumRecipient, verifyEthereumPayment };
}

const verifier = createEthereumPaymentVerifier();
export const assertEthereumRecipient = verifier.assertEthereumRecipient;
export const verifyEthereumPayment = verifier.verifyEthereumPayment;
