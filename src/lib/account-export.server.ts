import { auth, authConfigured } from "./auth/server";
import { getSql } from "./db";
import { createSqlProfileStore } from "./profile-store";
import { createSqlPublicationStore } from "./publication-store";
import { createAccountExportHandler } from "./account-export";

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
