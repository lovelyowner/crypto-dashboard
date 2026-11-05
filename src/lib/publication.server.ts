import { auth, authConfigured, authIsProduction, authOrigin } from "./auth/server";
import { getSql } from "./db";
import { createPublicationHandlers } from "./publication-handler";
import { createSqlPublicationStore } from "./publication-store";

const origin = authOrigin;
const handlers = createPublicationHandlers({
  configured: authConfigured,
  allowedOrigins: origin
    ? [origin]
    : authIsProduction
      ? []
      : ["http://localhost:8080", "http://127.0.0.1:8080"],
  getSession: (headers) => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
  store: {
    async read(userId) {
      return createSqlPublicationStore(await getSql()).read(userId);
    },
    async readPublic(handle) {
      return createSqlPublicationStore(await getSql()).readPublic(handle);
    },
    async publish(userId, handle, profile) {
      return createSqlPublicationStore(await getSql()).publish(userId, handle, profile);
    },
    async unpublish(userId) {
      return createSqlPublicationStore(await getSql()).unpublish(userId);
    },
  },
});

export const { handlePublicationRequest, handlePublicProfileRequest } = handlers;
