import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ContactStore } from "./contact-store.js";
import { contactAmountUnits, exactContactAmount, validateContactText } from "./creator-contact.js";
import { normalizePublicHandle } from "./public-profile.js";
import { getPublicProfilePath } from "./profile-url.js";
import type { ProfileSession } from "./profile-handler.js";
import { isFreshAccountSession } from "./auth/policy.js";
import {
  decryptPaymentCredentials,
  encryptPaymentCredentials,
  validatePaymentCredentials,
} from "./payment-credentials.js";
import {
  verifyNowPaymentsPayment,
  verifyNowPaymentsSignature,
  NowPaymentsUnavailableError,
  type createNowPaymentsClient,
} from "./nowpayments.js";
import {
  EthereumPaymentUnavailableError,
  type createEthereumPaymentVerifier,
} from "./ethereum-payment.js";
import {
  PaymentProofConflictError,
  type PaymentStore,
  type StoredPaymentIntent,
} from "./payment-store.js";
import type { PaymentView, PaymentConfiguration } from "./payment-types.js";
import { isContactBlockedError } from "./moderation.js";

type Session = ProfileSession & {
  user: { id: string; name?: string };
  session: { userId: string; expiresAt: Date | string; createdAt: Date | string };
};
export interface PaymentHandlerDependencies {
  configured: boolean;
  allowedOrigins: string[];
  publicOrigin: string;
  encryptionSecret: string;
  getSession(headers: Headers): Promise<Session | null>;
  store: PaymentStore;
  contacts: ContactStore;
  ethereum: ReturnType<typeof createEthereumPaymentVerifier>;
  nowpayments: ReturnType<typeof createNowPaymentsClient>;
  now?: () => number;
}
class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TX_HASH = /^0x[0-9a-f]{64}$/i;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError(400, "Send a JSON object.");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => ![...required, ...optional].includes(key))
  )
    throw new RequestError(400, "The request contains unsupported fields.");
}
async function json(request: Request, limit = 16 * 1024): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit))
    throw new RequestError(413, "Request is too large.");
  if (!request.body) throw new RequestError(400, "JSON is required.");
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        throw new RequestError(413, "Request is too large.");
      }
      chunks.push(part.value);
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
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestError(400, "Send valid JSON.");
  }
}
function respond(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      Vary: "Cookie, X-Payment-Token, Origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export function paymentView(row: StoredPaymentIntent, now = Date.now()): PaymentView {
  const payment: PaymentView = {
    id: row.id,
    messageId: row.messageId,
    kind: row.kind,
    method: row.method,
    status:
      row.status === "pending" && new Date(row.expiresAt).getTime() <= now ? "expired" : row.status,
    amount: row.amount,
    currency: row.method === "ethereum" ? "ETH" : "USD",
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    confirmations: row.confirmations,
  };
  if (row.method === "ethereum") {
    if (!row.recipientAddress || !row.amountWei || !row.nonceData)
      throw new Error("Missing Ethereum instructions");
    payment.transaction = {
      chainId: 1,
      to: row.recipientAddress,
      value: `0x${BigInt(row.amountWei).toString(16)}`,
      data: row.nonceData,
    };
    if (row.transactionHash) payment.transactionHash = row.transactionHash;
  } else if (row.checkoutUrl) payment.checkoutUrl = row.checkoutUrl;
  return payment;
}
export function createPaymentHandler(dependencies: PaymentHandlerDependencies) {
  const now = dependencies.now ?? Date.now;
  const origins = new Set(dependencies.allowedOrigins.map((value) => new URL(value).origin));
  const origin = new URL(dependencies.publicOrigin).origin;
  const hostedOrigin = origin.startsWith("https://");
  const failure = (error: unknown) => {
    if (isContactBlockedError(error))
      return respond({ message: "Contact is blocked. New payment quotes are unavailable." }, 403);
    if (error instanceof RequestError) return respond({ message: error.message }, error.status);
    if (error instanceof PaymentProofConflictError)
      return respond(
        { message: "This transaction or provider payment has already been used." },
        409,
      );
    if (
      error instanceof EthereumPaymentUnavailableError ||
      error instanceof NowPaymentsUnavailableError
    )
      return respond({ message: error.message }, 503);
    return respond(
      { message: "The payment service could not complete this request. Please retry." },
      503,
    );
  };
  function csrf(request: Request, needsJson = true) {
    if (
      !origins.has(request.headers.get("origin") ?? "") ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      throw new RequestError(403, "Make payment requests from this app.");
    if (
      needsJson &&
      request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
        "application/json"
    )
      throw new RequestError(415, "Use application/json.");
  }
  async function session(headers: Headers, required = false) {
    const value = await dependencies.getSession(headers);
    if (
      !value?.user.id ||
      value.session.userId !== value.user.id ||
      !(new Date(value.session.expiresAt).getTime() > now())
    ) {
      if (required) throw new RequestError(401, "Sign in to continue.");
      return null;
    }
    return value;
  }
  async function limit(request: Request, scope: string, userId?: string, max = 20) {
    const source =
      userId ??
      request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim().slice(0, 64) ??
      "unknown";
    const key = createHmac("sha256", dependencies.encryptionSecret)
      .update(`${scope}:${source}`)
      .digest("hex");
    if (!(await dependencies.store.consumeLimit(key, 60, max)))
      throw new RequestError(429, "Too many payment requests. Please wait a minute.");
  }
  async function ownedIntent(request: Request, id: string) {
    if (!UUID.test(id)) throw new RequestError(404, "Payment receipt not found.");
    const row = await dependencies.store.read(id);
    if (!row) throw new RequestError(404, "Payment receipt not found.");
    if (row.senderId) {
      const account = await session(request.headers, true);
      if (account!.user.id !== row.senderId)
        throw new RequestError(404, "Payment receipt not found.");
    } else {
      const token = request.headers.get("x-payment-token");
      if (!token || !/^[0-9a-f]{64}$/.test(token) || !row.capabilityHash)
        throw new RequestError(404, "Payment receipt not found.");
      const candidate = Buffer.from(digest(token), "hex"),
        expected = Buffer.from(row.capabilityHash, "hex");
      if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected))
        throw new RequestError(404, "Payment receipt not found.");
    }
    return row;
  }
  async function config(userId: string): Promise<PaymentConfiguration> {
    const credential = await dependencies.store.credential(userId);
    return {
      nowpayments: {
        configured: Boolean(credential),
        webhookUrl:
          credential && hostedOrigin
            ? `${origin}/api/payments/nowpayments/webhook/${credential.id}`
            : null,
      },
      ethereum: { available: true, chainId: 1, minConfirmations: 3 },
    };
  }
  async function verify(
    row: StoredPaymentIntent,
    transactionHash?: string,
    force = false,
  ): Promise<StoredPaymentIntent> {
    if (row.status !== "pending") return row;
    if (!force && !(await dependencies.store.acquireVerification(row.id)))
      return (await dependencies.store.read(row.id)) ?? row;
    if (row.method === "ethereum") {
      const hash = transactionHash ?? row.transactionHash;
      if (!hash) return row;
      if (!TX_HASH.test(hash))
        throw new RequestError(400, "Enter a valid Ethereum transaction hash.");
      await dependencies.store.setCandidate(row.id, hash.toLowerCase());
      const result = await dependencies.ethereum.verifyEthereumPayment(
        {
          recipientAddress: row.recipientAddress!,
          amountWei: row.amountWei!,
          nonceData: row.nonceData!,
          expiresAt: new Date(row.expiresAt).toISOString(),
        },
        hash,
      );
      if (result.status === "rejected") {
        const previous =
          row.transactionHash && row.transactionHash.toLowerCase() !== hash.toLowerCase()
            ? row.transactionHash
            : null;
        await dependencies.store.setCandidate(row.id, previous);
        throw new RequestError(422, result.reason);
      }
      await dependencies.store.setConfirmations(row.id, result.confirmations);
      if (result.status === "confirmed")
        await dependencies.store.confirm(
          row.id,
          `ethereum:1:${result.transactionHash.toLowerCase()}`,
          result.confirmations,
        );
    } else if (row.providerPaymentId) {
      const credential = await dependencies.store.credentialById(row.credentialId!);
      if (!credential || credential.userId !== row.recipientId)
        throw new RequestError(503, "The merchant payment connection is unavailable.");
      const keys = decryptPaymentCredentials(
        credential.encrypted,
        dependencies.encryptionSecret,
        credential.userId,
        credential.id,
      );
      const result = verifyNowPaymentsPayment(
        await dependencies.nowpayments.getPayment(keys.apiKey, row.providerPaymentId),
        { intentId: row.id, invoiceId: row.invoiceId!, amountUsd: row.amount },
      );
      if (result.status === "confirmed")
        await dependencies.store.confirm(row.id, `nowpayments:${result.paymentId}`, 0);
      else if (result.status === "rejected") throw new RequestError(422, result.reason);
    }
    return (await dependencies.store.read(row.id)) ?? row;
  }
  async function prepare(request: Request) {
    csrf(request);
    const body = object(await json(request));
    exactKeys(body, ["handle", "kind", "text", "anonymous", "method"], ["amount"]);
    let handle: string, text: string;
    try {
      handle = normalizePublicHandle(body.handle);
      text = validateContactText(body.text);
    } catch (error) {
      throw new RequestError(400, error instanceof Error ? error.message : "Invalid message.");
    }
    if (body.kind !== "dm" && body.kind !== "donation")
      throw new RequestError(400, "Choose a direct message or donation note.");
    if (body.method !== "ethereum" && body.method !== "nowpayments")
      throw new RequestError(400, "Choose Ethereum or NOWPayments.");
    if (typeof body.anonymous !== "boolean" || (body.kind === "dm" && body.anonymous))
      throw new RequestError(400, "Direct messages require an account identity.");
    const account = await session(request.headers, !body.anonymous || body.kind === "dm");
    await limit(request, "create", account?.user.id, 10);
    const recipient = await dependencies.contacts.resolveRecipient(handle);
    if (!recipient) throw new RequestError(404, "Creator profile not found.");
    if (body.kind === "dm" && account?.user.id === recipient.recipientUserId)
      throw new RequestError(400, "You cannot send a paid message to yourself.");
    if (
      account?.user.id &&
      dependencies.contacts.contactAllowed &&
      !(await dependencies.contacts.contactAllowed(account.user.id, recipient.recipientUserId))
    )
      throw new RequestError(403, "Contact is blocked. New payment quotes are unavailable.");
    if (body.kind === "dm" && recipient.settings.dmMode !== "paid")
      throw new RequestError(
        400,
        recipient.settings.dmMode === "free"
          ? "This creator accepts free messages."
          : "This creator is not accepting direct messages.",
      );
    if (body.kind === "donation" && !recipient.settings.donationNotesEnabled)
      throw new RequestError(403, "This creator is not accepting donation notes.");
    const decimals = body.method === "ethereum" ? 18 : 2;
    let amount: string;
    try {
      amount =
        body.kind === "dm"
          ? body.method === "ethereum"
            ? recipient.settings.dmEthPrice
            : recipient.settings.dmUsdPrice
          : exactContactAmount(body.amount, decimals);
      amount = exactContactAmount(amount, decimals);
      const minimum =
        body.method === "ethereum"
          ? recipient.settings.minimumDonationEth
          : recipient.settings.minimumDonationUsd;
      if (
        body.kind === "donation" &&
        contactAmountUnits(amount, decimals) < contactAmountUnits(minimum, decimals)
      )
        throw new Error("The donation amount is below this creator’s minimum.");
    } catch (error) {
      throw new RequestError(
        400,
        error instanceof Error ? error.message : "This payment method has no configured price.",
      );
    }
    const credential =
      body.method === "nowpayments"
        ? await dependencies.store.credential(recipient.recipientUserId)
        : null;
    if (body.method === "nowpayments" && (!credential || !hostedOrigin))
      throw new RequestError(
        503,
        "This creator’s hosted checkout is not configured for a public HTTPS website.",
      );
    if (body.method === "ethereum") {
      if (!recipient.ethereumAddress)
        throw new RequestError(
          400,
          "The creator has not selected a published Ethereum receiving address.",
        );
      await dependencies.ethereum.assertEthereumRecipient(recipient.ethereumAddress);
    }
    const id = randomUUID(),
      messageId = randomUUID(),
      capabilityToken = body.anonymous ? randomBytes(32).toString("hex") : undefined;
    await dependencies.contacts.createPendingMessage({
      id: messageId,
      paymentId: id,
      recipientId: recipient.recipientUserId,
      senderId: body.anonymous ? null : account!.user.id,
      senderName: body.anonymous ? "Anonymous" : account!.user.name || "Account member",
      text,
      kind: body.kind,
      anonymous: body.anonymous,
      moderationActorId: account?.user.id ?? null,
    });
    let row: StoredPaymentIntent;
    try {
      row = await dependencies.store.create({
        id,
        messageId,
        recipientId: recipient.recipientUserId,
        senderId: body.anonymous ? null : account!.user.id,
        capabilityHash: capabilityToken ? digest(capabilityToken) : null,
        kind: body.kind,
        method: body.method,
        amount,
        recipientAddress: body.method === "ethereum" ? recipient.ethereumAddress : null,
        amountWei: body.method === "ethereum" ? contactAmountUnits(amount, 18).toString() : null,
        nonceData: body.method === "ethereum" ? `0x${randomBytes(32).toString("hex")}` : null,
        credentialId: credential?.id ?? null,
        expiresAt: new Date(now() + 24 * 60 * 60 * 1000),
      });
    } catch (error) {
      // A block can commit between the draft and intent writes. No invoice has
      // been requested yet; remove only an orphan draft, never an existing intent.
      await dependencies.contacts.discardPendingMessage?.(messageId, id);
      throw error;
    }
    if (credential) {
      try {
        const keys = decryptPaymentCredentials(
          credential.encrypted,
          dependencies.encryptionSecret,
          credential.userId,
          credential.id,
        );
        const invoice = await dependencies.nowpayments.createInvoice({
          apiKey: keys.apiKey,
          intentId: id,
          amountUsd: amount,
          handle,
          callbackUrl: `${origin}/api/payments/nowpayments/webhook/${credential.id}`,
          returnUrl: `${origin}${getPublicProfilePath(handle)}`,
        });
        await dependencies.store.setInvoice(id, invoice.invoiceId, invoice.checkoutUrl);
        row = (await dependencies.store.read(id))!;
      } catch (error) {
        await dependencies.store.fail(id);
        throw error;
      }
    }
    return respond(
      { payment: paymentView(row, now()), ...(capabilityToken ? { capabilityToken } : {}) },
      201,
    );
  }
  async function credentials(request: Request) {
    if (!["GET", "PUT", "DELETE"].includes(request.method))
      throw new RequestError(405, "Method not allowed.");
    if (request.method !== "GET") csrf(request, request.method === "PUT");
    const account = await session(request.headers, true);
    await limit(request, "credentials", account!.user.id, 20);
    if (request.method !== "GET" && !isFreshAccountSession(account!.session.createdAt, now()))
      throw new RequestError(403, "Sign in again before changing merchant credentials.");
    if (request.method === "PUT") {
      let keys;
      try {
        keys = validatePaymentCredentials(await json(request, 4096));
      } catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError(
          400,
          error instanceof Error ? error.message : "Invalid merchant credentials.",
        );
      }
      const id = randomUUID();
      await dependencies.store.saveCredential({
        id,
        userId: account!.user.id,
        encrypted: encryptPaymentCredentials(
          keys,
          dependencies.encryptionSecret,
          account!.user.id,
          id,
        ),
        active: true,
      });
    } else if (request.method === "DELETE")
      await dependencies.store.disableCredentials(account!.user.id);
    return respond(await config(account!.user.id));
  }
  async function webhook(request: Request, credentialId: string) {
    if (request.method !== "POST") throw new RequestError(405, "Method not allowed.");
    if (!UUID.test(credentialId)) throw new RequestError(404, "Webhook not found.");
    const credential = await dependencies.store.credentialById(credentialId);
    if (!credential) throw new RequestError(404, "Webhook not found.");
    await limit(request, `webhook:${credentialId}`, undefined, 120);
    const body = object(await json(request, 128 * 1024)),
      keys = decryptPaymentCredentials(
        credential.encrypted,
        dependencies.encryptionSecret,
        credential.userId,
        credential.id,
      );
    if (!verifyNowPaymentsSignature(body, request.headers.get("x-nowpayments-sig"), keys.ipnSecret))
      throw new RequestError(403, "Invalid payment notification signature.");
    if (typeof body.order_id !== "string" || !UUID.test(body.order_id))
      throw new RequestError(400, "Invalid payment notification.");
    const row = await dependencies.store.read(body.order_id);
    if (
      !row ||
      row.credentialId !== credentialId ||
      row.recipientId !== credential.userId ||
      row.method !== "nowpayments" ||
      !row.invoiceId
    )
      throw new RequestError(404, "Payment order not found.");
    const notification = verifyNowPaymentsPayment(body, {
      intentId: row.id,
      invoiceId: row.invoiceId,
      amountUsd: row.amount,
    });
    if (notification.status === "rejected" || !notification.paymentId)
      throw new RequestError(422, "The notification does not match this payment order.");
    if (
      !(await dependencies.store.bindProviderPayment(row.id, credentialId, notification.paymentId))
    )
      throw new RequestError(409, "This payment order has a different provider payment.");
    const refreshed = (await dependencies.store.read(row.id))!;
    // The signed notification identifies a candidate only. The merchant-authenticated API is authoritative.
    const updated = await verify(refreshed, undefined, true);
    return respond({ received: true, status: updated.status });
  }
  return async function handlePaymentRequest(request: Request): Promise<Response> {
    if (!dependencies.configured)
      return respond({ message: "Account payments are not configured." }, 503);
    try {
      const path = new URL(request.url).pathname;
      if (path === "/api/profile/payments") return await credentials(request);
      const hook = /^\/api\/payments\/nowpayments\/webhook\/([^/]+)$/.exec(path);
      if (hook) return await webhook(request, hook[1]);
      if (path === "/api/payments") {
        if (request.method !== "POST") throw new RequestError(405, "Method not allowed.");
        return await prepare(request);
      }
      const match = /^\/api\/payments\/([^/]+)(\/verify)?$/.exec(path);
      if (!match) throw new RequestError(404, "Payment route not found.");
      if ((match[2] && request.method !== "POST") || (!match[2] && request.method !== "GET"))
        throw new RequestError(405, "Method not allowed.");
      if (match[2]) csrf(request);
      let row = await ownedIntent(request, match[1]);
      await limit(request, `receipt:${row.id}`, undefined, 60);
      let transactionHash: string | undefined;
      if (match[2]) {
        const body = object(await json(request, 1024));
        exactKeys(body, [], ["transactionHash"]);
        if (body.transactionHash !== undefined) {
          if (typeof body.transactionHash !== "string" || !TX_HASH.test(body.transactionHash))
            throw new RequestError(400, "Enter a valid Ethereum transaction hash.");
          transactionHash = body.transactionHash;
        }
        if (row.method === "ethereum" && !transactionHash && !row.transactionHash)
          throw new RequestError(400, "Enter the transaction hash from your Ethereum payment.");
      }
      if (match[2] || row.transactionHash || row.providerPaymentId)
        row = await verify(row, transactionHash);
      return respond({ payment: paymentView(row, now()) });
    } catch (error) {
      return failure(error);
    }
  };
}
