import type { CreatorProfile } from "./creator-profile.js";
import type { Sql } from "./db.js";
import type { PublicationStore, StoredPublication } from "./publication-handler.js";
import { PublicationConflictError } from "./public-profile.js";

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/** A single SQL statement claims or updates a handle without a check/write race. */
export function createSqlPublicationStore(sql: Pick<Sql, "query">): PublicationStore {
  return {
    async read(userId) {
      const rows = await sql.query<StoredPublication>(
        `select handle, profile, published, updated_at as "updatedAt"
         from public_creator_profiles where user_id = $1`,
        [userId],
      );
      return rows[0] ?? null;
    },
    async readPublic(handle) {
      const rows = await sql.query<StoredPublication>(
        `select handle, profile, published, updated_at as "updatedAt"
         from public_creator_profiles where handle = $1 and published = true`,
        [handle],
      );
      return rows[0] ?? null;
    },
    async publish(userId: string, handle: string, profile: CreatorProfile) {
      try {
        const rows = await sql.query<StoredPublication>(
          `insert into public_creator_profiles (user_id, handle, profile, published)
           values ($1, $2, $3::jsonb, true)
           on conflict (user_id) do update
             set profile = excluded.profile, published = true, updated_at = now()
             where public_creator_profiles.handle = excluded.handle
           returning handle, profile, published, updated_at as "updatedAt"`,
          [userId, handle, JSON.stringify(profile)],
        );
        if (!rows[0])
          throw new PublicationConflictError(
            "This account already owns a different public handle.",
          );
        return rows[0];
      } catch (error) {
        if (isUniqueConflict(error))
          throw new PublicationConflictError("This public handle is already reserved.");
        throw error;
      }
    },
    async unpublish(userId) {
      const rows = await sql.query<StoredPublication>(
        `update public_creator_profiles set published = false, updated_at = now()
         where user_id = $1
         returning handle, profile, published, updated_at as "updatedAt"`,
        [userId],
      );
      return rows[0] ?? null;
    },
  };
}
