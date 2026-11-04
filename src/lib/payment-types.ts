import { exactContactAmount, contactAmountUnits } from "./creator-contact";
import { isValidAddress } from "./chains";

export type PaymentMethod = "ethereum" | "nowpayments";
export type PaymentState = "pending" | "paid" | "failed" | "expired";
export type PaymentKind = "dm" | "donation";
export type PaymentView = {
  id: string;
  messageId: string;
  kind: PaymentKind;
  method: PaymentMethod;
  status: PaymentState;
  amount: string;
  currency: "ETH" | "USD";
  createdAt: string;
  expiresAt: string;
  confirmations: number;
  transaction?: { chainId: 1; to: string; value: string; data: string };
  checkoutUrl?: string;
  transactionHash?: string;
};
export type PaymentResponse = { payment: PaymentView; capabilityToken?: string };
export type PaymentConfiguration = {
  nowpayments: { configured: boolean; webhookUrl: string | null };
  ethereum: { available: boolean; chainId: 1; minConfirmations: 3 };
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid payment response.");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw new Error("Invalid payment ID.");
  return value;
}
/** Strictly pick public receipt fields; credentials and private message text are never receipts. */
export function validatePaymentResponse(value: unknown): PaymentResponse {
  const envelope = record(value),
    row = record(envelope.payment);
  if (
    !["dm", "donation"].includes(row.kind as string) ||
    !["ethereum", "nowpayments"].includes(row.method as string) ||
    !["pending", "paid", "failed", "expired"].includes(row.status as string)
  )
    throw new Error("Invalid payment state.");
  if (
    typeof row.amount !== "string" ||
    !/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,18})?$/.test(row.amount) ||
    !["ETH", "USD"].includes(row.currency as string)
  )
    throw new Error("Invalid payment amount.");
  const ethereum = row.method === "ethereum";
  if (row.currency !== (ethereum ? "ETH" : "USD"))
    throw new Error("Payment currency does not match the method.");
  const amount = exactContactAmount(row.amount, ethereum ? 18 : 2);
  if (
    typeof row.createdAt !== "string" ||
    typeof row.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    !Number.isFinite(Date.parse(row.expiresAt)) ||
    !Number.isSafeInteger(row.confirmations) ||
    (row.confirmations as number) < 0
  )
    throw new Error("Invalid payment receipt.");
  const payment: PaymentView = {
    id: identifier(row.id),
    messageId: identifier(row.messageId),
    kind: row.kind as PaymentKind,
    method: row.method as PaymentMethod,
    status: row.status as PaymentState,
    amount,
    currency: row.currency as "ETH" | "USD",
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    confirmations: row.confirmations as number,
  };
  if (payment.method === "ethereum") {
    const tx = record(row.transaction);
    if (
      tx.chainId !== 1 ||
      typeof tx.to !== "string" ||
      !isValidAddress("ethereum", tx.to) ||
      /^0x0{40}$/i.test(tx.to) ||
      typeof tx.value !== "string" ||
      tx.value.length > 66 ||
      !/^0x[1-9a-f][0-9a-f]*$/i.test(tx.value) ||
      typeof tx.data !== "string" ||
      !/^0x[0-9a-f]{64}$/i.test(tx.data)
    )
      throw new Error("Invalid Ethereum payment instructions.");
    if (BigInt(tx.value) !== contactAmountUnits(amount, 18))
      throw new Error("The wallet transfer does not match the displayed payment amount.");
    if (payment.status === "paid" && payment.confirmations < 3)
      throw new Error("Ethereum payment confirmation is incomplete.");
    payment.transaction = { chainId: 1, to: tx.to, value: tx.value, data: tx.data };
  } else if (row.checkoutUrl !== undefined) {
    if (typeof row.checkoutUrl !== "string") throw new Error("Invalid checkout URL.");
    const url = new URL(row.checkoutUrl);
    if (
      url.protocol !== "https:" ||
      !["nowpayments.io", "pay.nowpayments.io", "www.nowpayments.io"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error("Invalid checkout URL.");
    payment.checkoutUrl = url.href;
  }
  if (row.transactionHash !== undefined) {
    if (typeof row.transactionHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(row.transactionHash))
      throw new Error("Invalid payment transaction.");
    payment.transactionHash = row.transactionHash;
  }
  if (envelope.capabilityToken !== undefined) {
    if (
      typeof envelope.capabilityToken !== "string" ||
      !/^[0-9a-f]{64}$/.test(envelope.capabilityToken)
    )
      throw new Error("Invalid anonymous payment receipt.");
    return { payment, capabilityToken: envelope.capabilityToken };
  }
  return { payment };
}
export function validatePaymentConfiguration(value: unknown): PaymentConfiguration {
  const row = record(value),
    now = record(row.nowpayments),
    eth = record(row.ethereum);
  if (
    typeof now.configured !== "boolean" ||
    !(now.webhookUrl === null || typeof now.webhookUrl === "string") ||
    typeof eth.available !== "boolean" ||
    eth.chainId !== 1 ||
    eth.minConfirmations !== 3
  )
    throw new Error("Invalid payment configuration.");
  if (now.webhookUrl) {
    const url = new URL(now.webhookUrl as string);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      throw new Error("Invalid payment webhook URL.");
  }
  return {
    nowpayments: { configured: now.configured, webhookUrl: now.webhookUrl as string | null },
    ethereum: { available: eth.available, chainId: 1, minConfirmations: 3 },
  };
}
