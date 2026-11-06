import { auth, authConfigured } from "./auth/server.js";
import { getSql } from "./db.js";
import { createSqlProfileStore } from "./profile-store.js";
import { createSqlPublicationStore } from "./publication-store.js";
import { createAccountExportHandler } from "./account-export.js";

export const handleAccountExportRequest = createAccountExportHandler({
  configured: authConfigured,
  getSession: (headers) => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
  async read(userId) {
    const sql = await getSql();
    const [identities, draft, publication] = await Promise.all([
      sql.query<Record<string, unknown>>(
        'select "providerId", "accountId" from "account" where "userId" = $1 order by "createdAt", "id" limit 51',
        [userId],
      ),
      createSqlProfileStore(sql).read(userId),
      createSqlPublicationStore(sql).read(userId),
    ]);
    return { identities, draft, publication };
  },
});
