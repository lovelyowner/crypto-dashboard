import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_BASE_URL = "https://api.nowpayments.io/v1";
const MAX_RESPONSE_BYTES = 256 * 1024;
const CHECKOUT_HOSTS = new Set(["nowpayments.io", "www.nowpayments.io", "pay.nowpayments.io"]);

export class NowPaymentsUnavailableError extends Error {
  constructor(message = "NOWPayments checkout is temporarily unavailable. Please retry.") {
    super(message);
    this.name = "NowPaymentsUnavailableError";
  }
}

export interface NowPaymentsInvoiceRequest {
  apiKey: string;
  intentId: string;
  amountUsd: string;
  handle: string;
  callbackUrl: string;
  returnUrl: string;
}
export interface NowPaymentsInvoice {
  invoiceId: string;
  checkoutUrl: string;
}
export type NowPaymentsVerification =
  | { status: "confirmed"; paymentId: string }
  | { status: "pending"; paymentId: string; reason: string }
  | { status: "rejected"; paymentId: string; reason: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid provider response");
  return value as Record<string, unknown>;
}
function providerId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d{0,39}$/.test(value)) return value;
  throw new Error("Invalid provider payment identifier");
}
function usdCents(value: unknown): bigint {
  const source = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof source !== "string" || !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(source))
    throw new Error("Invalid USD amount");
  const [whole, fraction = ""] = source.split(".");
  const cents = BigInt(whole + fraction.padEnd(2, "0"));
  if (cents <= 0n) throw new Error("Invalid USD amount");
  return cents;
}
function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid HTTPS URL");
  return url;
}

function sortedJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 30) throw new Error("IPN payload nesting is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => sortedJsonValue(entry, depth + 1));
  if (value && typeof value === "object") {
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort())
      sorted[key] = sortedJsonValue((value as Record<string, unknown>)[key], depth + 1);
    return sorted;
  }
  throw new Error("IPN payload must contain only JSON values");
}

