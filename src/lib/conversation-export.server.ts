import { auth, authConfigured } from "./auth/server.js";
import { getSql } from "./db.js";
import { createConversationExportHandler } from "./conversation-export.js";
import { createSqlConversationExportStore } from "./conversation-export-store.js";

export const handleConversationExportRequest = createConversationExportHandler({
  configured: authConfigured,
  getSession: (headers) => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
  async readSnapshot(userId, selection) {
    return createSqlConversationExportStore(await getSql()).readSnapshot(userId, selection);
  },
});
