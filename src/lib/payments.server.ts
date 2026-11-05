import {
  auth,
  authConfigured,
  authIsProduction,
  authOrigin,
  getAuthEncryptionSecret,
} from "./auth/server";
import { getSql } from "./db";
import { createSqlContactStore } from "./contact-store";
import { createSqlPaymentStore } from "./payment-store";
import { createPaymentHandler } from "./payment-handler";
import { createEthereumPaymentVerifier } from "./ethereum-payment";
import { createNowPaymentsClient } from "./nowpayments";

const origin = authOrigin ?? "http://localhost:8080";
const allowedOrigins = authIsProduction ? [origin] : [origin, "http://127.0.0.1:8080"];
const ethereum = createEthereumPaymentVerifier();
const nowpayments = createNowPaymentsClient();
/** Public configuration flags never contain merchant secrets or account identity. */
export async function getCreatorPaymentAvailability(
  userId: string,
): Promise<{ nowpaymentsConfigured: boolean; ethereumAvailable: boolean }> {
  if (!authConfigured) return { nowpaymentsConfigured: false, ethereumAvailable: false };
  return {
    nowpaymentsConfigured:
      origin.startsWith("https://") &&
      Boolean(await createSqlPaymentStore(await getSql()).credential(userId)),
    ethereumAvailable: true,
  };
}
export async function handlePaymentRequest(request: Request): Promise<Response> {
  if (!authConfigured)
    return Response.json(
      { message: "Account payments are not configured." },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  const sql = await getSql();
  return createPaymentHandler({
    configured: authConfigured,
    allowedOrigins,
    publicOrigin: origin,
    encryptionSecret: getAuthEncryptionSecret(),
    getSession: (headers) => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
    store: createSqlPaymentStore(sql),
    contacts: createSqlContactStore(sql),
    ethereum,
    nowpayments,
  })(request);
}