/** NOWPayments signs recursively key-sorted JSON with HMAC-SHA512. No payload is trusted before this check. */
export function verifyNowPaymentsSignature(
  body: unknown,
  signature: string | null | undefined,
  ipnSecret: string,
): boolean {
  try {
    if (typeof signature !== "string" || !/^[a-fA-F0-9]{128}$/.test(signature) || !ipnSecret)
      return false;
    record(body);
    const canonical = JSON.stringify(sortedJsonValue(body));
    if (Buffer.byteLength(canonical, "utf8") > MAX_RESPONSE_BYTES) return false;
    const expected = createHmac("sha512", ipnSecret).update(canonical, "utf8").digest();
    return timingSafeEqual(expected, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

/** Call only for an authoritative payment ID already bound by a verified IPN.
 * The official SDK does not promise invoice_id in GET responses; when supplied
 * it must match. Order, merchant credential, price and globally unique payment
 * ID remain mandatory bindings. Never substitute purchase_id for invoice_id.
 */
export function verifyNowPaymentsPayment(
  payment: unknown,
  expected: { intentId: string; invoiceId: string; amountUsd: string },
): NowPaymentsVerification {
  let paymentId = "";
  try {
    const row = record(payment);
    paymentId = providerId(row.payment_id);
    providerId(expected.invoiceId);
    if (
      row.order_id !== expected.intentId ||
      (row.invoice_id !== undefined &&
        row.invoice_id !== null &&
        providerId(row.invoice_id) !== providerId(expected.invoiceId)) ||
      typeof row.price_currency !== "string" ||
      row.price_currency.toLowerCase() !== "usd" ||
      usdCents(row.price_amount) !== usdCents(expected.amountUsd)
    ) {
      return { status: "rejected", paymentId, reason: "The payment does not match this checkout." };
    }
    if (row.payment_status === "finished") return { status: "confirmed", paymentId };
    if (
      ["waiting", "confirming", "confirmed", "sending", "partially_paid"].includes(
        String(row.payment_status),
      )
    )
      return {
        status: "pending",
        paymentId,
        reason: "The provider has not finished this payment.",
      };
    return {
      status: "rejected",
      paymentId,
      reason: "This payment has failed, expired, or been reversed.",
    };
  } catch {
    return { status: "rejected", paymentId, reason: "The payment response could not be verified." };
  }
}

export function createNowPaymentsClient(
  options: { fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number } = {},
) {
  const request = options.fetch ?? fetch;
  const base = httpsUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  if (base.search || base.hash) throw new Error("Invalid NOWPayments API configuration");
  const baseUrl = base.href.replace(/\/$/, "");
  async function api(
    path: string,
    apiKey: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!/^[!-~]{10,256}$/.test(apiKey))
      throw new NowPaymentsUnavailableError("The merchant API key is not configured.");
    try {
      const response = await request(`${baseUrl}${path}`, {
        method: body ? "POST" : "GET",
        headers: { "x-api-key": apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
      });
      if (!response.ok || !response.body) throw new Error("Provider unavailable");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            void reader.cancel().catch(() => undefined);
            throw new Error("Provider response too large");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch {
      throw new NowPaymentsUnavailableError();
    }
  }
  return {
    async createInvoice(input: NowPaymentsInvoiceRequest): Promise<NowPaymentsInvoice> {
      try {
        const cents = usdCents(input.amountUsd);
        if (
          !/^[A-Za-z0-9_-]{1,80}$/.test(input.intentId) ||
          !/^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/.test(input.handle)
        )
          throw new Error("Invalid checkout order");
        const callback = httpsUrl(input.callbackUrl);
        const destination = httpsUrl(input.returnUrl);
        if (callback.hash || destination.hash || callback.origin !== destination.origin)
          throw new Error("Invalid callback URL");
        // Official SDK invoice interface uses a JSON number. Cents remain exact in our own order record.
        const result = await api("/invoice", input.apiKey, {
          price_amount: Number(cents) / 100,
          price_currency: "usd",
          order_id: input.intentId,
          order_description: `Message for @${input.handle}`,
          ipn_callback_url: callback.href,
          success_url: destination.href,
          cancel_url: destination.href,
        });
        const invoiceId = providerId(result.id);
        if (
          (result.order_id !== undefined && result.order_id !== input.intentId) ||
          (result.price_amount !== undefined && usdCents(result.price_amount) !== cents) ||
          (result.price_currency !== undefined && result.price_currency !== "usd")
        )
          throw new Error("Unexpected checkout order");
        if (typeof result.invoice_url !== "string") throw new Error("Invalid checkout URL");
        const checkout = httpsUrl(result.invoice_url);
        if (
          !CHECKOUT_HOSTS.has(checkout.hostname) ||
          checkout.port ||
          checkout.hash ||
          [...checkout.searchParams.keys()].some((key) =>
            ["api_key", "apikey", "secret", "ipn_secret", "password", "access_token"].includes(
              key.toLowerCase(),
            ),
          )
        )
          throw new Error("Unexpected checkout host");
        if (checkout.searchParams.has("iid") && checkout.searchParams.get("iid") !== invoiceId)
          throw new Error("Unexpected checkout invoice");
        return { invoiceId, checkoutUrl: checkout.href };
      } catch (error) {
        if (error instanceof NowPaymentsUnavailableError) throw error;
        throw new NowPaymentsUnavailableError(
          "The checkout response could not be verified. Please retry.",
        );
      }
    },
    async getPayment(apiKey: string, paymentId: string): Promise<Record<string, unknown>> {
      const id = providerId(paymentId);
      const row = await api(`/payment/${id}`, apiKey);
      if (providerId(row.payment_id) !== id)
        throw new NowPaymentsUnavailableError("The payment response could not be verified.");
      return row;
    },
  };
}
