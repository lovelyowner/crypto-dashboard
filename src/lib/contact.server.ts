import { createHmac } from "node:crypto";
import { auth, authConfigured, authIsProduction } from "./auth/server";
import { configuredAuthOrigin } from "./auth/configuration";
import { getSql } from "./db";
import { createContactHandler } from "./contact-handler";
import { createSqlContactStore, type ContactStore } from "./contact-store";

const origin = configuredAuthOrigin(process.env.BETTER_AUTH_URL?.trim(), authIsProduction);
// The proxy delays SQL acquisition until an actual configured request needs it.
const store = new Proxy({} as ContactStore, {
  get(_target, name: keyof ContactStore) {
    return async (...args: unknown[]) => {
      const instance = createSqlContactStore(await getSql());
      const method = instance[name] as (...values: unknown[]) => unknown;
      return method(...args);
    };
  },
});
export const handleContactRequest = createContactHandler({
  configured: authConfigured,
  allowedOrigins: origin
    ? [origin]
    : authIsProduction
      ? []
      : ["http://localhost:8080", "http://127.0.0.1:8080"],
  getSession: (headers) => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
  store,
  getPaymentAvailability: async (userId) => {
    const { getCreatorPaymentAvailability } = await import("./payments.server");
    return getCreatorPaymentAvailability(userId);
  },
  requestKey: async (request) => {
    const ip = (
      request.headers.get("x-vercel-forwarded-for") ??
      request.headers.get("x-forwarded-for") ??
      "unknown"
    )
      .split(",", 1)[0]
      .trim();
    const context = await auth.$context;
    return createHmac("sha256", context.secret).update(ip).digest("hex");
  },
});
