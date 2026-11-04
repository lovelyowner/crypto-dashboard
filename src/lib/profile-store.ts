import type { CreatorProfile } from "./creator-profile";
import type { Sql } from "./db";
import type { ProfileStore, StoredCreatorProfile } from "./profile-handler";

/** SQL runs only on the server, through a connection held by this application. */
export function createSqlProfileStore(sql: Pick<Sql, "query">): ProfileStore {
  return {
    async read(userId) {
      const rows = await sql.query<StoredCreatorProfile>(
        'select profile, updated_at as "updatedAt" from creator_profiles where user_id = $1',
        [userId],
      );
      return rows[0] ?? null;
    },
    async write(userId: string, profile: CreatorProfile) {
      const rows = await sql.query<StoredCreatorProfile>(
        `insert into creator_profiles (user_id, profile)
         values ($1, $2::jsonb)
         on conflict (user_id) do update set profile = excluded.profile, updated_at = now()
         returning profile, updated_at as "updatedAt"`,
        [userId, JSON.stringify(profile)],
      );
      if (!rows[0]) throw new Error("Profile could not be stored");
      return rows[0];
    },
  };
}
