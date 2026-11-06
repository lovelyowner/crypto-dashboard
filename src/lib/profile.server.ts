import { auth, authConfigured, authIsProduction, authOrigin } from "./auth/server.js";
import { getSql } from "./db.js";
import { createProfileHandler } from "./profile-handler.js";
import { createSqlProfileStore } from "./profile-store.js";

const configuredUrl = authOrigin;
const allowedOrigins = configuredUrl
  ? [configuredUrl]
  : authIsProduction
    ? []
    : ["http://localhost:8080", "http://127.0.0.1:8080"];

/** Authenticated private draft endpoint; publication remains an explicit UI action. */
export const handleProfileRequest = createProfileHandler({
  configured: authConfigured,
  allowedOrigins,
  getSession: (headers) => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
  store: {
    async read(userId) {
      return createSqlProfileStore(await getSql()).read(userId);
    },
    async write(userId, profile) {
      return createSqlProfileStore(await getSql()).write(userId, profile);
    },
  },
});
